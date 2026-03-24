/**
 * Type definitions for migration operations.
 */

export interface MigrationOptions {
  tables?: string[]; // if omitted, migrate all tables
  batchSize?: number; // rows per INSERT batch (default 500)
  onProgress?: (info: MigrationProgressInfo) => void;
}

export interface MigrationProgressInfo {
  currentTable: string;
  tablesCompleted: number;
  tableCount: number;
  rowsMigrated: number;
  progress: number; // 0-100
}

export interface ColumnMeta {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  extra: string;
  length?: number;
}

export interface TableMeta {
  name: string;
  columns: ColumnMeta[];
}
