import { ColumnMeta, TableMeta } from '../types/migration.types';
import { mapType } from '../type-mapping/type-mapper';

/**
 * Build PostgreSQL CREATE TABLE statement from table metadata.
 */
export function buildPGCreateTable(meta: TableMeta, srcEngine: string): string {
  const columnDefs = meta.columns.map((col) => {
    const pgType = mapType(col.type, srcEngine, 'POSTGRESQL', col.length);
    let def = `  ${col.name} ${pgType}`;
    if (!col.nullable) def += ' NOT NULL';
    if (col.extra) {
      if (col.extra.includes('auto_increment')) def += ' GENERATED ALWAYS AS IDENTITY';
      if (col.extra.includes('ON UPDATE CURRENT_TIMESTAMP')) def += ' DEFAULT CURRENT_TIMESTAMP';
    }
    return def;
  });

  const pkColumns = meta.columns.filter((c) => c.isPrimaryKey);
  if (pkColumns.length > 0) {
    columnDefs.push(`  PRIMARY KEY (${pkColumns.map((c) => c.name).join(', ')})`);
  }

  return `CREATE TABLE ${meta.name} (\n${columnDefs.join(',\n')}\n)`;
}

/**
 * Build MySQL CREATE TABLE statement from table metadata.
 */
export function buildMySQLCreateTable(meta: TableMeta, srcEngine: string): string {
  const columnDefs = meta.columns.map((col) => {
    const mysqlType = mapType(col.type, srcEngine, 'MYSQL', col.length);
    let def = `  \`${col.name}\` ${mysqlType}`;
    if (!col.nullable) def += ' NOT NULL';
    if (col.extra) {
      if (col.extra.includes('auto_increment')) def += ' AUTO_INCREMENT';
      if (col.extra.includes('ON UPDATE CURRENT_TIMESTAMP')) def += ' ON UPDATE CURRENT_TIMESTAMP';
    }
    return def;
  });

  const pkColumns = meta.columns.filter((c) => c.isPrimaryKey);
  if (pkColumns.length > 0) {
    columnDefs.push(`  PRIMARY KEY (${pkColumns.map((c) => `\`${c.name}\``).join(', ')})`);
  }

  return `CREATE TABLE \`${meta.name}\` (\n${columnDefs.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
}

/**
 * Escape a value for SQL insertion.
 */
export function escapeValue(val: unknown): string {
  if (val === null || val === undefined) {
    return 'NULL';
  }
  if (typeof val === 'boolean') {
    return val ? 'TRUE' : 'FALSE';
  }
  if (typeof val === 'number') {
    return String(val);
  }
  if (typeof val === 'string') {
    return `'${val.replace(/'/g, "''")}'`;
  }
  if (val instanceof Date) {
    return `'${val.toISOString()}'`;
  }
  if (Buffer.isBuffer(val)) {
    return `X'${val.toString('hex')}'`;
  }
  // Fallback: JSON stringify
  return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
}
