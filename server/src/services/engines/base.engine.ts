export interface ConnectionConfig {
  type: 'MYSQL' | 'POSTGRESQL' | 'MARIADB';
  host: string;
  port: number;
  username: string;
  password?: string;
  database: string;
  sslEnabled?: boolean;
  sslCa?: string;
  sslCert?: string;
  sslKey?: string;
  connectionTimeout?: number;
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  sshPrivateKey?: string;
  sshPassphrase?: string;
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
}
