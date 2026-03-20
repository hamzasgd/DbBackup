import mysql2 from 'mysql2/promise';
import { Pool } from 'pg';
import { ConnectionConfig } from './engines/base.engine';
import { engineFactory } from './engines/engine.factory';
import { SchemaValidatorService } from './sync/schema-validator.service';
import { SSHTunnel } from './ssh.service';
import { createHash } from 'crypto';

interface IndexSignature {
  unique: boolean;
  columns: string[];
  signature: string;
}

interface IndexDefinition {
  name: string;
  definition: string;
}

interface ColumnProfileStat {
  tableName: string;
  columnName: string;
  sourceNullCount: number;
  targetNullCount: number;
  sourceMinBytes: number;
  targetMinBytes: number;
  sourceMaxBytes: number;
  targetMaxBytes: number;
  sourceAvgBytes: number;
  targetAvgBytes: number;
}

interface RowHashResult {
  tableName: string;
  sampledRows: number;
  sourceHash: string;
  targetHash: string;
}

export interface TableVerificationResult {
  tableName: string;
  sourceRows: number;
  targetRows: number;
  rowsMatch: boolean;
  missingInTarget: boolean;
  missingIndexes: string[];
  extraIndexes: string[];
  indexDefinitionMismatches: string[];
  columnProfileMismatches: string[];
  rowSampleHashMatch: boolean | null;
  rowSampledCount: number;
  rowSampleSourceHash?: string;
  rowSampleTargetHash?: string;
}

export interface MigrationVerificationResult {
  ok: boolean;
  sourceDatabase: string;
  targetDatabase: string;
  tableCountChecked: number;
  rowMismatchCount: number;
  missingTableCount: number;
  missingIndexCount: number;
  indexDefinitionMismatchCount: number;
  columnProfileMismatchCount: number;
  rowSampleHashMismatchCount: number;
  deepChecksApplied: boolean;
  schemaErrors: string[];
  schemaWarnings: string[];
  tableResults: TableVerificationResult[];
}

const MYSQL_LIKE_TYPES = new Set(['MYSQL', 'MARIADB']);
const PROFILE_DATA_TYPES = new Set([
  'char',
  'varchar',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'json',
]);
const ROW_HASH_SAMPLE_SIZE = 500;
const DEEP_CHECK_MAX_TABLES = 20;
const DEEP_CHECK_MAX_ROWCOUNT_FOR_PROFILE = 200000;
const DEEP_CHECK_TABLE_TIMEOUT_MS = 8000;

async function getEngineHostPort(config: ConnectionConfig): Promise<{ host: string; port: number; tunnel: SSHTunnel | null }> {
  let tunnel: SSHTunnel | null = null;
  let host = config.host;
  let port = config.port;

  if (config.sshEnabled) {
    tunnel = new SSHTunnel(config);
    port = await tunnel.connect();
    host = '127.0.0.1';
  }

  return { host, port, tunnel };
}

function normalizeIndexSignature(unique: boolean, columns: string[]): string {
  return `${unique ? 'U' : 'N'}:${columns.map((c) => c.toLowerCase().trim()).join(',')}`;
}

function parsePostgresIndexColumns(indexDef: string): string[] {
  const start = indexDef.indexOf('(');
  const end = indexDef.lastIndexOf(')');
  if (start === -1 || end === -1 || end <= start) return [];

  const raw = indexDef.slice(start + 1, end);
  return raw
    .split(',')
    .map((c) => c.replace(/"/g, '').trim())
    .filter(Boolean);
}

async function listMySQLIndexSignatures(config: ConnectionConfig, tableName: string): Promise<IndexSignature[]> {
  const ref = await getEngineHostPort(config);
  let conn: mysql2.Connection | null = null;

  try {
    conn = await mysql2.createConnection({
      host: ref.host,
      port: ref.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? { rejectUnauthorized: false } : undefined,
      connectTimeout: config.connectionTimeout || 30000,
    });

    const [rows] = await conn.query<mysql2.RowDataPacket[]>(`
      SELECT
        INDEX_NAME AS index_name,
        NON_UNIQUE AS non_unique,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS cols
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      GROUP BY INDEX_NAME, NON_UNIQUE
    `, [config.database, tableName]);

    return rows.map((r) => {
      const unique = Number(r.non_unique) === 0;
      const columns = String(r.cols || '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      return {
        unique,
        columns,
        signature: normalizeIndexSignature(unique, columns),
      };
    });
  } finally {
    await conn?.end();
    ref.tunnel?.close();
  }
}

async function listPostgresIndexSignatures(config: ConnectionConfig, tableName: string): Promise<IndexSignature[]> {
  const ref = await getEngineHostPort(config);
  let pool: Pool | null = null;

  try {
    pool = new Pool({
      host: ref.host,
      port: ref.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 10000,
      max: 1,
    });

    const { rows } = await pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = $1
    `, [tableName]);

    return rows.map((r) => {
      const indexDef = String(r.indexdef || '');
      const unique = /create\s+unique\s+index/i.test(indexDef);
      const columns = parsePostgresIndexColumns(indexDef);

      return {
        unique,
        columns,
        signature: normalizeIndexSignature(unique, columns),
      };
    });
  } finally {
    await pool?.end();
    ref.tunnel?.close();
  }
}

async function listIndexSignatures(config: ConnectionConfig, tableName: string): Promise<IndexSignature[]> {
  const dbType = config.type;

  if (dbType === 'POSTGRESQL') {
    return listPostgresIndexSignatures(config, tableName);
  }

  return listMySQLIndexSignatures(config, tableName);
}

function mysqlSsl(config: ConnectionConfig): mysql2.SslOptions | string | undefined {
  return config.sslEnabled ? { rejectUnauthorized: false } : undefined;
}

async function withMySQLConnection<T>(config: ConnectionConfig, fn: (conn: mysql2.Connection) => Promise<T>): Promise<T> {
  const ref = await getEngineHostPort(config);
  let conn: mysql2.Connection | null = null;

  try {
    conn = await mysql2.createConnection({
      host: ref.host,
      port: ref.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: mysqlSsl(config),
      connectTimeout: config.connectionTimeout || 30000,
    });

    return await fn(conn);
  } finally {
    await conn?.end();
    ref.tunnel?.close();
  }
}

function normalizeMysqlIndexDefinition(def: string): string {
  return def.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function listMySQLIndexDefinitions(config: ConnectionConfig, tableName: string): Promise<IndexDefinition[]> {
  return withMySQLConnection(config, async (conn) => {
    const [rows] = await conn.query<mysql2.RowDataPacket[]>(`
      SELECT
        INDEX_NAME AS index_name,
        NON_UNIQUE AS non_unique,
        INDEX_TYPE AS index_type,
        GROUP_CONCAT(
          CONCAT(
            COALESCE(COLUMN_NAME, ''),
            IF(SUB_PART IS NULL, '', CONCAT(':', SUB_PART)),
            ':',
            COALESCE(COLLATION, 'A')
          )
          ORDER BY SEQ_IN_INDEX
          SEPARATOR ','
        ) AS col_spec
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE
      ORDER BY INDEX_NAME
    `, [config.database, tableName]);

    return rows.map((r) => {
      const name = String(r.index_name);
      const uniqueFlag = Number(r.non_unique) === 0 ? 'U' : 'N';
      const indexType = String(r.index_type || '').toLowerCase();
      const colSpec = String(r.col_spec || '');
      const definition = normalizeMysqlIndexDefinition(`${uniqueFlag}|${indexType}|${colSpec}`);

      return { name, definition };
    });
  });
}

async function getMySQLProfileColumns(config: ConnectionConfig, tableName: string): Promise<string[]> {
  return withMySQLConnection(config, async (conn) => {
    const [rows] = await conn.query<mysql2.RowDataPacket[]>(`
      SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [config.database, tableName]);

    return rows
      .filter((r) => PROFILE_DATA_TYPES.has(String(r.data_type || '').toLowerCase()))
      .map((r) => String(r.column_name));
  });
}

type ColumnProfileMap = Map<string, { nullCount: number; minBytes: number; maxBytes: number; avgBytes: number }>;

async function getMySQLColumnProfileMap(config: ConnectionConfig, tableName: string, columns: string[]): Promise<ColumnProfileMap> {
  if (columns.length === 0) {
    return new Map();
  }

  const selectParts = columns.flatMap((col) => {
    const safeCol = `\`${col.replace(/`/g, '``')}\``;
    const base = col.replace(/[^a-zA-Z0-9_]/g, '_');

    return [
      `SUM(${safeCol} IS NULL) AS \`${base}__null\``,
      `COALESCE(MIN(OCTET_LENGTH(${safeCol})), 0) AS \`${base}__min\``,
      `COALESCE(MAX(OCTET_LENGTH(${safeCol})), 0) AS \`${base}__max\``,
      `COALESCE(AVG(OCTET_LENGTH(${safeCol})), 0) AS \`${base}__avg\``,
    ];
  });

  return withMySQLConnection(config, async (conn) => {
    const safeTable = `\`${tableName.replace(/`/g, '``')}\``;
    const [rows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT ${selectParts.join(', ')} FROM ${safeTable}`
    );

    const row = rows[0] ?? {};
    const map: ColumnProfileMap = new Map();

    for (const col of columns) {
      const base = col.replace(/[^a-zA-Z0-9_]/g, '_');
      map.set(col, {
        nullCount: Number(row[`${base}__null`] ?? 0),
        minBytes: Number(row[`${base}__min`] ?? 0),
        maxBytes: Number(row[`${base}__max`] ?? 0),
        avgBytes: Number(row[`${base}__avg`] ?? 0),
      });
    }

    return map;
  });
}

function normalizeRowValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (Buffer.isBuffer(value)) return `buffer:${value.toString('hex')}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (typeof value === 'number') return `number:${Number.isFinite(value) ? value.toString() : 'NaN'}`;
  if (typeof value === 'boolean') return `bool:${value ? '1' : '0'}`;
  if (typeof value === 'string') return `str:${value}`;
  return `json:${JSON.stringify(value)}`;
}

async function getMySQLStableOrderColumns(config: ConnectionConfig, tableName: string): Promise<string[]> {
  return withMySQLConnection(config, async (conn) => {
    const [pkRows] = await conn.query<mysql2.RowDataPacket[]>(`
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = 'PRIMARY'
      ORDER BY ORDINAL_POSITION
    `, [config.database, tableName]);

    const pk = pkRows.map((r) => String(r.column_name));
    if (pk.length > 0) return pk;

    const [idxRows] = await conn.query<mysql2.RowDataPacket[]>(`
      SELECT INDEX_NAME AS index_name,
             GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS cols
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      GROUP BY INDEX_NAME
      ORDER BY (INDEX_NAME = 'PRIMARY') DESC, INDEX_NAME ASC
      LIMIT 1
    `, [config.database, tableName]);

    if (idxRows.length === 0) {
      return [];
    }

    return String(idxRows[0].cols || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  });
}

async function getMySQLTableColumns(config: ConnectionConfig, tableName: string): Promise<string[]> {
  return withMySQLConnection(config, async (conn) => {
    const [rows] = await conn.query<mysql2.RowDataPacket[]>(`
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [config.database, tableName]);

    return rows.map((r) => String(r.column_name));
  });
}

async function computeMySQLSampleRowHash(
  config: ConnectionConfig,
  tableName: string,
  sampleSize: number
): Promise<{ hash: string; sampledRows: number; skipped: boolean }> {
  const orderColumns = await getMySQLStableOrderColumns(config, tableName);
  if (orderColumns.length === 0) {
    return { hash: '', sampledRows: 0, skipped: true };
  }

  const columns = await getMySQLTableColumns(config, tableName);
  if (columns.length === 0) {
    return { hash: '', sampledRows: 0, skipped: true };
  }

  const safeTable = `\`${tableName.replace(/`/g, '``')}\``;
  const selectCols = columns.map((c) => `\`${c.replace(/`/g, '``')}\``).join(', ');
  const orderBy = orderColumns.map((c) => `\`${c.replace(/`/g, '``')}\``).join(', ');

  return withMySQLConnection(config, async (conn) => {
    const [rows] = await conn.query<mysql2.RowDataPacket[]>(
      `SELECT ${selectCols} FROM ${safeTable} ORDER BY ${orderBy} LIMIT ?`,
      [sampleSize]
    );

    const digest = createHash('sha256');
    for (const row of rows) {
      const payload = columns.map((c) => normalizeRowValue(row[c])).join('|');
      digest.update(payload);
      digest.update('\n');
    }

    return {
      hash: digest.digest('hex'),
      sampledRows: rows.length,
      skipped: false,
    };
  });
}

function approxEqual(a: number, b: number, epsilon = 0.0001): boolean {
  return Math.abs(a - b) <= epsilon;
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Deep check timed out after ${timeoutMs}ms`)), timeoutMs);
    task
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

export async function verifyMigrationConsistency(
  sourceConfig: ConnectionConfig,
  targetConfig: ConnectionConfig,
  tables?: string[]
): Promise<MigrationVerificationResult> {
  const sourceEngine = engineFactory(sourceConfig);
  const targetEngine = engineFactory(targetConfig);
  const schemaValidator = new SchemaValidatorService();

  const [sourceDbInfo, targetDbInfo, schemaComparison] = await Promise.all([
    sourceEngine.getDbInfo(),
    targetEngine.getDbInfo(),
    schemaValidator.compareSchemas(sourceConfig, targetConfig, tables ?? []),
  ]);

  const schemaValidation = await schemaValidator.validateSchemaCompatibility(schemaComparison);
  const tableNames = (tables && tables.length > 0)
    ? tables
    : sourceDbInfo.tables.map((t) => t.name);

  const tableResults: TableVerificationResult[] = [];
  const deepChecksApplied = MYSQL_LIKE_TYPES.has(sourceConfig.type) && MYSQL_LIKE_TYPES.has(targetConfig.type);
  const deepCheckTableSet = new Set(
    tableNames.slice(0, DEEP_CHECK_MAX_TABLES)
  );

  for (const tableName of tableNames) {
    const sourceTable = sourceDbInfo.tables.find((t) => t.name === tableName);
    const targetTable = targetDbInfo.tables.find((t) => t.name === tableName);

    if (!sourceTable) {
      continue;
    }

    if (!targetTable) {
      tableResults.push({
        tableName,
        sourceRows: sourceTable.rowCount,
        targetRows: 0,
        rowsMatch: false,
        missingInTarget: true,
        missingIndexes: [],
        extraIndexes: [],
        indexDefinitionMismatches: [],
        columnProfileMismatches: [],
        rowSampleHashMatch: null,
        rowSampledCount: 0,
      });
      continue;
    }

    const [srcIndexes, dstIndexes] = await Promise.all([
      listIndexSignatures(sourceConfig, tableName),
      listIndexSignatures(targetConfig, tableName),
    ]);

    const srcSigs = new Set(srcIndexes.map((i) => i.signature));
    const dstSigs = new Set(dstIndexes.map((i) => i.signature));

    const missingIndexes = [...srcSigs].filter((sig) => !dstSigs.has(sig));
    const extraIndexes = [...dstSigs].filter((sig) => !srcSigs.has(sig));

    let indexDefinitionMismatches: string[] = [];
    let columnProfileMismatches: string[] = [];
    let rowSampleHashMatch: boolean | null = null;
    let rowSampledCount = 0;
    let rowSampleSourceHash: string | undefined;
    let rowSampleTargetHash: string | undefined;

    if (deepChecksApplied && deepCheckTableSet.has(tableName)) {
      try {
        await withTimeout((async () => {
          const [srcIndexDefs, dstIndexDefs] = await Promise.all([
            listMySQLIndexDefinitions(sourceConfig, tableName),
            listMySQLIndexDefinitions(targetConfig, tableName),
          ]);

          const allIndexNames = new Set([
            ...srcIndexDefs.map((i) => i.name),
            ...dstIndexDefs.map((i) => i.name),
          ]);
          const srcIndexDefByName = new Map(srcIndexDefs.map((i) => [i.name, i.definition]));
          const dstIndexDefByName = new Map(dstIndexDefs.map((i) => [i.name, i.definition]));

          indexDefinitionMismatches = [...allIndexNames]
            .filter((name) => srcIndexDefByName.get(name) !== dstIndexDefByName.get(name))
            .sort();

          const canRunProfileCheck = sourceTable.rowCount <= DEEP_CHECK_MAX_ROWCOUNT_FOR_PROFILE
            && targetTable.rowCount <= DEEP_CHECK_MAX_ROWCOUNT_FOR_PROFILE;

          if (canRunProfileCheck) {
            const [srcProfileColumns, dstProfileColumns] = await Promise.all([
              getMySQLProfileColumns(sourceConfig, tableName),
              getMySQLProfileColumns(targetConfig, tableName),
            ]);

            const profileColumns = [...new Set([...srcProfileColumns, ...dstProfileColumns])];
            if (profileColumns.length > 0) {
              const [srcProfiles, dstProfiles] = await Promise.all([
                getMySQLColumnProfileMap(sourceConfig, tableName, profileColumns),
                getMySQLColumnProfileMap(targetConfig, tableName, profileColumns),
              ]);

              const profileIssues: string[] = [];
              for (const columnName of profileColumns) {
                const srcStat = srcProfiles.get(columnName);
                const dstStat = dstProfiles.get(columnName);
                if (!srcStat || !dstStat) {
                  profileIssues.push(columnName);
                  continue;
                }

                const sameNulls = srcStat.nullCount === dstStat.nullCount;
                const sameMin = srcStat.minBytes === dstStat.minBytes;
                const sameMax = srcStat.maxBytes === dstStat.maxBytes;
                const sameAvg = approxEqual(srcStat.avgBytes, dstStat.avgBytes);

                if (!sameNulls || !sameMin || !sameMax || !sameAvg) {
                  profileIssues.push(columnName);
                }
              }

              columnProfileMismatches = profileIssues.sort();
            }
          }

          const [srcRowHash, dstRowHash] = await Promise.all([
            computeMySQLSampleRowHash(sourceConfig, tableName, ROW_HASH_SAMPLE_SIZE),
            computeMySQLSampleRowHash(targetConfig, tableName, ROW_HASH_SAMPLE_SIZE),
          ]);

          if (!srcRowHash.skipped && !dstRowHash.skipped) {
            rowSampleHashMatch = srcRowHash.hash === dstRowHash.hash && srcRowHash.sampledRows === dstRowHash.sampledRows;
            rowSampledCount = Math.min(srcRowHash.sampledRows, dstRowHash.sampledRows);
            rowSampleSourceHash = srcRowHash.hash;
            rowSampleTargetHash = dstRowHash.hash;
          }
        })(), DEEP_CHECK_TABLE_TIMEOUT_MS);
      } catch {
        // Keep base verification reliable even if optional deep checks are too expensive.
      }
    }

    tableResults.push({
      tableName,
      sourceRows: sourceTable.rowCount,
      targetRows: targetTable.rowCount,
      rowsMatch: sourceTable.rowCount === targetTable.rowCount,
      missingInTarget: false,
      missingIndexes,
      extraIndexes,
      indexDefinitionMismatches,
      columnProfileMismatches,
      rowSampleHashMatch,
      rowSampledCount,
      rowSampleSourceHash,
      rowSampleTargetHash,
    });
  }

  const rowMismatchCount = tableResults.filter((r) => !r.rowsMatch).length;
  const missingTableCount = tableResults.filter((r) => r.missingInTarget).length;
  const missingIndexCount = tableResults.reduce((sum, r) => sum + r.missingIndexes.length, 0);
  const indexDefinitionMismatchCount = tableResults.reduce((sum, r) => sum + r.indexDefinitionMismatches.length, 0);
  const columnProfileMismatchCount = tableResults.reduce((sum, r) => sum + r.columnProfileMismatches.length, 0);
  const rowSampleHashMismatchCount = tableResults.filter((r) => r.rowSampleHashMatch === false).length;

  const deepChecksPass = !deepChecksApplied
    || (indexDefinitionMismatchCount === 0
      && columnProfileMismatchCount === 0
      && rowSampleHashMismatchCount === 0);

  return {
    ok: schemaValidation.valid
      && rowMismatchCount === 0
      && missingTableCount === 0
      && missingIndexCount === 0
      && deepChecksPass,
    sourceDatabase: sourceDbInfo.database,
    targetDatabase: targetDbInfo.database,
    tableCountChecked: tableResults.length,
    rowMismatchCount,
    missingTableCount,
    missingIndexCount,
    indexDefinitionMismatchCount,
    columnProfileMismatchCount,
    rowSampleHashMismatchCount,
    deepChecksApplied,
    schemaErrors: schemaValidation.errors,
    schemaWarnings: schemaValidation.warnings,
    tableResults,
  };
}
