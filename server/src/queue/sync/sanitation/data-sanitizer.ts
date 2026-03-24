import { logger } from '../../../config/logger';

/**
 * Normalize a runtime value into JSON text accepted by database JSON columns.
 */
export function normalizeJsonValue(value: unknown): { value: string | null; coerced: boolean; reason?: string } {
  if (value === null || value === undefined) {
    return { value: null, coerced: false };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { value: JSON.stringify(value), coerced: true, reason: 'empty_or_whitespace_string' };
    }

    try {
      JSON.parse(trimmed);
      return { value: trimmed, coerced: false };
    } catch {
      return { value: JSON.stringify(value), coerced: true, reason: 'plain_text_to_json_string' };
    }
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return { value: JSON.stringify(value), coerced: true, reason: `primitive_${typeof value}` };
  }

  if (typeof value === 'bigint') {
    return { value: JSON.stringify(value.toString()), coerced: true, reason: 'bigint_to_string' };
  }

  if (value instanceof Date) {
    return { value: JSON.stringify(value.toISOString()), coerced: true, reason: 'date_to_iso_string' };
  }

  try {
    return { value: JSON.stringify(value), coerced: true, reason: 'object_to_json' };
  } catch {
    return { value: JSON.stringify(String(value)), coerced: true, reason: 'stringified_fallback' };
  }
}

/**
 * Sanitize data before applying to target database.
 * Handles JSON columns and other data type issues.
 */
export function sanitizeData(
  data: Record<string, unknown>,
  options?: { jsonColumns?: Set<string>; tableName?: string }
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const jsonColumns = options?.jsonColumns;

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      sanitized[key] = value;
      continue;
    }

    // MySQL JSON columns expect valid JSON text. Normalize values first.
    if (jsonColumns?.has(key)) {
      const normalized = normalizeJsonValue(value);
      sanitized[key] = normalized.value;
      if (normalized.coerced) {
        logger.info(
          `Normalized JSON column '${options?.tableName ?? 'unknown_table'}.${key}' (${normalized.reason})`
        );
      }
      continue;
    }

    // Only known JSON columns are transformed. Non-JSON columns are preserved as-is.
    sanitized[key] = value;
  }

  return sanitized;
}

/**
 * Fetch JSON column names for a MySQL/MariaDB table.
 */
export async function getMySqlJsonColumns(
  connection: unknown,
  database: string,
  tableName: string
): Promise<Set<string>> {
  const sql = `
    SELECT COLUMN_NAME AS columnName
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = ?
      AND DATA_TYPE = 'json'
  `;

  const connectionWithExecute = connection as { execute(sql: string, args: unknown[]): Promise<unknown> };
  const [rows] = await connectionWithExecute.execute(sql, [database, tableName]) as [unknown[], unknown];
  return new Set((rows as { columnName: unknown }[]).map((row) => String(row.columnName)));
}
