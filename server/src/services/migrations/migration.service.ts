import { ConnectionConfig } from '../engines/base.engine';
import { MigrationOptions, MigrationProgressInfo } from './types/migration.types';
import { migrateMySQL2MySQL } from './executors/mysql-executor';
import { migratePG2PG } from './executors/pg-executor';
import { migrateMySQL2PG, migratePG2MySQL } from './executors/cross-migrators';

export { MigrationOptions, MigrationProgressInfo } from './types/migration.types';

export type { TableMeta, ColumnMeta } from './types/migration.types';
export { mapType } from './type-mapping/type-mapper';
export { buildPGCreateTable, buildMySQLCreateTable, escapeValue } from './schema/schema-builder';
export { getMySQLTableMeta } from './executors/mysql-executor';
export { getPGTableMeta } from './executors/pg-executor';
export { migrateMySQL2MySQL } from './executors/mysql-executor';
export { migratePG2PG } from './executors/pg-executor';
export { migrateMySQL2PG, migratePG2MySQL } from './executors/cross-migrators';

/**
 * Run a migration between two databases.
 */
export async function runMigration(
  srcConfig: ConnectionConfig,
  dstConfig: ConnectionConfig,
  opts: MigrationOptions
): Promise<{ rowsMigrated: number }> {
  const srcType = srcConfig.type;
  const dstType = dstConfig.type;

  if ((srcType === 'MYSQL' || srcType === 'MARIADB') && (dstType === 'MYSQL' || dstType === 'MARIADB')) {
    return migrateMySQL2MySQL(srcConfig, dstConfig, opts);
  }

  if (srcType === 'POSTGRESQL' && dstType === 'POSTGRESQL') {
    return migratePG2PG(srcConfig, dstConfig, opts);
  }

  if ((srcType === 'MYSQL' || srcType === 'MARIADB') && dstType === 'POSTGRESQL') {
    return migrateMySQL2PG(srcConfig, dstConfig, opts);
  }

  if (srcType === 'POSTGRESQL' && (dstType === 'MYSQL' || dstType === 'MARIADB')) {
    return migratePG2MySQL(srcConfig, dstConfig, opts);
  }

  throw new Error(`Unsupported migration: ${srcType} to ${dstType}`);
}
