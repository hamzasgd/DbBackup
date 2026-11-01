import { Response } from 'express';
import mysql2 from 'mysql2';
import { Pool, PoolClient, escapeLiteral as pgEscapeLiteral } from 'pg';
import { ConnectionConfig } from './engines/base.engine';
import { AppError } from '../middleware/errorHandler';
import { nodeTlsOptions } from './engines/tls';

/** pg's escapeLiteral prefixes E-strings with a space; drop it. */
const escapeLiteral = (v: string) => pgEscapeLiteral(v).trim();

export type ExportFormat = 'json' | 'csv' | 'sql';

/** Rows fetched per round trip. Only one batch is held in memory at a time. */
const BATCH_SIZE = 5000;
const TABLE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;

type Row = Record<string, unknown>;

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
async function resolvePostgresTables(client: PoolClient, tables: string[]): Promise<Map<string, string>> {
  const { rows } = await client.query(
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
  const str = val instanceof Date ? val.toISOString() : typeof val === 'object' && !Buffer.isBuffer(val) ? JSON.stringify(val) : String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** PostgreSQL array text form ({a,"b c",NULL}) for array columns, as the pg driver formats them. */
function pgArrayText(values: unknown[]): string {
  return `{${values.map((v) => {
    if (v === null || v === undefined) return 'NULL';
    if (Array.isArray(v)) return pgArrayText(v);
    const text = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }).join(',')}}`;
}

/**
 * For SQL exports every PostgreSQL value is read in its exact text form (no JS
 * conversion: microseconds, numeric precision, bytea, arrays and json text are
 * kept), then written as a quoted literal the server casts back to the column type.
 */
const RAW_TEXT_TYPES = { getTypeParser: () => (value: string) => value };

/** SQL literal for a PostgreSQL INSERT (standard-conforming strings, real booleans, bytea, arrays, json). */
function pgLiteral(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number' || typeof val === 'bigint') return Number.isFinite(Number(val)) ? String(val) : `'${String(val)}'`;
  if (Buffer.isBuffer(val)) return `'\\x${val.toString('hex')}'::bytea`;
  if (val instanceof Date) return escapeLiteral(val.toISOString());
  if (Array.isArray(val)) return escapeLiteral(pgArrayText(val));
  if (typeof val === 'object') return escapeLiteral(JSON.stringify(val));
  return escapeLiteral(String(val));
}

/** SQL literal for a MySQL/MariaDB INSERT (the driver's own escaping: dates, buffers, quotes, backslashes). */
function mysqlLiteral(val: unknown): string {
  // JSON columns arrive as parsed objects; the driver would turn those into `key` = value pairs
  if (val !== null && typeof val === 'object' && !Buffer.isBuffer(val) && !(val instanceof Date)) {
    return mysql2.escape(JSON.stringify(val));
  }
  return mysql2.escape(val as Parameters<typeof mysql2.escape>[0]);
}

// ─── Streaming output ───────────────────────────────────────────────────────

/** Writes to the HTTP response with backpressure; stops the export when the client goes away. */
class Output {
  private closed = false;

  constructor(private readonly res: Response) {
    res.on('close', () => { this.closed = true; });
  }

  get aborted(): boolean {
    return this.closed || this.res.destroyed;
  }

  async write(chunk: string): Promise<void> {
    if (this.aborted) throw new ExportAborted();
    if (!this.res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = () => { this.res.off('drain', done); this.res.off('close', done); resolve(); };
        this.res.on('drain', done);
        this.res.on('close', done);
      });
    }
  }
}

class ExportAborted extends Error {}

/** Format-specific framing around the rows of each table. */
interface Writer {
  begin(): Promise<void>;
  table(name: string, index: number): Promise<void>;
  rows(rows: Row[]): Promise<void>;
  endTable(): Promise<void>;
  end(): Promise<void>;
}

function makeWriter(
  format: ExportFormat,
  out: Output,
  res: Response,
  database: string,
  dialect: 'pg' | 'mysql',
  qualify: (table: string) => string,
): Writer {
  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${database}_export.json"`);
    let firstRow = true;
    return {
      begin: () => out.write('{'),
      table: (name, i) => { firstRow = true; return out.write(`${i ? ',' : ''}\n  ${JSON.stringify(name)}: [`); },
      rows: async (rows) => {
        let chunk = '';
        for (const row of rows) {
          chunk += `${firstRow ? '' : ','}\n    ${JSON.stringify(row)}`;
          firstRow = false;
        }
        await out.write(chunk);
      },
      endTable: () => out.write(firstRow ? ']' : '\n  ]'),
      end: () => out.write('\n}\n'),
    };
  }

  if (format === 'csv') {
    // Multi-table CSV: separate sections per table
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${database}_export.csv"`);
    let header = false;
    return {
      begin: async () => undefined,
      table: (name) => { header = false; return out.write(`# TABLE: ${name}\n`); },
      rows: async (rows) => {
        let chunk = '';
        if (!header && rows.length) {
          chunk += Object.keys(rows[0]).map(escapeCsvValue).join(',') + '\n';
          header = true;
        }
        for (const row of rows) chunk += Object.values(row).map(escapeCsvValue).join(',') + '\n';
        await out.write(chunk);
      },
      endTable: () => out.write('\n'),
      end: async () => undefined,
    };
  }

  // SQL INSERT statements in the source database's dialect
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="${database}_export.sql"`);
  const literal = dialect === 'pg' ? pgLiteral : mysqlLiteral;
  const quoteCol = dialect === 'pg' ? (c: string) => `"${c.replace(/"/g, '""')}"` : (c: string) => `\`${c.replace(/`/g, '``')}\``;
  let current = '';
  return {
    begin: () => out.write(`-- Export of database: ${database}\n-- Generated: ${new Date().toISOString()}\n\n`),
    table: (name) => { current = qualify(name); return out.write(`-- Table: ${name}\n`); },
    rows: async (rows) => {
      if (!rows.length) return;
      const cols = Object.keys(rows[0]).map(quoteCol).join(', ');
      let chunk = '';
      for (const row of rows) chunk += `INSERT INTO ${current} (${cols}) VALUES (${Object.values(row).map(literal).join(', ')});\n`;
      await out.write(chunk);
    },
    endTable: () => out.write('\n'),
    end: async () => undefined,
  };
}

async function finish(res: Response, writer: Writer, run: () => Promise<void>): Promise<void> {
  try {
    await writer.begin();
    await run();
    await writer.end();
    res.end();
  } catch (err) {
    if (err instanceof ExportAborted) return; // client disconnected: stop quietly
    if (res.headersSent) {
      // Too late for an error status; cut the stream so the download is visibly incomplete
      res.destroy(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    throw err;
  }
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

  // Core (callback) connection: its query().stream() reads rows as they arrive; .promise() for the rest
  const core = mysql2.createConnection({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password ?? undefined,
    database: config.database,
    ssl: nodeTlsOptions(config, 'mysql2'),
    connectTimeout: 10000,
    // BIGINTs beyond 2^53 come back as strings instead of losing digits
    supportBigNumbers: true,
    // SQL exports re-import exactly: dates keep microseconds, JSON keeps its stored text
    ...(format === 'sql' ? { dateStrings: true, jsonStrings: true } : {}),
  });
  const conn = core.promise();

  try {
    // One consistent snapshot for all tables, like mysqldump --single-transaction
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const out = new Output(res);
    const quote = (t: string) => `\`${t.replace(/`/g, '``')}\``;
    const writer = makeWriter(format, out, res, config.database, 'mysql', quote);

    await finish(res, writer, async () => {
      let index = 0;
      for (const table of tables) {
        await writer.table(table, index++);
        // Rows stream from the server (no LIMIT/OFFSET rescans); only one batch is buffered
        const stream = core.query({ sql: 'SELECT * FROM ??', values: [table] }).stream({ highWaterMark: BATCH_SIZE });
        let batch: Row[] = [];
        try {
          for await (const row of stream as AsyncIterable<Row>) {
            batch.push(row);
            if (batch.length >= BATCH_SIZE) {
              await writer.rows(batch);
              batch = [];
            }
          }
        } catch (err) {
          stream.destroy();
          throw err;
        }
        await writer.rows(batch);
        await writer.endTable();
      }
    });
  } finally {
    await conn.query('COMMIT').catch(() => undefined);
    await conn.end().catch(() => core.destroy());
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

  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password ?? undefined,
    database: config.database,
    ssl: nodeTlsOptions(config),
    connectionTimeoutMillis: 10000,
    max: 1,
  });

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    // Identifiers can't be bound as parameters, so only names that exist in the
    // catalog (as returned by the server itself) are ever put into a query.
    const resolved = await resolvePostgresTables(client, tables);

    // One snapshot for every table; a cursor per table fetches BATCH_SIZE rows at a time
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const out = new Output(res);
    const writer = makeWriter(format, out, res, config.database, 'pg', (t) => resolved.get(t)!);
    const c = client;

    await finish(res, writer, async () => {
      let index = 0;
      for (const [table, safeName] of resolved) {
        await writer.table(table, index++);
        await c.query(`DECLARE dbbk_export NO SCROLL CURSOR FOR SELECT * FROM ${safeName}`);
        for (;;) {
          const { rows } = await c.query({ text: `FETCH ${BATCH_SIZE} FROM dbbk_export`, ...(format === 'sql' ? { types: RAW_TEXT_TYPES } : {}) });
          await writer.rows(rows);
          if (rows.length < BATCH_SIZE) break;
        }
        await c.query('CLOSE dbbk_export');
        await writer.endTable();
      }
    });
  } finally {
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    await pool.end();
  }
}
