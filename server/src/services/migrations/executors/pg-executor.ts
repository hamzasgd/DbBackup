import { Pool } from 'pg';
import { spawn } from 'child_process';
import { ConnectionConfig } from '../../engines/base.engine';
import { getEngineHostPort } from '../utils/engine-host';
import { TableMeta, MigrationOptions } from '../types/migration.types';

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

/**
 * Migrate PostgreSQL to PostgreSQL using piped pg_dump -> psql.
 */
export async function migratePG2PG(
  src: ConnectionConfig,
  dst: ConnectionConfig,
  opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcRef = await getEngineHostPort(src);
  const dstRef = await getEngineHostPort(dst);

  try {
    return await new Promise((resolve, reject) => {
      // Note: --clean cannot be combined with --data-only (pg_dump rejects it),
      // so this is a pure data copy into an existing target schema.
      const srcArgs = [
        '-h', srcRef.host,
        '-p', String(srcRef.port),
        '-U', src.username,
        '-d', src.database,
        '--no-password',
        '--data-only',
        '--rows-per-insert=1000',
      ];

      const dstArgs = [
        '-h', dstRef.host,
        '-p', String(dstRef.port),
        '-U', dst.username,
        '-d', dst.database,
        '--no-password',
        '-v', 'ON_ERROR_STOP=1',
      ];

      // Passwords go through the environment, never argv (argv is visible in `ps`).
      const srcEnv = { ...process.env, PGPASSWORD: src.password || undefined };
      const dstEnv = { ...process.env, PGPASSWORD: dst.password || undefined };

      opts.onProgress?.({
        currentTable: 'Starting pg_dump pipe...',
        tablesCompleted: 0,
        tableCount: 1,
        rowsMigrated: 0,
        progress: 10,
      });

      const dump = spawn('pg_dump', srcArgs, { env: srcEnv });
      const restore = spawn('psql', dstArgs, { env: dstEnv });

      let dumpError = '';
      let restoreError = '';
      let dumpExitCode: number | null | undefined;
      let restoreExitCode: number | null | undefined;

      dump.stderr.on('data', (d) => {
        dumpError += d.toString();
      });

      restore.stderr.on('data', (d) => {
        restoreError += d.toString();
      });

      // If psql dies early, pg_dump gets EPIPE on stdout; don't crash on it.
      restore.stdin.on('error', () => { /* reported via exit codes below */ });

      dump.stdout.pipe(restore.stdin);

      // Decide only after BOTH processes have exited: psql can exit 0 on a
      // truncated stream, so a failed pg_dump must fail the migration too.
      const finish = () => {
        if (dumpExitCode === undefined || restoreExitCode === undefined) return;
        if (dumpExitCode !== 0) {
          reject(new Error(`pg_dump failed: ${dumpError || `exit code ${dumpExitCode}`}`));
          return;
        }
        if (restoreExitCode === 0) {
          opts.onProgress?.({
            currentTable: 'Finished',
            tablesCompleted: 1,
            tableCount: 1,
            rowsMigrated: -1,
            progress: 100,
          });
          resolve({ rowsMigrated: -1 });
        } else {
          reject(new Error(`PostgreSQL restore failed: ${restoreError || dumpError}`));
        }
      };

      dump.on('close', (code) => { dumpExitCode = code; finish(); });
      restore.on('close', (code) => { restoreExitCode = code; finish(); });

      dump.on('error', reject);
      restore.on('error', reject);
    });
  } finally {
    if (srcRef.tunnel) srcRef.tunnel.close();
    if (dstRef.tunnel) dstRef.tunnel.close();
  }
}
