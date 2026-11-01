import { Pool } from 'pg';
import { ConnectionConfig } from '../../engines/base.engine';
import { getEngineHostPort } from '../utils/engine-host';
import { TableMeta, MigrationOptions } from '../types/migration.types';
import { TlsFiles, nodeTlsOptions, pgCliTls } from '../../engines/tls';
import { runPipe } from '../utils/process-pipe';

/**
 * Get table metadata from PostgreSQL database.
 */
export async function getPGTableMeta(pool: Pool, tables: string[]): Promise<TableMeta[]> {
  const result: TableMeta[] = [];
  for (const table of tables) {
    const { rows: pkRows } = await pool.query(
      `SELECT kcu.column_name FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' AND tc.table_name = $1`,
      [table]
    );
    const pkSet = new Set(pkRows.map((r) => r.column_name as string));

    const { rows: colRows } = await pool.query(
      `SELECT column_name, data_type, udt_name, character_maximum_length, numeric_precision, numeric_scale, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    result.push({
      name: table,
      columns: colRows.map((c) => {
        let type = c.data_type as string;
        let length: number | undefined;
        if (type === 'character varying' && c.character_maximum_length) {
          type = `varchar(${c.character_maximum_length})`;
          length = c.character_maximum_length as number;
        } else if (type === 'character' && c.character_maximum_length) {
          type = `char(${c.character_maximum_length})`;
          length = c.character_maximum_length as number;
        } else if (type === 'numeric' || type === 'decimal') {
          const precision = c.numeric_precision as number | null;
          const scale = c.numeric_scale as number | null;
          if (precision !== null) {
            type = scale !== null ? `decimal(${precision},${scale})` : `decimal(${precision})`;
          }
        }
        if (type === 'USER-DEFINED') type = c.udt_name as string;
        return {
          name: c.column_name as string,
          type,
          nullable: c.is_nullable === 'YES',
          isPrimaryKey: pkSet.has(c.column_name as string),
          extra: '',
          length,
        };
      }),
    });
  }
  return result;
}

interface PgSide {
  conn: string[];
  env: NodeJS.ProcessEnv;
  pool: () => Pool;
}

function pgSide(cfg: ConnectionConfig, ref: { host: string; port: number }, files: TlsFiles): PgSide {
  const tls = pgCliTls(cfg, ref.host, files);
  return {
    // Passwords and TLS settings go through the environment, never argv (argv is visible in `ps`)
    conn: ['-h', tls.host, '-p', String(ref.port), '-U', cfg.username, '-d', cfg.database, '--no-password'],
    env: { ...process.env, PGPASSWORD: cfg.password || undefined, ...tls.env },
    pool: () => new Pool({
      host: ref.host, port: ref.port, user: cfg.username, password: cfg.password ?? undefined,
      database: cfg.database, ssl: nodeTlsOptions(cfg), max: 1, connectionTimeoutMillis: 15000,
    }),
  };
}

interface QualifiedTable { schema: string; name: string }

async function listUserTables(side: PgSide): Promise<QualifiedTable[]> {
  const pool = side.pool();
  try {
    const { rows } = await pool.query(
      `SELECT n.nspname AS schema, c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p')
          AND NOT c.relispartition
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp%'`,
    );
    return rows as QualifiedTable[];
  } finally {
    await pool.end();
  }
}

/** Exact-match pattern for pg_dump -t (double quotes disable pattern characters and keep case). */
function tablePattern(t: QualifiedTable): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return `${q(t.schema)}.${q(t.name)}`;
}

/**
 * Migrate PostgreSQL to PostgreSQL using piped pg_dump -> psql.
 *
 * 1. Schema: tables missing on the target are created first. An empty target
 *    gets the full source schema (types, sequences, functions, constraints);
 *    a target that already has some tables gets only the missing ones.
 * 2. Data: a data-only dump of the selected tables (all when none selected).
 *    Existing rows on the target are not removed, so duplicate keys stop the
 *    migration with an error instead of mixing data.
 */
export async function migratePG2PG(
  src: ConnectionConfig,
  dst: ConnectionConfig,
  opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcRef = await getEngineHostPort(src);
  const dstRef = await getEngineHostPort(dst);
  const files = new TlsFiles();

  try {
    const source = pgSide(src, srcRef, files);
    const target = pgSide(dst, dstRef, files);
    const psql = (extra: string[] = []) => ({ cmd: 'psql', args: [...target.conn, '-q', '-v', 'ON_ERROR_STOP=1', ...extra], env: target.env });

    // ── which tables
    const sourceTables = await listUserTables(source);
    const wanted = opts.tables?.length
      ? sourceTables.filter((t) => opts.tables!.includes(t.name) || opts.tables!.includes(`${t.schema}.${t.name}`))
      : sourceTables;
    if (opts.tables?.length && wanted.length === 0) {
      throw new Error(`None of the selected tables exist in the source database: ${opts.tables.join(', ')}`);
    }
    const selectArgs = opts.tables?.length ? wanted.flatMap((t) => ['-t', tablePattern(t)]) : [];

    // ── schema
    const targetTables = await listUserTables(target);
    const existing = new Set(targetTables.map((t) => `${t.schema}.${t.name}`));
    const missing = wanted.filter((t) => !existing.has(`${t.schema}.${t.name}`));

    if (missing.length > 0) {
      opts.onProgress?.({
        currentTable: `Creating ${missing.length} missing table(s) on the target...`,
        tablesCompleted: 0, tableCount: wanted.length, rowsMigrated: 0, progress: 10,
      });
      const schemaDump = ['--schema-only', '--no-owner', '--no-privileges'];
      if (targetTables.length === 0 && !opts.tables?.length) {
        // Empty target: copy the whole schema, including types, functions and sequences
        await runPipe({ cmd: 'pg_dump', args: [...source.conn, ...schemaDump], env: source.env }, psql(), 'Schema copy');
      } else {
        // Partly populated target: create only the missing tables (schemas first; pg_dump -t omits CREATE SCHEMA)
        const schemas = [...new Set(missing.map((t) => t.schema))];
        const pool = target.pool();
        try {
          for (const schema of schemas) await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, '""')}"`);
        } finally {
          await pool.end();
        }
        try {
          await runPipe(
            { cmd: 'pg_dump', args: [...source.conn, ...schemaDump, ...missing.flatMap((t) => ['-t', tablePattern(t)])], env: source.env },
            psql(),
            'Schema copy',
          );
        } catch (err) {
          // pg_dump -t copies tables, their indexes, constraints and triggers, but not the
          // types or functions they use; those must already exist on the target.
          throw new Error(
            `Could not create the missing tables (${missing.map((t) => `${t.schema}.${t.name}`).join(', ')}) on the target: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            'Types, functions and other objects these tables use are only copied when the target database is empty. ' +
            'Migrate into an empty database, or create those objects on the target first.',
          );
        }
      }
    }

    // ── data
    opts.onProgress?.({
      currentTable: 'Copying data (pg_dump pipe)...',
      tablesCompleted: 0, tableCount: wanted.length, rowsMigrated: 0, progress: 30,
    });
    await runPipe(
      { cmd: 'pg_dump', args: [...source.conn, '--data-only', '--no-owner', '--rows-per-insert=1000', ...selectArgs], env: source.env },
      psql(),
      'Data copy',
    );

    opts.onProgress?.({
      currentTable: 'Finished',
      tablesCompleted: wanted.length,
      tableCount: wanted.length,
      rowsMigrated: -1,
      progress: 100,
    });
    return { rowsMigrated: -1 };
  } finally {
    files.cleanup();
    if (srcRef.tunnel) srcRef.tunnel.close();
    if (dstRef.tunnel) dstRef.tunnel.close();
  }
}
