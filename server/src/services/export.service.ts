import { Response } from 'express';
import mysql2 from 'mysql2/promise';
import { Pool } from 'pg';
import { ConnectionConfig } from './engines/base.engine';
import { AppError } from '../middleware/errorHandler';

export type ExportFormat = 'json' | 'csv' | 'sql';

const BATCH_SIZE = 5000;
const MAX_JSON_ROWS = 1000000;
const TABLE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

function validateTableName(table: string): void {
  if (!TABLE_NAME_REGEX.test(table)) {
    throw new AppError(`Invalid table name: ${table}`, 400);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Map each requested table to a quoted identifier taken from the PostgreSQL
 * catalog. Unknown tables are rejected, so user input never reaches a query.
 */
async function resolvePostgresTables(pool: Pool, tables: string[]): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `SELECT DISTINCT table_name
       FROM information_schema.tables
      WHERE table_schema = ANY (current_schemas(false))
        AND table_name = ANY ($1::text[])`,
    [tables],
  );
  const catalogNames: string[] = rows.map((r: { table_name: string }) => r.table_name);
  const resolved = new Map<string, string>();
  for (const table of tables) {
    // Use the catalog's own spelling of the name, never the request's string
    const name = catalogNames.find((n) => n === table);
    if (name === undefined) {
      throw new AppError(`Table not found: ${table}`, 404);
    }
    resolved.set(table, `"${name.replace(/"/g, '""')}"`);
  }
  return resolved;
}

function escapeCsvValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeSqlValue(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number' || typeof val === 'bigint') return String(val);
  if (typeof val === 'boolean') return val ? '1' : '0';
  const str = String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${str}'`;
}

// ─── MySQL Export ────────────────────────────────────────────────────────────

export async function exportMySQL(
  config: ConnectionConfig,
  tables: string[],
  format: ExportFormat,
  res: Response,
): Promise<void> {
  // Validate all table names before any query runs
  for (const table of tables) {
    validateTableName(table);
  }

  const getSslOptions = () => {
    if (!config.sslEnabled) return undefined;
    if (config.sslCa) return { rejectUnauthorized: true, ca: config.sslCa };
    return { rejectUnauthorized: false };
  };

  const conn = await mysql2.createConnection({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password ?? undefined,
    database: config.database,
    ssl: getSslOptions(),
    connectTimeout: 10000,
  });

  try {
    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${config.database}_export.json"`);
      const result = new Map<string, unknown[]>();

      for (const table of tables) {
        const [rows] = await conn.query<mysql2.RowDataPacket[]>(
          'SELECT * FROM ?? LIMIT ?', [table, MAX_JSON_ROWS]
        );
        result.set(table, rows);
      }
      res.end(JSON.stringify(Object.fromEntries(result), null, 2));

    } else if (format === 'csv') {
      // Multi-table CSV: separate sections per table
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${config.database}_export.csv"`);

      for (const table of tables) {
        res.write(`# TABLE: ${table}\n`);
        let offset = 0;
        let firstBatch = true;

        while (true) {
          const [rows] = await conn.query<mysql2.RowDataPacket[]>(
            'SELECT * FROM ?? LIMIT ? OFFSET ?', [table, BATCH_SIZE, offset]
          );
          if (rows.length === 0) break;

          if (firstBatch) {
            res.write(Object.keys(rows[0]).map(escapeCsvValue).join(',') + '\n');
            firstBatch = false;
          }
          for (const row of rows) {
            res.write(Object.values(row).map(escapeCsvValue).join(',') + '\n');
          }
          offset += BATCH_SIZE;
          if (rows.length < BATCH_SIZE) break;
        }
        res.write('\n');
      }
      res.end();

    } else {
      // SQL INSERT statements
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${config.database}_export.sql"`);
      res.write(`-- Export of database: ${config.database}\n-- Generated: ${new Date().toISOString()}\n\n`);

      for (const table of tables) {
        res.write(`-- Table: ${table}\n`);
        let offset = 0;

        while (true) {
          const [rows] = await conn.query<mysql2.RowDataPacket[]>(
            'SELECT * FROM ?? LIMIT ? OFFSET ?', [table, BATCH_SIZE, offset]
          );
          if (rows.length === 0) break;

          const cols = Object.keys(rows[0]).map(c => `\`${c}\``).join(', ');
          for (const row of rows) {
            const vals = Object.values(row).map(escapeSqlValue).join(', ');
            res.write(`INSERT INTO \`${table}\` (${cols}) VALUES (${vals});\n`);
          }
          offset += BATCH_SIZE;
          if (rows.length < BATCH_SIZE) break;
        }
        res.write('\n');
      }
      res.end();
    }
  } finally {
    await conn.end();
  }
}

// ─── PostgreSQL Export ───────────────────────────────────────────────────────

export async function exportPostgres(
  config: ConnectionConfig,
  tables: string[],
  format: ExportFormat,
  res: Response,
): Promise<void> {
  // Validate all table names before any query runs
  for (const table of tables) {
    validateTableName(table);
  }

  const getSslOptions = () => {
    if (!config.sslEnabled) return undefined;
    if (config.sslCa) return { rejectUnauthorized: true, ca: config.sslCa };
    return { rejectUnauthorized: false };
  };

  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password ?? undefined,
    database: config.database,
    ssl: getSslOptions(),
    connectionTimeoutMillis: 10000,
    max: 2,
  });

  try {
    // Identifiers can't be bound as parameters, so only names that exist in the
    // catalog (as returned by the server itself) are ever put into a query.
    const resolved = await resolvePostgresTables(pool, tables);

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${config.database}_export.json"`);
      const result = new Map<string, unknown[]>();

      for (const [table, safeName] of resolved) {
        const { rows } = await pool.query(`SELECT * FROM ${safeName} LIMIT $1`, [MAX_JSON_ROWS]);
        result.set(table, rows);
      }
      res.end(JSON.stringify(Object.fromEntries(result), null, 2));

    } else if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${config.database}_export.csv"`);

      for (const [table, safeName] of resolved) {
        res.write(`# TABLE: ${table}\n`);
        let offset = 0;
        let firstBatch = true;

        while (true) {
          const { rows } = await pool.query(
            `SELECT * FROM ${safeName} LIMIT $1 OFFSET $2`, [BATCH_SIZE, offset]
          );
          if (rows.length === 0) break;

          if (firstBatch) {
            res.write(Object.keys(rows[0]).map(escapeCsvValue).join(',') + '\n');
            firstBatch = false;
          }
          for (const row of rows) {
            res.write(Object.values(row).map(escapeCsvValue).join(',') + '\n');
          }
          offset += BATCH_SIZE;
          if (rows.length < BATCH_SIZE) break;
        }
        res.write('\n');
      }
      res.end();

    } else {
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${config.database}_export.sql"`);
      res.write(`-- Export of database: ${config.database}\n-- Generated: ${new Date().toISOString()}\n\n`);

      for (const [table, safeName] of resolved) {
        res.write(`-- Table: ${table}\n`);
        let offset = 0;

        while (true) {
          const { rows } = await pool.query(
            `SELECT * FROM ${safeName} LIMIT $1 OFFSET $2`, [BATCH_SIZE, offset]
          );
          if (rows.length === 0) break;

          const cols = Object.keys(rows[0]).map(c => `"${c}"`).join(', ');
          for (const row of rows) {
            const vals = Object.values(row).map(escapeSqlValue).join(', ');
            res.write(`INSERT INTO ${safeName} (${cols}) VALUES (${vals});\n`);
          }
          offset += BATCH_SIZE;
          if (rows.length < BATCH_SIZE) break;
        }
        res.write('\n');
      }
      res.end();
    }
  } finally {
    await pool.end();
  }
}
