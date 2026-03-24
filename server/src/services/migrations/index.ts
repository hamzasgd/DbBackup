// Re-export everything from the migrations module
export { runMigration } from './migration.service';
export { MigrationOptions, MigrationProgressInfo } from './migration.service';
export type { TableMeta, ColumnMeta } from './migration.service';
export { mapType } from './migration.service';
export { buildPGCreateTable, buildMySQLCreateTable, escapeValue } from './migration.service';
export { getMySQLTableMeta, migrateMySQL2MySQL } from './migration.service';
export { getPGTableMeta, migratePG2PG } from './migration.service';
export { migrateMySQL2PG, migratePG2MySQL } from './migration.service';
