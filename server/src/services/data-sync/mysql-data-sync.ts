import type * as mysql2 from 'mysql2/promise';
import { ConnectionFactory, type MySQLConnectionResult } from '../engines/connection-factory';
import type { ConnectionConfig } from '../engines/base.engine';

/**
 * Compare two MySQL/MariaDB databases with the same schema and copy only the
 * rows that differ, from source to target. Works with any provider: it only
 * needs to read the source and write the target over a normal connection.
 *
 * Per table, rows are split into chunks along the primary key. Each server
 * computes a 128-bit checksum of every chunk itself, so only checksums cross
 * the network. For a chunk whose checksums differ, both sides list the
 * primary keys with a hash of each row; rows only in the source are
 * inserted, rows whose hash differs are replaced, rows only in the target are
 * deleted. Only those rows are read from the source.
 *
 * The source is read inside one consistent snapshot, so the target ends up
 * matching the source as it was when the run started.
 */

export type TableStatus =
  | 'SAME'            // nothing to do
  | 'DIFFERENT'       // compare only: differences found
  | 'SYNCED'          // differences copied
  | 'CREATED'         // table was missing on the target: created and filled
  | 'ONLY_IN_SOURCE'  // compare only: the target has no such table
  | 'ONLY_IN_TARGET'  // left alone
  | 'SKIPPED'
  | 'ERROR';

export interface TableReport {
  table: string;
  /** The table's name on the target when it differs in case (e.g. "appsettings" for "AppSettings") */
  targetTable?: string;
  status: TableStatus;
  /** Rows in the source table (counted while comparing) */
  rows: number;
  /** Rows inserted / replaced / deleted on the target (or that would be, when only comparing) */
  inserted: number;
  updated: number;
  deleted: number;
  chunks: number;
  chunksDifferent: number;
  reason?: string;
  warning?: string;
}

export interface DataSyncProgress {
  table: string;
  tableIndex: number;
  tableCount: number;
  /** Source rows checked so far, over all tables */
  rowsChecked: number;
  /** Rough total of source rows (from table statistics) */
  rowsEstimate: number;
}

export interface DataSyncOptions {
  /** false: compare only (nothing is written) */
  apply: boolean;
  /** Limit to these tables (empty = all) */
  tables?: string[];
  /** Rows per chunk (default 5000) */
  chunkSize?: number;
  onProgress?: (p: DataSyncProgress) => void;
  onTable?: (r: TableReport) => void;
  /** Checked between chunks; true stops the run */
  shouldStop?: () => boolean;
}

export class DataSyncStopped extends Error {
  constructor() { super('Stopped by the user'); }
}

// Exact copies: dates, big numbers, decimals and JSON as text, never re-interpreted by JavaScript
const EXACT: Partial<mysql2.ConnectionOptions> = {
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  decimalNumbers: false,
  jsonStrings: true,
  multipleStatements: false,
};

const BINARY_TYPES = new Set([
  'binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit',
  'geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon',
  'geometrycollection', 'geomcollection',
]);

interface Column {
  name: string;
  dataType: string;
  columnType: string;
  nullable: boolean;
  generated: boolean;
}

interface TableMeta {
  columns: Column[];
  pk: string[];
  rowsEstimate: number;
  hasTriggers: boolean;
}

export const qid = (name: string) => `\`${name.replace(/`/g, '``')}\``;

/** "int(11) unsigned" and "int unsigned" are the same type (MySQL 8 dropped display widths). */
export function normalizeColumnType(t: string): string {
  return t.toLowerCase().replace(/^(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)/, '$1').trim();
}

/** Per-row hash expression: every column, NULL told apart from '' by a flag string. */
export function rowHashExpr(columns: Column[]): string {
  const parts = columns.map((c) => (BINARY_TYPES.has(c.dataType) ? `HEX(${qid(c.name)})` : `CONVERT(${qid(c.name)} USING utf8mb4)`));
  const nullFlags = `CONCAT(${columns.map((c) => `ISNULL(${qid(c.name)})`).join(', ')})`;
  return `MD5(CONCAT_WS('#', ${[...parts, nullFlags].join(', ')}))`;
}

type Bound = unknown[] | null;

/** WHERE clause for a chunk: (pk) > lo AND (pk) <= hi, either side open. */
export function rangeWhere(pk: string[], lo: Bound, hi: Bound): { sql: string; params: unknown[] } {
  const tuple = pk.length === 1 ? qid(pk[0]) : `(${pk.map(qid).join(', ')})`;
  const ph = pk.length === 1 ? '?' : `(${pk.map(() => '?').join(', ')})`;
  const conds: string[] = [];
  const params: unknown[] = [];
  if (lo) { conds.push(`${tuple} > ${ph}`); params.push(...lo); }
  if (hi) { conds.push(`${tuple} <= ${ph}`); params.push(...hi); }
  return { sql: conds.length ? conds.join(' AND ') : '1=1', params };
}

function keyOf(row: Record<string, unknown>, pk: string[]): string {
  return JSON.stringify(pk.map((k) => {
    const v = row[k];
    return Buffer.isBuffer(v) ? `0x${v.toString('hex')}` : v;
  }));
}

async function open(config: ConnectionConfig): Promise<MySQLConnectionResult> {
  return ConnectionFactory.createMySQLConnection(config, EXACT);
}

async function rows<T = Record<string, unknown>>(c: mysql2.Connection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await c.query(sql, params);
  return r as T[];
}

async function tableNames(c: mysql2.Connection): Promise<string[]> {
  const r = await rows<{ t: string }>(c,
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME");
  return r.map((x) => x.t);
}

async function tableMeta(c: mysql2.Connection, table: string): Promise<TableMeta> {
  const cols = await rows<{ n: string; dt: string; ct: string; nl: string; ex: string }>(c,
    `SELECT COLUMN_NAME AS n, DATA_TYPE AS dt, COLUMN_TYPE AS ct, IS_NULLABLE AS nl, EXTRA AS ex
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [table]);
  const pk = await rows<{ n: string }>(c,
    `SELECT COLUMN_NAME AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`, [table]);
  const [est] = await rows<{ r: string | number | null }>(c,
    'SELECT TABLE_ROWS AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
  const [trg] = await rows<{ n: string | number }>(c,
    'SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = DATABASE() AND EVENT_OBJECT_TABLE = ?', [table]);
  return {
    columns: cols.map((x) => ({
      name: x.n,
      dataType: String(x.dt).toLowerCase(),
      columnType: normalizeColumnType(String(x.ct)),
      nullable: x.nl === 'YES',
      generated: /GENERATED/i.test(String(x.ex ?? '')),
    })),
    pk: pk.map((x) => x.n),
    rowsEstimate: Number(est?.r ?? 0) || 0,
    hasTriggers: Number(trg?.n ?? 0) > 0,
  };
}

/**
 * The target table for a source table: the same name, or else the one table
 * whose name differs only in case. A server with lower_case_table_names=1
 * (aaPanel's default, and Windows) stores "AppSettings" as "appsettings";
 * RDS and most Linux servers keep the case.
 */
export function matchTargetTable(source: string, targetNames: string[]): string | null {
  if (targetNames.includes(source)) return source;
  const same = targetNames.filter((t) => t.toLowerCase() === source.toLowerCase());
  return same.length === 1 ? same[0] : null;
}

/** Why the two tables can't be compared row by row, or null when they can. Column names are case-insensitive in MySQL. */
export function schemaMismatch(src: TableMeta, dst: TableMeta): string | null {
  const a = src.columns.map((c) => `${c.name.toLowerCase()} ${c.columnType}${c.nullable ? '' : ' NOT NULL'}`);
  const b = dst.columns.map((c) => `${c.name.toLowerCase()} ${c.columnType}${c.nullable ? '' : ' NOT NULL'}`);
  if (a.join('|') !== b.join('|')) {
    const onlyA = a.filter((x) => !b.includes(x));
    const onlyB = b.filter((x) => !a.includes(x));
    return `columns differ (source: ${onlyA.join(', ') || '-'}; target: ${onlyB.join(', ') || '-'})`;
  }
  if (src.pk.join(',').toLowerCase() !== dst.pk.join(',').toLowerCase()) return 'primary keys differ';
  return null;
}

/** Upper bounds (inclusive) of each chunk along the primary key, read from the source. */
async function* chunkBounds(c: mysql2.Connection, table: string, pk: string[], size: number): AsyncGenerator<{ lo: Bound; hi: Bound }> {
  const cols = pk.map(qid).join(', ');
  let lo: Bound = null;
  for (;;) {
    const w = rangeWhere(pk, lo, null);
    const r = await rows(c, `SELECT ${cols} FROM ${qid(table)} WHERE ${w.sql} ORDER BY ${cols} LIMIT 1 OFFSET ${size - 1}`, w.params);
    if (r.length === 0) {
      // Last chunk is open-ended: it also covers target rows past the source's last key
      yield { lo, hi: null };
      return;
    }
    const hi = pk.map((k) => r[0][k]);
    yield { lo, hi };
    lo = hi;
  }
}

async function chunkChecksum(c: mysql2.Connection, table: string, hash: string, where: { sql: string; params: unknown[] }) {
  const [r] = await rows<{ n: string | number; a: string | number; b: string | number }>(c,
    `SELECT COUNT(*) AS n,
            COALESCE(BIT_XOR(CAST(CONV(SUBSTRING(h, 1, 16), 16, 10) AS UNSIGNED)), 0) AS a,
            COALESCE(BIT_XOR(CAST(CONV(SUBSTRING(h, 17, 16), 16, 10) AS UNSIGNED)), 0) AS b
       FROM (SELECT ${hash} AS h FROM ${qid(table)} WHERE ${where.sql}) s`, where.params);
  return { n: Number(r.n), sum: `${r.n}:${r.a}:${r.b}` };
}

async function rowHashes(c: mysql2.Connection, table: string, pk: string[], hash: string, where: { sql: string; params: unknown[] }) {
  const cols = pk.map(qid).join(', ');
  const r = await rows(c, `SELECT ${cols}, ${hash} AS __h FROM ${qid(table)} WHERE ${where.sql} ORDER BY ${cols}`, where.params);
  const map = new Map<string, { key: unknown[]; h: string }>();
  for (const row of r) map.set(keyOf(row, pk), { key: pk.map((k) => row[k]), h: String(row.__h) });
  return map;
}

function keysIn(pk: string[], keys: unknown[][]): { sql: string; params: unknown[] } {
  if (pk.length === 1) return { sql: `${qid(pk[0])} IN (${keys.map(() => '?').join(', ')})`, params: keys.map((k) => k[0]) };
  const tuple = `(${pk.map(qid).join(', ')})`;
  const one = `(${pk.map(() => '?').join(', ')})`;
  return { sql: `${tuple} IN (${keys.map(() => one).join(', ')})`, params: keys.flat() };
}

const KEY_BATCH = 500;
/** Rows per INSERT, and a size cap so one statement stays well under max_allowed_packet */
const INSERT_BATCH = 500;
const INSERT_MAX_BYTES = 4 * 1024 * 1024;

function approxSize(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (Buffer.isBuffer(v)) return v.length * 2 + 4;
  return String(v).length + 4;
}

/** Apply one chunk's changes on the target in a transaction: delete changed/extra rows, insert the source rows. */
async function applyChunk(
  src: mysql2.Connection,
  dst: mysql2.Connection,
  srcTable: string,
  dstTable: string,
  meta: TableMeta,
  toDelete: unknown[][],
  toCopy: unknown[][],
): Promise<void> {
  const insertCols = meta.columns.filter((c) => !c.generated).map((c) => c.name);
  const colList = insertCols.map(qid).join(', ');
  await dst.beginTransaction();
  try {
    for (let i = 0; i < toDelete.length; i += KEY_BATCH) {
      const w = keysIn(meta.pk, toDelete.slice(i, i + KEY_BATCH));
      await dst.query(`DELETE FROM ${qid(dstTable)} WHERE ${w.sql}`, w.params);
    }
    for (let i = 0; i < toCopy.length; i += KEY_BATCH) {
      const w = keysIn(meta.pk, toCopy.slice(i, i + KEY_BATCH));
      const data = await rows(src, `SELECT ${colList} FROM ${qid(srcTable)} WHERE ${w.sql}`, w.params);
      let batch: unknown[][] = [];
      let bytes = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        const one = `(${insertCols.map(() => '?').join(', ')})`;
        await dst.query(`INSERT INTO ${qid(dstTable)} (${colList}) VALUES ${batch.map(() => one).join(', ')}`, batch.flat());
        batch = [];
        bytes = 0;
      };
      for (const row of data) {
        const values = insertCols.map((c) => row[c]);
        batch.push(values);
        bytes += values.reduce<number>((n, v) => n + approxSize(v), 0);
        if (batch.length >= INSERT_BATCH || bytes >= INSERT_MAX_BYTES) await flush();
      }
      await flush();
    }
    await dst.commit();
  } catch (err) {
    await dst.rollback().catch(() => undefined);
    throw err;
  }
}

const isDuplicateKey = (err: unknown) => (err as { errno?: number })?.errno === 1062;

export async function mysqlDataSync(
  sourceConfig: ConnectionConfig,
  targetConfig: ConnectionConfig,
  opts: DataSyncOptions,
): Promise<TableReport[]> {
  const size = Math.max(100, opts.chunkSize ?? 5000);
  const source = await open(sourceConfig);
  let target: MySQLConnectionResult | null = null;
  try {
    target = await open(targetConfig);
    const src = source.connection;
    const dst = target.connection;

    // Same text for TIMESTAMPs on both sides; the source is one consistent, read-only snapshot
    await src.query("SET SESSION time_zone = '+00:00'");
    await dst.query("SET SESSION time_zone = '+00:00'");
    await src.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await src.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    if (opts.apply) {
      // Rows go in table by table, not in dependency order; zero dates and id 0 as in the source
      await dst.query('SET SESSION foreign_key_checks = 0');
      await dst.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");
    }

    const srcTables = await tableNames(src);
    let dstTables = await tableNames(dst);
    // Table names typed by the user match regardless of case
    const wanted = opts.tables?.length ? new Set(opts.tables.map((t) => t.toLowerCase())) : null;
    const tables = srcTables.filter((t) => !wanted || wanted.has(t.toLowerCase()));
    const matchedTargets = new Set<string>();
    const reports: TableReport[] = [];
    let rowsChecked = 0;
    const estimates = await rows<{ t: string; r: string | number | null }>(src,
      "SELECT TABLE_NAME AS t, TABLE_ROWS AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    const rowsEstimate = estimates.filter((e) => tables.includes(e.t)).reduce((n, e) => n + (Number(e.r) || 0), 0);

    for (const [index, table] of tables.entries()) {
      if (opts.shouldStop?.()) throw new DataSyncStopped();
      opts.onProgress?.({ table, tableIndex: index, tableCount: tables.length, rowsChecked, rowsEstimate });
      const report: TableReport = { table, status: 'SAME', rows: 0, inserted: 0, updated: 0, deleted: 0, chunks: 0, chunksDifferent: 0 };
      try {
        const srcMeta = await tableMeta(src, table);
        let dstMeta: TableMeta;
        let dstTable = matchTargetTable(table, dstTables);
        if (dstTable) {
          matchedTargets.add(dstTable);
          if (dstTable !== table) report.targetTable = dstTable;
        }
        if (!dstTable) {
          if (!opts.apply) {
            report.status = 'ONLY_IN_SOURCE';
            report.rows = srcMeta.rowsEstimate;
            report.inserted = srcMeta.rowsEstimate;
            report.reason = 'missing on the target; syncing creates it';
            reports.push(report);
            opts.onTable?.(report);
            continue;
          }
          const [ddl] = await rows<Record<string, string>>(src, `SHOW CREATE TABLE ${qid(table)}`);
          await dst.query(ddl['Create Table']);
          // The target may have stored the name in lowercase
          dstTables = await tableNames(dst);
          dstTable = matchTargetTable(table, dstTables);
          if (!dstTable) throw new Error('the table was created on the target but cannot be found there');
          matchedTargets.add(dstTable);
          if (dstTable !== table) report.targetTable = dstTable;
          dstMeta = await tableMeta(dst, dstTable);
          report.status = 'CREATED';
        } else {
          dstMeta = await tableMeta(dst, dstTable);
        }
        const target = dstTable;
        const mismatch = schemaMismatch(srcMeta, dstMeta);
        if (mismatch) throw Object.assign(new Error(mismatch), { skip: true });
        if (srcMeta.pk.length === 0) throw Object.assign(new Error('no primary key, so rows cannot be matched'), { skip: true });
        if (opts.apply && dstMeta.hasTriggers) report.warning = 'the target table has triggers; they ran for every row written';

        const hash = rowHashExpr(srcMeta.columns);
        const deferred: { toDelete: unknown[][]; toCopy: unknown[][] }[] = [];
        for await (const { lo, hi } of chunkBounds(src, table, srcMeta.pk, size)) {
          if (opts.shouldStop?.()) throw new DataSyncStopped();
          const where = rangeWhere(srcMeta.pk, lo, hi);
          const [a, b] = await Promise.all([chunkChecksum(src, table, hash, where), chunkChecksum(dst, target, hash, where)]);
          report.chunks++;
          report.rows += a.n;
          rowsChecked += a.n;
          opts.onProgress?.({ table, tableIndex: index, tableCount: tables.length, rowsChecked, rowsEstimate });
          if (a.sum === b.sum) continue;

          report.chunksDifferent++;
          const [sm, dm] = await Promise.all([rowHashes(src, table, srcMeta.pk, hash, where), rowHashes(dst, target, srcMeta.pk, hash, where)]);
          const toCopy: unknown[][] = [];
          const toDelete: unknown[][] = [];
          for (const [k, s] of sm) {
            const d = dm.get(k);
            if (!d) { report.inserted++; toCopy.push(s.key); }
            else if (d.h !== s.h) { report.updated++; toCopy.push(s.key); toDelete.push(s.key); }
          }
          for (const [k, d] of dm) if (!sm.has(k)) { report.deleted++; toDelete.push(d.key); }
          if (!opts.apply) continue;
          try {
            await applyChunk(src, dst, table, target, srcMeta, toDelete, toCopy);
          } catch (err) {
            // A unique value that moved to a row in a later chunk: retry once the rest is done
            if (!isDuplicateKey(err)) throw err;
            deferred.push({ toDelete, toCopy });
          }
        }
        if (deferred.length) {
          // Unique values that moved between rows (even swapped): fixing one chunk at a time
          // collides with the other row's old value, so apply all of them in one transaction,
          // every delete first. Every other chunk of the table is already right by now.
          await applyChunk(
            src, dst, table, target, srcMeta,
            deferred.flatMap((d) => d.toDelete),
            deferred.flatMap((d) => d.toCopy),
          );
        }

        const changed = report.inserted + report.updated + report.deleted > 0;
        if (report.status !== 'CREATED') report.status = changed ? (opts.apply ? 'SYNCED' : 'DIFFERENT') : 'SAME';
      } catch (err) {
        if (err instanceof DataSyncStopped) throw err;
        report.status = (err as { skip?: boolean }).skip ? 'SKIPPED' : 'ERROR';
        report.reason = err instanceof Error ? err.message.slice(0, 500) : String(err);
      }
      reports.push(report);
      opts.onTable?.(report);
    }

    for (const t of dstTables) {
      const inSource = srcTables.some((x) => matchTargetTable(x, dstTables) === t);
      if (!matchedTargets.has(t) && !inSource && (!wanted || wanted.has(t.toLowerCase()))) {
        const r: TableReport = { table: t, status: 'ONLY_IN_TARGET', rows: 0, inserted: 0, updated: 0, deleted: 0, chunks: 0, chunksDifferent: 0, reason: 'not in the source; left as it is' };
        reports.push(r);
        opts.onTable?.(r);
      }
    }
    await src.query('COMMIT').catch(() => undefined);
    return reports;
  } finally {
    await source.connection.end().catch(() => undefined);
    source.tunnel?.close();
    if (target) {
      await target.connection.end().catch(() => undefined);
      target.tunnel?.close();
    }
  }
}
