import { ConnectionConfig } from '../../../services/engines/base.engine';
import { escapeIdentifierMySQL, escapeIdentifierPG } from '../../../services/sync/sync-utils';
import { ConnectionFactory } from '../../../services/engines/connection-factory';

/**
 * Fetch records from a table in pages to avoid loading entire table into memory.
 */
export async function fetchTableRecordsPaginated(
  config: ConnectionConfig,
  tableName: string,
  limit: number,
  offset: number
): Promise<Record<string, unknown>[]> {
  if (config.type === 'MYSQL' || config.type === 'MARIADB') {
    const result = await ConnectionFactory.createMySQLConnection(config);
    try {
      const escapedTable = escapeIdentifierMySQL(tableName);
      const [rows] = await result.connection.query(
        `SELECT * FROM ${escapedTable} LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      return rows as Record<string, unknown>[];
    } finally {
      await ConnectionFactory.closeMySQLConnection(result);
    }
  } else if (config.type === 'POSTGRESQL' || config.type === 'POSTGRES') {
    const result = await ConnectionFactory.createPostgreSQLPool(config);
    try {
      const client = await ConnectionFactory.getPostgreSQLClient(result.pool);
      const escapedTable = escapeIdentifierPG(tableName);
      const pgResult = await client.query(
        `SELECT * FROM ${escapedTable} LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return pgResult.rows;
    } finally {
      await ConnectionFactory.closePostgreSQLPool(result);
    }
  }

  return [];
}
