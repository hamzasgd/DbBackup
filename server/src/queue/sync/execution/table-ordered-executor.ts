import { ConnectionConfig } from '../../../services/engines/base.engine';
import { logger } from '../../../config/logger';
import { ConnectionFactory } from '../../../services/engines/connection-factory';

/**
 * Represents a foreign key dependency between two tables.
 */
export type TableDependency = {
  childTable: string;
  parentTable: string;
};

/**
 * Order tables so parent tables are synchronized before child tables.
 * Falls back to original order if metadata query fails.
 */
export async function getTablesInDependencyOrder(
  config: ConnectionConfig,
  tables: string[],
  options?: { strict?: boolean }
): Promise<string[]> {
  if (tables.length <= 1) {
    return tables;
  }

  try {
    const dependencies = await getForeignKeyDependencies(config);
    return topologicalSortTables(tables, dependencies);
  } catch (error) {
    if (options?.strict) {
      const details = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Strict table ordering is enabled and foreign key dependency metadata could not be resolved: ${details}`
      );
    }
    logger.warn(`Could not resolve table dependency order, using original order: ${String(error)}`);
    return tables;
  }
}

async function getForeignKeyDependencies(config: ConnectionConfig): Promise<TableDependency[]> {
  if (config.type === 'MYSQL' || config.type === 'MARIADB') {
    const result = await ConnectionFactory.createMySQLConnection(config);
    try {
      const sql = `
        SELECT TABLE_NAME AS childTable, REFERENCED_TABLE_NAME AS parentTable
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `;
      const [rows] = await result.connection.execute(sql, [config.database]);
      return (rows as { childTable: string; parentTable: string }[]).map((row) => ({
        childTable: String(row.childTable),
        parentTable: String(row.parentTable),
      }));
    } finally {
      await ConnectionFactory.closeMySQLConnection(result);
    }
  }

  if (config.type === 'POSTGRESQL' || config.type === 'POSTGRES') {
    const result = await ConnectionFactory.createPostgreSQLPool(config);
    try {
      const client = await ConnectionFactory.getPostgreSQLClient(result.pool);
      // Use current_schema() instead of hardcoded 'public'
      const sql = `
        SELECT tc.table_name AS child_table, ccu.table_name AS parent_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
         AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = current_schema()
      `;
      const pgResult = await client.query(sql);
      return pgResult.rows.map((row: { child_table: string; parent_table: string }) => ({
        childTable: String(row.child_table),
        parentTable: String(row.parent_table),
      }));
    } finally {
      await ConnectionFactory.closePostgreSQLPool(result);
    }
  }

  return [];
}

/**
 * Topologically sort tables based on foreign key dependencies.
 * Uses Kahn's algorithm with cycle detection.
 */
export function topologicalSortTables(tables: string[], dependencies: TableDependency[]): string[] {
  const tableSet = new Set(tables);
  const tableIndex = new Map(tables.map((table, index) => [table, index]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();

  for (const table of tables) {
    inDegree.set(table, 0);
    adjacency.set(table, new Set());
  }

  for (const dep of dependencies) {
    if (!tableSet.has(dep.parentTable) || !tableSet.has(dep.childTable)) {
      continue;
    }
    if (dep.parentTable === dep.childTable) {
      continue;
    }

    const children = adjacency.get(dep.parentTable)!;
    if (children.has(dep.childTable)) {
      continue;
    }

    children.add(dep.childTable);
    inDegree.set(dep.childTable, (inDegree.get(dep.childTable) ?? 0) + 1);
  }

  const queue = tables
    .filter((table) => (inDegree.get(table) ?? 0) === 0)
    .sort((a, b) => (tableIndex.get(a) ?? 0) - (tableIndex.get(b) ?? 0));

  const ordered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);

    const children = Array.from(adjacency.get(current) ?? []).sort(
      (a, b) => (tableIndex.get(a) ?? 0) - (tableIndex.get(b) ?? 0)
    );

    for (const child of children) {
      const nextDegree = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, nextDegree);
      if (nextDegree === 0) {
        queue.push(child);
      }
    }
  }

  if (ordered.length === tables.length) {
    return ordered;
  }

  // Cycles or unresolved dependencies: preserve original order for remaining tables.
  for (const table of tables) {
    if (!ordered.includes(table)) {
      ordered.push(table);
    }
  }

  return ordered;
}
