import { ChangeOperation } from '@prisma/client';
import { ConnectionConfig } from '../../../services/engines/base.engine';
import { escapeIdentifierMySQL, escapeIdentifierPG } from '../../../services/sync/sync-utils';
import { ConnectionFactory } from '../../../services/engines/connection-factory';
import { sanitizeData, getMySqlJsonColumns } from '../sanitation/data-sanitizer';
import type { PrimaryKeyValues, RowData } from '../../../services/sync/types';

/**
 * A change to be applied to the target database.
 */
export interface ChangeToApply {
  operation: ChangeOperation;
  primaryKeyValues: PrimaryKeyValues;
  changeData: RowData;
}

/**
 * Apply a batch of changes to the target database.
 *
 * Handles INSERT, UPDATE, and DELETE operations with proper error handling,
 * transaction support, and SQL identifier escaping.
 */
export async function applyChangeBatch(
  config: ConnectionConfig,
  tableName: string,
  changes: ChangeToApply[]
): Promise<void> {
  if (config.type === 'MYSQL' || config.type === 'MARIADB') {
    const result = await ConnectionFactory.createMySQLConnection(config);
    try {
      const jsonColumns = await getMySqlJsonColumns(result.connection, config.database, tableName);
      const escapedTable = escapeIdentifierMySQL(tableName);
      await result.connection.beginTransaction();

      for (const change of changes) {
        const pkValues = change.primaryKeyValues;
        const data = sanitizeData(change.changeData as RowData, {
          jsonColumns,
          tableName,
        }) as RowData;

        if (change.operation === ChangeOperation.INSERT) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const escapedColumns = columns.map((c) => escapeIdentifierMySQL(c));
          const placeholders = columns.map(() => '?').join(', ');
          const pkColumns = Object.keys(pkValues);
          const nonPkColumns = columns.filter((col) => !pkColumns.includes(col));

          if (pkColumns.length > 0 && nonPkColumns.length > 0) {
            const updateClause = nonPkColumns.map((col) => `${escapeIdentifierMySQL(col)} = ?`).join(', ');
            const whereClause = pkColumns.map((col) => `${escapeIdentifierMySQL(col)} = ?`).join(' AND ');
            const updateSql = `UPDATE ${escapedTable} SET ${updateClause} WHERE ${whereClause}`;
            const [updateResult] = await result.connection.execute(updateSql, [
              ...nonPkColumns.map((col) => data[col]),
              ...pkColumns.map((col) => pkValues[col]),
            ] as any);

            const affectedRows = (updateResult as { affectedRows?: number })?.affectedRows ?? 0;
            if (affectedRows === 0) {
              const insertSql = `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`;
              await result.connection.execute(insertSql, values as any);
            }
          } else {
            const insertSql = `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`;
            await result.connection.execute(insertSql, values as any);
          }
        } else if (change.operation === ChangeOperation.UPDATE) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const setClause = columns.map((col) => `${escapeIdentifierMySQL(col)} = ?`).join(', ');
          const whereClause = Object.keys(pkValues).map((col) => `${escapeIdentifierMySQL(col)} = ?`).join(' AND ');
          const sql = `UPDATE ${escapedTable} SET ${setClause} WHERE ${whereClause}`;
          await result.connection.execute(sql, [...values, ...Object.values(pkValues)] as any);
        } else if (change.operation === ChangeOperation.DELETE) {
          const whereClause = Object.keys(pkValues).map((col) => `${escapeIdentifierMySQL(col)} = ?`).join(' AND ');
          const sql = `DELETE FROM ${escapedTable} WHERE ${whereClause}`;
          await result.connection.execute(sql, Object.values(pkValues) as any);
        }
      }

      await result.connection.commit();
    } catch (error) {
      await result.connection.rollback();
      throw error;
    } finally {
      await ConnectionFactory.closeMySQLConnection(result);
    }
  } else if (config.type === 'POSTGRESQL' || config.type === 'POSTGRES') {
    const result = await ConnectionFactory.createPostgreSQLPool(config);
    let client: Awaited<ReturnType<typeof ConnectionFactory.getPostgreSQLClient>> | null = null;
    try {
      client = await ConnectionFactory.getPostgreSQLClient(result.pool);
      await client.query('BEGIN');

      const escapedTable = escapeIdentifierPG(tableName);

      for (const change of changes) {
        const pkValues = change.primaryKeyValues;
        const data = sanitizeData(change.changeData as RowData) as RowData;

        if (change.operation === ChangeOperation.INSERT) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const escapedColumns = columns.map((c) => escapeIdentifierPG(c));
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const pkColumns = Object.keys(pkValues);
          const hasAllPkColumns = pkColumns.length > 0 && pkColumns.every((col) => columns.includes(col));
          const nonPkColumns = columns.filter((col) => !pkColumns.includes(col));

          if (hasAllPkColumns && nonPkColumns.length > 0) {
            const setClause = nonPkColumns
              .map((col, i) => `${escapeIdentifierPG(col)} = $${i + 1}`)
              .join(', ');
            const whereClause = pkColumns
              .map((col, i) => `${escapeIdentifierPG(col)} = $${nonPkColumns.length + i + 1}`)
              .join(' AND ');
            const updateSql = `UPDATE ${escapedTable} SET ${setClause} WHERE ${whereClause}`;
            const updateResult = await client.query(updateSql, [
              ...nonPkColumns.map((col) => data[col]),
              ...pkColumns.map((col) => pkValues[col]),
            ]);

            if (updateResult.rowCount === 0) {
              const insertSql = `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`;
              await client.query(insertSql, values);
            }
          } else {
            const insertSql = `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`;
            await client.query(insertSql, values);
          }
        } else if (change.operation === ChangeOperation.UPDATE) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const setClause = columns.map((col, i) => `${escapeIdentifierPG(col)} = $${i + 1}`).join(', ');
          const pkColumns = Object.keys(pkValues);
          const whereClause = pkColumns
            .map((col, i) => `${escapeIdentifierPG(col)} = $${columns.length + i + 1}`)
            .join(' AND ');
          const sql = `UPDATE ${escapedTable} SET ${setClause} WHERE ${whereClause}`;
          await client.query(sql, [...values, ...Object.values(pkValues)]);
        } else if (change.operation === ChangeOperation.DELETE) {
          const pkColumns = Object.keys(pkValues);
          const whereClause = pkColumns.map((col, i) => `${escapeIdentifierPG(col)} = $${i + 1}`).join(' AND ');
          const sql = `DELETE FROM ${escapedTable} WHERE ${whereClause}`;
          await client.query(sql, Object.values(pkValues));
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      if (client) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (client) await client.release();
      await ConnectionFactory.closePostgreSQLPool(result);
    }
  }
}
