import mysql2 from 'mysql2/promise';
import { Pool, PoolClient } from 'pg';
import { ConnectionConfig } from './engines/base.engine';

export interface MigrationOptions {
  tables?: string[];   // if omitted, migrate all tables
  batchSize?: number;  // rows per INSERT batch (default 500)
  onProgress?: (info: MigrationProgressInfo) => void;
}

export interface MigrationProgressInfo {
  currentTable: string;
  tablesCompleted: number;
  tableCount: number;
  rowsMigrated: number;
  progress: number; // 0-100
}

// ─── Type mapping ─────────────────────────────────────────────────────────────

const MYSQL_TO_PG: Record<string, string> = {
  'tinyint(1)': 'boolean',
  tinyint: 'smallint',
  smallint: 'smallint',
  mediumint: 'integer',
  int: 'integer',
  bigint: 'bigint',
  float: 'real',
  double: 'double precision',
  decimal: 'numeric',
  varchar: 'varchar',
  char: 'char',
  tinytext: 'text',
  text: 'text',
  mediumtext: 'text',
  longtext: 'text',
  tinyblob: 'bytea',
  blob: 'bytea',
  mediumblob: 'bytea',
  longblob: 'bytea',
  date: 'date',
  time: 'time',
  datetime: 'timestamp',
  timestamp: 'timestamp',
  year: 'integer',
  json: 'jsonb',
  enum: 'text',
  set: 'text',
};

const PG_TO_MYSQL: Record<string, string> = {
  boolean: 'tinyint(1)',
  smallint: 'smallint',
  integer: 'int',
  bigint: 'bigint',
  real: 'float',
  'double precision': 'double',
  numeric: 'decimal',
  varchar: 'varchar(255)',
  char: 'char(1)',
  text: 'text',
  bytea: 'blob',
  date: 'date',
  time: 'time',
  timestamp: 'datetime',
  'timestamp without time zone': 'datetime',
  'timestamp with time zone': 'datetime',
  jsonb: 'json',
  json: 'json',
  uuid: 'varchar(36)',
};

function mapType(srcType: string, srcEngine: string, dstEngine: string): string {
  const normalised = srcType.toLowerCase().split('(')[0].trim();
  if (srcEngine !== dstEngine) {
    if (dstEngine === 'POSTGRESQL') return MYSQL_TO_PG[normalised] ?? 'text';
    return PG_TO_MYSQL[normalised] ?? 'text';
  }
  return srcType;
}

// ─── Schema introspection helpers ────────────────────────────────────────────

interface ColMeta { name: string; type: string; nullable: boolean; isPrimaryKey: boolean; extra: string; }
interface TableMeta { name: string; columns: ColMeta[]; }

async function getMySQLTableMeta(conn: mysql2.Connection, database: string, tables: string[]): Promise<TableMeta[]> {
  const result: TableMeta[] = [];
  for (const table of tables) {
    const [pkRows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'`,
      [database, table]
    );
    const pkSet = new Set(pkRows.map((r) => r.COLUMN_NAME as string));

    const [colRows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [database, table]
    );
    result.push({
      name: table,
      columns: colRows.map((c) => ({
        name: c.COLUMN_NAME as string,
        type: c.COLUMN_TYPE as string,
        nullable: c.IS_NULLABLE === 'YES',
        isPrimaryKey: pkSet.has(c.COLUMN_NAME as string),
        extra: (c.EXTRA as string) || '',
      })),
    });
  }
  return result;
}

async function getPGTableMeta(pool: Pool, tables: string[]): Promise<TableMeta[]> {
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
      `SELECT column_name, data_type, udt_name, character_maximum_length, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      [table]
    );
    result.push({
      name: table,
      columns: colRows.map((c) => {
        let type = c.data_type as string;
        if (type === 'character varying' && c.character_maximum_length) type = `varchar(${c.character_maximum_length})`;
        if (type === 'USER-DEFINED') type = c.udt_name as string;
        return { name: c.column_name as string, type, nullable: c.is_nullable === 'YES', isPrimaryKey: pkSet.has(c.column_name as string), extra: '' };
      }),
    });
  }
  return result;
}

// ─── DDL generators ──────────────────────────────────────────────────────────

function buildPGCreateTable(meta: TableMeta, srcEngine: string): string {
  const cols = meta.columns.map((c) => {
    const pgType = mapType(c.type, srcEngine, 'POSTGRESQL');
    // AUTO_INCREMENT → SERIAL
    const isSerial = c.isPrimaryKey && c.extra.toLowerCase().includes('auto_increment');
    const colType = isSerial ? 'serial' : pgType;
    const nullable = c.nullable ? '' : ' NOT NULL';
    return `  "${c.name}" ${colType}${nullable}`;
  });
  const pks = meta.columns.filter((c) => c.isPrimaryKey).map((c) => `"${c.name}"`);
  if (pks.length) cols.push(`  PRIMARY KEY (${pks.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS "${meta.name}" (\n${cols.join(',\n')}\n);`;
}

function buildMySQLCreateTable(meta: TableMeta, srcEngine: string): string {
  const cols = meta.columns.map((c) => {
    const myType = mapType(c.type, srcEngine, 'MYSQL');
    const nullable = c.nullable ? '' : ' NOT NULL';
    const ai = c.isPrimaryKey && c.extra.toLowerCase().includes('auto_increment') ? ' AUTO_INCREMENT' : '';
    return `  \`${c.name}\` ${myType}${nullable}${ai}`;
  });
  const pks = meta.columns.filter((c) => c.isPrimaryKey).map((c) => `\`${c.name}\``);
  if (pks.length) cols.push(`  PRIMARY KEY (${pks.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS \`${meta.name}\` (\n${cols.join(',\n')}\n);`;
}

// ─── Data pump helpers ───────────────────────────────────────────────────────

function escapeValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' || typeof val === 'bigint') return String(val);
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  return `'${String(val).replace(/'/g, "''")}'`;
}

// ─── Main migration functions ─────────────────────────────────────────────────

export async function migrateMySQL2MySQL(
  src: ConnectionConfig, dst: ConnectionConfig, opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcConn = await mysql2.createConnection({ host: src.host, port: src.port, user: src.username, password: src.password, database: src.database, ssl: src.sslEnabled ? { rejectUnauthorized: false } : undefined });
  const dstConn = await mysql2.createConnection({ host: dst.host, port: dst.port, user: dst.username, password: dst.password, database: dst.database, ssl: dst.sslEnabled ? { rejectUnauthorized: false } : undefined });

  let rowsMigrated = 0;
  const batchSize = opts.batchSize ?? 500;
  try {
    let tables = opts.tables;
    if (!tables) {
      const [rows] = await srcConn.query<mysql2.RowDataPacket[]>(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [src.database]);
      tables = rows.map((r) => r.TABLE_NAME as string);
    }

    const metas = await getMySQLTableMeta(srcConn, src.database, tables);
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      const ddl = buildMySQLCreateTable(meta, 'MYSQL');
      await dstConn.query(ddl);

      let offset = 0;
      while (true) {
        const [rows] = await srcConn.query<mysql2.RowDataPacket[]>(`SELECT * FROM \`${meta.name}\` LIMIT ${batchSize} OFFSET ${offset}`);
        if (rows.length === 0) break;
        const cols = meta.columns.map((c) => `\`${c.name}\``).join(', ');
        const values = rows.map((r) => `(${Object.values(r).map(escapeValue).join(', ')})`).join(',\n');
        await dstConn.query(`INSERT IGNORE INTO \`${meta.name}\` (${cols}) VALUES ${values}`);
        rowsMigrated += rows.length;
        offset += batchSize;
        opts.onProgress?.({ currentTable: meta.name, tablesCompleted: i, tableCount: metas.length, rowsMigrated, progress: Math.round(((i + offset / 1e6) / metas.length) * 100) });
        if (rows.length < batchSize) break;
      }
      opts.onProgress?.({ currentTable: meta.name, tablesCompleted: i + 1, tableCount: metas.length, rowsMigrated, progress: Math.round(((i + 1) / metas.length) * 100) });
    }
  } finally {
    await srcConn.end(); await dstConn.end();
  }
  return { rowsMigrated };
}

export async function migrateMySQL2PG(
  src: ConnectionConfig, dst: ConnectionConfig, opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcConn = await mysql2.createConnection({ host: src.host, port: src.port, user: src.username, password: src.password, database: src.database, ssl: src.sslEnabled ? { rejectUnauthorized: false } : undefined });
  const dstPool = new Pool({ host: dst.host, port: dst.port, user: dst.username, password: dst.password, database: dst.database, ssl: dst.sslEnabled ? { rejectUnauthorized: false } : undefined, max: 2 });

  let rowsMigrated = 0;
  const batchSize = opts.batchSize ?? 500;
  try {
    let tables = opts.tables;
    if (!tables) {
      const [rows] = await srcConn.query<mysql2.RowDataPacket[]>(`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [src.database]);
      tables = rows.map((r) => r.TABLE_NAME as string);
    }

    const metas = await getMySQLTableMeta(srcConn, src.database, tables);
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      const ddl = buildPGCreateTable(meta, 'MYSQL');
      await dstPool.query(ddl);

      let offset = 0;
      while (true) {
        const [rows] = await srcConn.query<mysql2.RowDataPacket[]>(`SELECT * FROM \`${meta.name}\` LIMIT ${batchSize} OFFSET ${offset}`);
        if (rows.length === 0) break;
        const cols = meta.columns.map((c) => `"${c.name}"`).join(', ');
        const client: PoolClient = await dstPool.connect();
        try {
          await client.query('BEGIN');
          for (const row of rows) {
            const vals = Object.values(row).map(escapeValue).join(', ');
            await client.query(`INSERT INTO "${meta.name}" (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING`);
          }
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        rowsMigrated += rows.length;
        offset += batchSize;
        opts.onProgress?.({ currentTable: meta.name, tablesCompleted: i, tableCount: metas.length, rowsMigrated, progress: Math.round(((i + offset / 1e6) / metas.length) * 100) });
        if (rows.length < batchSize) break;
      }
      opts.onProgress?.({ currentTable: meta.name, tablesCompleted: i + 1, tableCount: metas.length, rowsMigrated, progress: Math.round(((i + 1) / metas.length) * 100) });
    }
  } finally {
    await srcConn.end(); await dstPool.end();
  }
  return { rowsMigrated };
}

export async function migratePG2PG(
  src: ConnectionConfig, dst: ConnectionConfig, opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcPool = new Pool({ host: src.host, port: src.port, user: src.username, password: src.password, database: src.database, ssl: src.sslEnabled ? { rejectUnauthorized: false } : undefined, max: 2 });
  const dstPool = new Pool({ host: dst.host, port: dst.port, user: dst.username, password: dst.password, database: dst.database, ssl: dst.sslEnabled ? { rejectUnauthorized: false } : undefined, max: 2 });

  let rowsMigrated = 0;
  const batchSize = opts.batchSize ?? 500;
  try {
    let tables = opts.tables;
    if (!tables) {
      const { rows } = await srcPool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
      tables = rows.map((r) => r.table_name as string);
    }

    const metas = await getPGTableMeta(srcPool, tables);
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      const ddl = buildPGCreateTable(meta, 'POSTGRESQL');
      await dstPool.query(ddl);

      let offset = 0;
      while (true) {
        const { rows } = await srcPool.query(`SELECT * FROM "${meta.name}" LIMIT ${batchSize} OFFSET ${offset}`);
        if (rows.length === 0) break;
        const cols = meta.columns.map((c) => `"${c.name}"`).join(', ');
        const client: PoolClient = await dstPool.connect();
        try {
          await client.query('BEGIN');
          for (const row of rows) {
            const vals = Object.values(row).map(escapeValue).join(', ');
            await client.query(`INSERT INTO "${meta.name}" (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING`);
          }
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
        rowsMigrated += rows.length;
        offset += batchSize;
        opts.onProgress?.({ currentTable: meta.name, tablesCompleted: i, tableCount: metas.length, rowsMigrated, progress: Math.round(((i + offset / 1e6) / metas.length) * 100) });
        if (rows.length < batchSize) break;
      }
      opts.onProgress?.({ currentTable: meta.name, tablesCompleted: i + 1, tableCount: metas.length, rowsMigrated, progress: Math.round(((i + 1) / metas.length) * 100) });
    }
  } finally {
    await srcPool.end(); await dstPool.end();
  }
  return { rowsMigrated };
}

export async function migratePG2MySQL(
  src: ConnectionConfig, dst: ConnectionConfig, opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcPool = new Pool({ host: src.host, port: src.port, user: src.username, password: src.password, database: src.database, ssl: src.sslEnabled ? { rejectUnauthorized: false } : undefined, max: 2 });
  const dstConn = await mysql2.createConnection({ host: dst.host, port: dst.port, user: dst.username, password: dst.password, database: dst.database, ssl: dst.sslEnabled ? { rejectUnauthorized: false } : undefined });

  let rowsMigrated = 0;
  const batchSize = opts.batchSize ?? 500;
  try {
    let tables = opts.tables;
    if (!tables) {
      const { rows } = await srcPool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
      tables = rows.map((r) => r.table_name as string);
    }

    const metas = await getPGTableMeta(srcPool, tables);
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      const ddl = buildMySQLCreateTable(meta, 'POSTGRESQL');
      await dstConn.query(ddl);

      let offset = 0;
      while (true) {
        const { rows } = await srcPool.query(`SELECT * FROM "${meta.name}" LIMIT ${batchSize} OFFSET ${offset}`);
        if (rows.length === 0) break;
        const cols = meta.columns.map((c) => `\`${c.name}\``).join(', ');
        const values = rows.map((r) => `(${Object.values(r).map(escapeValue).join(', ')})`).join(',\n');
        await dstConn.query(`INSERT IGNORE INTO \`${meta.name}\` (${cols}) VALUES ${values}`);
        rowsMigrated += rows.length;
        offset += batchSize;
        opts.onProgress?.({ currentTable: meta.name, tablesCompleted: i, tableCount: metas.length, rowsMigrated, progress: Math.round(((i + offset / 1e6) / metas.length) * 100) });
        if (rows.length < batchSize) break;
      }
      opts.onProgress?.({ currentTable: meta.name, tablesCompleted: i + 1, tableCount: metas.length, rowsMigrated, progress: Math.round(((i + 1) / metas.length) * 100) });
    }
  } finally {
    await srcPool.end(); await dstConn.end();
  }
  return { rowsMigrated };
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

export async function runMigration(
  src: ConnectionConfig,
  dst: ConnectionConfig,
  opts: MigrationOptions = {},
): Promise<{ rowsMigrated: number }> {
  const srcType = src.type;
  const dstType = dst.type;

  const isMySQL = (t: string) => t === 'MYSQL' || t === 'MARIADB';
  const isPG    = (t: string) => t === 'POSTGRESQL';

  if (isMySQL(srcType) && isMySQL(dstType)) return migrateMySQL2MySQL(src, dst, opts);
  if (isMySQL(srcType) && isPG(dstType))    return migrateMySQL2PG(src, dst, opts);
  if (isPG(srcType) && isPG(dstType))       return migratePG2PG(src, dst, opts);
  if (isPG(srcType) && isMySQL(dstType))    return migratePG2MySQL(src, dst, opts);

  throw new Error(`Unsupported migration path: ${srcType} → ${dstType}`);
}
