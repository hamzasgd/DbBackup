/**
 * Create a unique conflict key for a table and primary key values.
 * Used to identify conflicting records in bidirectional sync.
 */
export function createConflictKey(tableName: string, primaryKeyValues: Record<string, unknown>): string {
  const sortedKeys = Object.keys(primaryKeyValues).sort();
  const keyParts = sortedKeys.map(k => `${k}:${primaryKeyValues[k]}`);
  return `${tableName}:${keyParts.join(',')}`;
}
