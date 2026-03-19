import mysql2 from 'mysql2/promise';
import { Pool } from 'pg';
import { ConnectionConfig } from './engines/base.engine';
import { engineFactory } from './engines/engine.factory';
import { SchemaValidatorService } from './sync/schema-validator.service';
import { SSHTunnel } from './ssh.service';

interface IndexSignature {
  unique: boolean;
  columns: string[];
  signature: string;
}

export interface TableVerificationResult {
  tableName: string;
  sourceRows: number;
  targetRows: number;
  rowsMatch: boolean;
  missingInTarget: boolean;
  missingIndexes: string[];
  extraIndexes: string[];
}

export interface MigrationVerificationResult {
  ok: boolean;
  sourceDatabase: string;
  targetDatabase: string;
  tableCountChecked: number;
  rowMismatchCount: number;
  missingTableCount: number;
  missingIndexCount: number;
  schemaErrors: string[];
  schemaWarnings: string[];
  tableResults: TableVerificationResult[];
}

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

    tableResults.push({
      tableName,
      sourceRows: sourceTable.rowCount,
      targetRows: targetTable.rowCount,
      rowsMatch: sourceTable.rowCount === targetTable.rowCount,
      missingInTarget: false,
      missingIndexes,
      extraIndexes,
    });
  }

  const rowMismatchCount = tableResults.filter((r) => !r.rowsMatch).length;
  const missingTableCount = tableResults.filter((r) => r.missingInTarget).length;
  const missingIndexCount = tableResults.reduce((sum, r) => sum + r.missingIndexes.length, 0);

  return {
    ok: schemaValidation.valid && rowMismatchCount === 0 && missingTableCount === 0 && missingIndexCount === 0,
    sourceDatabase: sourceDbInfo.database,
    targetDatabase: targetDbInfo.database,
    tableCountChecked: tableResults.length,
    rowMismatchCount,
    missingTableCount,
    missingIndexCount,
    schemaErrors: schemaValidation.errors,
    schemaWarnings: schemaValidation.warnings,
    tableResults,
  };
}
