export interface ConnectionConfig {
  /** Id of the stored connection (used to pin the SSH host key on first connect). */
  connectionId?: string;
  type: 'MYSQL' | 'MARIADB' | 'POSTGRESQL' | 'MONGODB' | 'REDIS';
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
  sshPrivateKeyPath?: string | null;
  sshPassphrase?: string | null;
  /** Pinned SSH host key fingerprint ("SHA256:…"), recorded on first successful connect. */
  sshHostKey?: string | null;
  /** Real DB host for TLS certificate checks, set by SSHTunnel when it rewrites `host` to 127.0.0.1. */
  tlsHost?: string;
  /** Real DB host/port behind the SSH tunnel, recorded before SSHTunnel rewrites host/port. */
  sshTarget?: { host: string; port: number };
}

export interface BackupResult {
  fileName: string;
  filePath: string;
  fileSize: number;
}

export type BackupFormat = 'COMPRESSED_SQL' | 'PLAIN_SQL' | 'CUSTOM' | 'DIRECTORY' | 'TAR';

export interface BackupOptions {
  format?: BackupFormat;
  onProgress?: (progress: number) => void;
}

export interface TestConnectionResult {
  success: boolean;
  version?: string;
  message: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isUnique?: boolean;
  isIndexed?: boolean;
  isForeignKey?: boolean;
  references?: {
    table: string;
    column: string;
    constraintName?: string;
  };
  extra?: string; // e.g. AUTO_INCREMENT, unique, etc.
}

export interface TableIndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface TableUniqueConstraintInfo {
  name: string;
  columns: string[];
}

export interface TableForeignKeyInfo {
  constraintName: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

export interface TableInfo {
  name: string;
  rowCount: number;
  sizeBytes: number;
  logicalSizeBytes: number;
  indexSizeBytes: number;
  extraStorageBytes: number;
  overheadBytes: number;
  overheadPercent: number;
  primaryKeyColumns: string[];
  uniqueConstraints: TableUniqueConstraintInfo[];
  indexes: TableIndexInfo[];
  foreignKeys: TableForeignKeyInfo[];
  columns: ColumnInfo[];
}

export interface DbInfo {
  database: string;
  version: string;
  totalSizeBytes: number;
  logicalSizeBytes: number;
  indexSizeBytes: number;
  extraStorageBytes: number;
  overheadBytes: number;
  overheadPercent: number;
  tableCount: number;
  tables: TableInfo[];
}

export abstract class BaseEngine {
  protected config: ConnectionConfig;

  constructor(config: ConnectionConfig) {
    this.config = config;
  }

  abstract testConnection(): Promise<TestConnectionResult>;
  abstract backup(outputPath: string, options?: BackupOptions): Promise<BackupResult>;
  abstract restore(backupFilePath: string, targetDatabase?: string): Promise<void>;
  abstract listDatabases(): Promise<string[]>;
  abstract getDbInfo(): Promise<DbInfo>;

  /** Lightweight health probe — SELECT 1 with a short timeout. */
  abstract ping(timeoutMs?: number): Promise<{ up: boolean; latencyMs: number; error?: string }>;

  /** Restore-drill helpers (SQL engines). Throw by default. */
  async createDatabase(_name: string): Promise<void> {
    throw new Error('createDatabase not supported by this engine');
  }
  async dropDatabase(_name: string): Promise<void> {
    throw new Error('dropDatabase not supported by this engine');
  }
  async countAllTables(_database: string): Promise<{ tables: number; rows: bigint }> {
    throw new Error('countAllTables not supported by this engine');
  }
}
