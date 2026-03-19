import { Connection } from '@prisma/client';
import { ConnectionConfig } from '../engines/base.engine';
import { decrypt, decryptIfPresent } from '../crypto.service';
import { logger } from '../../config/logger';

// ──────────────────────────────────────────────────────
// Re-export shared types used across CDC trackers / worker
// ──────────────────────────────────────────────────────

/** Sync configuration with eagerly-loaded connection relations. */
export type SyncConfigWithConnections = {
  id: string;
  userId: string;
  name: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  direction: string;
  mode: string;
  conflictStrategy: string;
  includeTables: string[];
  excludeTables: string[];
  cronExpression: string | null;
  batchSize: number;
  parallelTables: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  sourceConnection?: Connection;
  targetConnection?: Connection;
};

// ──────────────────────────────────────────────────────
// SQL Identifier Escaping
// ──────────────────────────────────────────────────────

/**
 * Escape a SQL identifier (table or column name) for MySQL/MariaDB.
 * Wraps in backticks and escapes internal backticks.
 */
export function escapeIdentifierMySQL(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

/**
 * Escape a SQL identifier (table or column name) for PostgreSQL.
 * Wraps in double-quotes and escapes internal double-quotes.
 */
export function escapeIdentifierPG(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

// ──────────────────────────────────────────────────────
// Connection Config Helper
// ──────────────────────────────────────────────────────

/**
 * Convert a Prisma `Connection` record to a decrypted `ConnectionConfig`.
 *
 * Replaces the 4 duplicated inline decryption blocks scattered across
 * sync-engine.service.ts and sync.queue.ts.
 */
export function connectionToConfig(connection: Connection): ConnectionConfig {
  return {
    type: connection.type,
    host: decrypt(connection.host),
    port: connection.port,
    username: decrypt(connection.username),
    password: decrypt(connection.password),
    database: decrypt(connection.database),
    sslEnabled: connection.sslEnabled,
    sslCa: decryptIfPresent(connection.sslCa) ?? undefined,
    sslCert: decryptIfPresent(connection.sslCert) ?? undefined,
    sslKey: decryptIfPresent(connection.sslKey) ?? undefined,
    sshEnabled: connection.sshEnabled,
    sshHost: decryptIfPresent(connection.sshHost) ?? undefined,
    sshPort: connection.sshPort ?? undefined,
    sshUsername: decryptIfPresent(connection.sshUsername) ?? undefined,
    sshPrivateKey: decryptIfPresent(connection.sshPrivateKey) ?? undefined,
    sshPassphrase: decryptIfPresent(connection.sshPassphrase) ?? undefined,
    connectionTimeout: connection.connectionTimeout ?? 30000,
  };
}

// ──────────────────────────────────────────────────────
// Primary Key Detection (queries real schema metadata)
// ──────────────────────────────────────────────────────

/**
 * Fetch the actual primary key column names for a table from the database
 * schema metadata. Falls back to using the first column only if schema
 * introspection is completely unavailable.
 */
export async function fetchPrimaryKeyColumnsMySQL(
  connection: any, // mysql2/promise Connection
  database: string,
  tableName: string
): Promise<string[]> {
  try {
    const [rows] = await connection.execute(
      `SELECT COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
       ORDER BY ORDINAL_POSITION`,
      [database, tableName]
    );
    return (rows as any[]).map((r: any) => String(r.COLUMN_NAME));
  } catch (error) {
    logger.warn(`Failed to fetch PK columns for MySQL table ${tableName}:`, error);
    return [];
  }
}

export async function fetchPrimaryKeyColumnsPG(
  client: any, // pg Client
  tableName: string
): Promise<string[]> {
  try {
    const result = await client.query(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary
       ORDER BY a.attnum`,
      [tableName]
    );
    return result.rows.map((r: any) => String(r.column_name));
  } catch (error) {
    logger.warn(`Failed to fetch PK columns for PG table ${tableName}:`, error);
    return [];
  }
}

/**
 * Extract primary key values from a record using known PK column names.
 */
export function extractPrimaryKeyFromColumns(
  record: Record<string, any>,
  pkColumns: string[]
): Record<string, any> {
  const pk: Record<string, any> = {};
  for (const col of pkColumns) {
    pk[col] = record[col];
  }
  return pk;
}
