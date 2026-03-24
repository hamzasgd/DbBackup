/**
 * Type mapping between MySQL and PostgreSQL databases.
 */

const MYSQL_TO_PG: Record<string, string> = {
  'tinyint(1)': 'boolean',
  tinyint: 'smallint',
  smallint: 'smallint',
  mediumint: 'integer',
  int: 'integer',
  bigint: 'bigint',
  float: 'real',
  double: 'double precision',
  decimal: 'numeric',
  varchar: 'varchar',
  char: 'char',
  tinytext: 'text',
  text: 'text',
  mediumtext: 'text',
  longtext: 'text',
  tinyblob: 'bytea',
  blob: 'bytea',
  mediumblob: 'bytea',
  longblob: 'bytea',
  date: 'date',
  time: 'time',
  datetime: 'timestamp',
  timestamp: 'timestamp',
  year: 'integer',
  json: 'jsonb',
  enum: 'text',
  set: 'text',
};

const PG_TO_MYSQL: Record<string, string> = {
  boolean: 'tinyint(1)',
  smallint: 'smallint',
  integer: 'int',
  bigint: 'bigint',
  real: 'float',
  'double precision': 'double',
  numeric: 'decimal',
  varchar: 'varchar',
  char: 'char',
  text: 'text',
  bytea: 'blob',
  date: 'date',
  time: 'time',
  timestamp: 'datetime',
  'timestamp without time zone': 'datetime',
  'timestamp with time zone': 'datetime',
  jsonb: 'json',
  json: 'json',
  uuid: 'varchar(36)',
};

/**
 * Map a database type from source engine to destination engine.
 */
export function mapType(srcType: string, srcEngine: string, dstEngine: string, columnLength?: number): string {
  const normalized = srcType.toLowerCase();
  const baseType = normalized.split('(')[0].trim();
  const precisionMatch = normalized.match(/\(([^)]+)\)$/);
  const preservedPrecision = precisionMatch ? `(${precisionMatch[1]})` : '';

  if (srcEngine !== dstEngine) {
    if (dstEngine === 'POSTGRESQL') {
      const pgType = MYSQL_TO_PG[baseType] ?? 'text';
      return pgType === 'text' ? pgType : pgType + preservedPrecision;
    }
    const mysqlType = PG_TO_MYSQL[baseType] ?? 'text';
    // For varchar/char, use actual column length if available, otherwise preserve source precision
    if ((baseType === 'varchar' || baseType === 'char') && columnLength) {
      return `${mysqlType}(${columnLength})`;
    }
    return mysqlType === 'text' ? mysqlType : mysqlType + preservedPrecision;
  }
  return srcType;
}
