/**
 * Type Definitions for DbBackup Application
 * Provides type safety for common data structures used across sync and CDC operations
 */

/** Primary key as column name -> value mapping */
export type PrimaryKeyValues = Record<string, string | number | bigint | null>;

/** Row data as column name -> value mapping */
export type RowData = Record<string, unknown>;

/** JSON-serializable value */
export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | { [key: string]: JsonValue };

/** Change operation types */
export type ChangeOperationType = 'INSERT' | 'UPDATE' | 'DELETE';

/** Base change log entry */
export interface ChangeLogEntry {
    id: string;
    syncConfigId: string;
    tableName: string;
    operation: ChangeOperationType;
    primaryKeyValues: PrimaryKeyValues;
    changeData: RowData;
    timestamp: Date;
    checkpoint: string;
    origin: 'source' | 'target';
    synchronized: boolean;
    synchronizedAt: Date | null;
}

/** Conflict data structure */
export interface ConflictData {
    tableName: string;
    primaryKeyValues: PrimaryKeyValues;
    sourceData: RowData;
    targetData: RowData;
    sourceTimestamp: Date;
    targetTimestamp: Date;
}

/** Resolution result */
export interface ResolutionResult {
    resolution: 'source' | 'target' | 'manual';
    resolvedData: RowData | null;
}

/** Database connection type */
export type DatabaseType = 'MYSQL' | 'MARIADB' | 'POSTGRESQL';

/**
 * Connection configuration for database engines
 * Used across sync, CDC, and migration operations
 */
export interface ConnectionConfig {
    type: DatabaseType;
    host: string;
    port: number;
    username: string;
    password?: string | null;
    database: string;
    sslEnabled?: boolean;
    sslCa?: string | null;
    sslCert?: string | null;
    sslKey?: string | null;
    connectionTimeout?: number | null;
    sshEnabled?: boolean;
    sshHost?: string | null;
    sshPort?: number | null;
    sshUsername?: string | null;
    sshPrivateKey?: string | null;
    sshPassphrase?: string | null;
}

/** Decrypted connection configuration ready for database connections */
export interface DecryptedConnectionConfig {
    type: 'MYSQL' | 'MARIADB' | 'POSTGRESQL' | 'POSTGRES'; // POSTGRES for backward compatibility
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    sslEnabled: boolean;
    sslCa?: string;
    sslCert?: string;
    sslKey?: string;
    sshEnabled: boolean;
    sshHost?: string;
    sshPort?: number;
    sshUsername?: string;
    sshPrivateKey?: string;
    sshPassphrase?: string;
    connectionTimeout: number;
    /** Internal: local port when SSH tunnel is active */
    _localPort?: number;
}
