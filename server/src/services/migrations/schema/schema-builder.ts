import { ColumnMeta, TableMeta } from '../types/migration.types';
import { mapType } from '../type-mapping/type-mapper';

/**
 * Quote an identifier taken from a source database catalog. Table and column
 * names are controlled by whoever owns the source schema, so they must never
 * be pasted into target SQL unquoted (a name like `x"; DROP TABLE t; --` would
 * otherwise run on the target with the target's credentials).
 */
export function quotePG(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function quoteMySQL(name: string): string {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/** Only emit column types that look like a plain SQL type (no free text from the source). */
function safeType(t: string): string {
  return /^[a-z][a-z0-9 ]*(\(\d+(,\s*\d+)?\))?$/i.test(t) ? t : 'text';
}

/**
 * Build PostgreSQL CREATE TABLE statement from table metadata.
 */
export function buildPGCreateTable(meta: TableMeta, srcEngine: string): string {
  const columnDefs = meta.columns.map((col) => {
    const pgType = safeType(mapType(col.type, srcEngine, 'POSTGRESQL', col.length));
    let def = `  ${quotePG(col.name)} ${pgType}`;
    if (!col.nullable) def += ' NOT NULL';
    if (col.extra) {
      if (col.extra.includes('auto_increment')) def += ' GENERATED ALWAYS AS IDENTITY';
      if (col.extra.includes('ON UPDATE CURRENT_TIMESTAMP')) def += ' DEFAULT CURRENT_TIMESTAMP';
    }
    return def;
  });

  const pkColumns = meta.columns.filter((c) => c.isPrimaryKey);
  if (pkColumns.length > 0) {
    columnDefs.push(`  PRIMARY KEY (${pkColumns.map((c) => quotePG(c.name)).join(', ')})`);
  }

  return `CREATE TABLE ${quotePG(meta.name)} (\n${columnDefs.join(',\n')}\n)`;
}

/**
 * Build MySQL CREATE TABLE statement from table metadata.
 */
export function buildMySQLCreateTable(meta: TableMeta, srcEngine: string): string {
  const columnDefs = meta.columns.map((col) => {
    const mysqlType = safeType(mapType(col.type, srcEngine, 'MYSQL', col.length));
    let def = `  ${quoteMySQL(col.name)} ${mysqlType}`;
    if (!col.nullable) def += ' NOT NULL';
    if (col.extra) {
      if (col.extra.includes('auto_increment')) def += ' AUTO_INCREMENT';
      if (col.extra.includes('ON UPDATE CURRENT_TIMESTAMP')) def += ' ON UPDATE CURRENT_TIMESTAMP';
    }
    return def;
  });

  const pkColumns = meta.columns.filter((c) => c.isPrimaryKey);
  if (pkColumns.length > 0) {
    columnDefs.push(`  PRIMARY KEY (${pkColumns.map((c) => quoteMySQL(c.name)).join(', ')})`);
  }

  return `CREATE TABLE ${quoteMySQL(meta.name)} (\n${columnDefs.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;
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
