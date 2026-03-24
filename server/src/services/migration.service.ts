// Re-export from the refactored migrations module
export {
  runMigration,
  MigrationOptions,
  MigrationProgressInfo,
  mapType,
  buildPGCreateTable,
  buildMySQLCreateTable,
  escapeValue,
  getMySQLTableMeta,
  migrateMySQL2MySQL,
  getPGTableMeta,
  migratePG2PG,
  migrateMySQL2PG,
  migratePG2MySQL,
} from './migrations';
