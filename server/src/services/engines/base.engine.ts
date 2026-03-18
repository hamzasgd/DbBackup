export interface ConnectionConfig {
  type: 'MYSQL' | 'POSTGRES' | 'MARIADB';
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
  extra?: string; // e.g. AUTO_INCREMENT, unique, etc.
}

export interface TableInfo {
  name: string;
  rowCount: number;
  sizeBytes: number;
  columns: ColumnInfo[];
}

export interface DbInfo {
  database: string;
  version: string;
  totalSizeBytes: number;
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
