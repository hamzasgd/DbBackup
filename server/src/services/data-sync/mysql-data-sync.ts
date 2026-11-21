import type * as mysql2 from 'mysql2/promise';
import { ConnectionFactory, type MySQLConnectionResult } from '../engines/connection-factory';
import type { ConnectionConfig } from '../engines/base.engine';

/**
 * Compare two MySQL/MariaDB databases with the same schema and copy only the
 * rows that differ, from source to target. Works with any provider: it only
 * needs to read the source and write the target over a normal connection.
 *
 * Per table, rows are split into chunks along the primary key. Each server
 * computes a checksum of every chunk itself, so only checksums cross the
 * network. For a chunk whose checksums differ, both sides list the primary
 * keys with a hash of each row; rows only in the source are inserted, rows
 * whose hash differs are replaced, rows only in the target are deleted. Only
 * those rows are read from the source.
 *
 * Several chunks are checked at once, each over its own pair of connections,
 * while another connection finds the next chunk boundaries ahead of them.
 * Every chunk is read as it is at that moment (no long-running snapshot, which
 * would hold back the source's undo purge for the whole run); rows that change
 * on the source during a run are picked up by the next one.
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
  /** How long the table took */
  ms?: number;
  /** QUICK: only rows changed since the last sync were compared; FULL: every row */
  method?: 'QUICK' | 'FULL';
  /** How the table was compared, when that's worth saying */
  note?: string;
}

export interface DataSyncProgress {
  table: string;
  tableIndex: number;
  tableCount: number;
  /** Source rows checked so far, over all tables */
  rowsChecked: number;
  /** Rough total of source rows: real counts for finished tables, table statistics for the rest */
  rowsEstimate: number;
}

export interface DataSyncOptions {
  /** false: compare only (nothing is written) */
  apply: boolean;
  /** Limit to these tables (empty = all) */
  tables?: string[];
  /** Rows per chunk (default 5000) */
  chunkSize?: number;
  /** Chunks checked at the same time, each with its own connections (default 4) */
  parallel?: number;
  onProgress?: (p: DataSyncProgress) => void;
  onTable?: (r: TableReport) => void;
  /** Checked between chunks; true stops the run */
  shouldStop?: () => boolean;
  /**
   * Quick mode: for big tables with an updatedAt column, compare only the rows
   * changed since `since` (UTC, 'YYYY-MM-DD HH:MM:SS'), plus new and deleted
   * rows found from the primary keys. Other tables are compared in full.
   */
  quick?: { since: string; minRows?: number };
  /** Called once connected, with the source server's clock (UTC): the "since" of the next quick run */
  onStart?: (info: { sourceTime: string }) => void;
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
  /** Columns that lead some index (lowercase) */
  leading: string[];
  /** Whether the table has an index besides the primary key */
  hasSecondary: boolean;
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

/**
 * WHERE clause for a chunk: (pk) > lo AND (pk) <= hi, either side open.
 * A multi-column key is spelled out as (a > ? OR (a = ? AND b > ?)): MySQL
 * reads a row comparison like (a, b) > (?, ?) by scanning the whole index from
 * the start, so every chunk would get slower the further into the table it is.
 */
export function rangeWhere(pk: string[], lo: Bound, hi: Bound): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const bound = (vals: unknown[], strict: '>' | '<', last: '>' | '<=') => {
    if (pk.length === 1) { params.push(vals[0]); return `${qid(pk[0])} ${last} ?`; }
    const nest = (i: number): string => {
      const col = qid(pk[i]);
      if (i === pk.length - 1) { params.push(vals[i]); return `${col} ${last} ?`; }
      params.push(vals[i], vals[i]);
      return `(${col} ${strict} ? OR (${col} = ? AND ${nest(i + 1)}))`;
    };
    // The leading column on its own lets the optimizer use a range scan
    params.push(vals[0]);
    return `${qid(pk[0])} ${strict}= ? AND ${nest(0)}`;
  };
  if (lo) conds.push(bound(lo, '>', '>'));
  if (hi) conds.push(bound(hi, '<', '<='));
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

/** Columns, primary key, row estimate and triggers of every table (or one), in four queries. */
async function loadMeta(c: mysql2.Connection, only?: string): Promise<Map<string, TableMeta>> {
  const one = only === undefined ? '' : ' AND TABLE_NAME = ?';
  const p = only === undefined ? [] : [only];
  const cols = await rows<{ t: string; n: string; dt: string; ct: string; nl: string; ex: string }>(c,
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS n, DATA_TYPE AS dt, COLUMN_TYPE AS ct, IS_NULLABLE AS nl, EXTRA AS ex
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()${one} ORDER BY TABLE_NAME, ORDINAL_POSITION`, p);
  const idx = await rows<{ t: string; i: string; q: string | number; n: string }>(c,
    `SELECT TABLE_NAME AS t, INDEX_NAME AS i, SEQ_IN_INDEX AS q, COLUMN_NAME AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()${one} ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`, p);
  const est = await rows<{ t: string; r: string | number | null }>(c,
    `SELECT TABLE_NAME AS t, TABLE_ROWS AS r FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()${one} AND TABLE_TYPE = 'BASE TABLE'`, p);
  const trg = await rows<{ t: string; n: string | number }>(c,
    `SELECT EVENT_OBJECT_TABLE AS t, COUNT(*) AS n FROM information_schema.TRIGGERS
      WHERE EVENT_OBJECT_SCHEMA = DATABASE()${one.replace('TABLE_NAME', 'EVENT_OBJECT_TABLE')} GROUP BY EVENT_OBJECT_TABLE`, p);
  const meta = new Map<string, TableMeta>();
  for (const e of est) meta.set(e.t, { columns: [], pk: [], rowsEstimate: Number(e.r ?? 0) || 0, hasTriggers: false, leading: [], hasSecondary: false });
  for (const x of cols) {
    meta.get(x.t)?.columns.push({
      name: x.n,
      dataType: String(x.dt).toLowerCase(),
      columnType: normalizeColumnType(String(x.ct)),
      nullable: x.nl === 'YES',
      // Computed columns only. MySQL 8 also marks plain defaults like DEFAULT CURRENT_TIMESTAMP
      // (Prisma's @default(now())) as "DEFAULT_GENERATED": those hold real data and must be copied.
      generated: /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b|^(VIRTUAL|PERSISTENT)$/i.test(String(x.ex ?? '').trim()),
    });
  }
  for (const x of idx) {
    const m = meta.get(x.t);
    if (!m) continue;
    if (x.i === 'PRIMARY') m.pk.push(x.n);
    else m.hasSecondary = true;
    if (Number(x.q) === 1) m.leading.push(String(x.n).toLowerCase());
  }
  for (const x of trg) { const m = meta.get(x.t); if (m) m.hasTriggers = Number(x.n) > 0; }
  return meta;
}

async function tableMeta(c: mysql2.Connection, table: string): Promise<TableMeta> {
  const m = (await loadMeta(c, table)).get(table);
  if (!m) throw new Error(`table ${table} not found`);
  return m;
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

type Query = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Upper bounds (inclusive) of each chunk along the primary key, read from the source. */
async function* chunkBounds(query: Query, table: string, pk: string[], size: number): AsyncGenerator<{ lo: Bound; hi: Bound }> {
  const cols = pk.map(qid).join(', ');
  let lo: Bound = null;
  for (;;) {
    const w = rangeWhere(pk, lo, null);
    const r = await query(`SELECT ${cols} FROM ${qid(table)} WHERE ${w.sql} ORDER BY ${cols} LIMIT 1 OFFSET ${size - 1}`, w.params);
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

/**
 * Pull items from a generator while keeping up to `ahead` requested in
 * advance, so the next chunk boundaries are found while chunks are checked.
 */
function prefetch<T>(gen: AsyncGenerator<T>, ahead: number): () => Promise<T | undefined> {
  const buf: Promise<IteratorResult<T>>[] = [];
  let ended = false;
  const fill = () => {
    while (!ended && buf.length < ahead) {
      const p = gen.next();
      p.then((r) => { if (r.done) ended = true; }, () => { ended = true; });
      buf.push(p);
    }
  };
  return async () => {
    fill();
    const p = buf.shift();
    if (!p) return undefined;
    const r = await p;
    fill();
    return r.done ? undefined : r.value;
  };
}

/**
 * Row count and a 64-bit checksum of a chunk: the XOR of the first half of each
 * row's MD5. Each row is hashed once; a derived table with both halves would be
 * merged by the optimizer and hash every row twice.
 */
async function chunkChecksum(c: mysql2.Connection, table: string, hash: string, where: { sql: string; params: unknown[] }) {
  const [r] = await rows<{ n: string | number; a: string | number }>(c,
    `SELECT COUNT(*) AS n, COALESCE(BIT_XOR(CAST(CONV(SUBSTRING(${hash}, 1, 16), 16, 10) AS UNSIGNED)), 0) AS a
       FROM ${qid(table)} WHERE ${where.sql}`, where.params);
  return { n: Number(r.n), sum: `${r.n}:${r.a}` };
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

// Another chunk still holds the old row with this unique value, or two chunks locked each other
const isDeferrable = (err: unknown) => [1062, 1205, 1213].includes((err as { errno?: number })?.errno ?? 0);

const LOST_CODES = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ER_CLIENT_INTERACTION_TIMEOUT']);
/** The connection itself broke (not an SQL error): worth reconnecting and trying again */
const isConnectionLost = (err: unknown) => {
  const e = err as { fatal?: boolean; code?: string } | null;
  return !!e && (e.fatal === true || LOST_CODES.has(e.code ?? ''));
};

/** One connection, reopened (with its session settings) after it breaks. */
class Session {
  private res: MySQLConnectionResult | null = null;
  constructor(private readonly config: ConnectionConfig, private readonly init: string[]) {}

  get c(): mysql2.Connection {
    if (!this.res) throw Object.assign(new Error('not connected'), { fatal: true });
    return this.res.connection;
  }

  async open(): Promise<void> {
    await this.close();
    const r = await open(this.config);
    // A broken idle connection emits 'error'; the next query reports it instead
    r.connection.on('error', () => undefined);
    this.res = r;
    for (const sql of this.init) await r.connection.query(sql);
  }

  async close(): Promise<void> {
    const r = this.res;
    this.res = null;
    if (!r) return;
    await r.connection.end().catch(() => r.connection.destroy());
    r.tunnel?.close();
  }

  /** A read that is safe to repeat: retried once on a fresh connection */
  query: Query = async (sql, params = []) => {
    try {
      return await rows(this.c, sql, params);
    } catch (err) {
      if (!isConnectionLost(err)) throw err;
      await this.open();
      return rows(this.c, sql, params);
    }
  };
}

/** Run fn; when a connection broke, reopen these sessions and run it once more. */
async function withReconnect<T>(sessions: Session[], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isConnectionLost(err)) throw err;
    for (const s of sessions) await s.open();
    return fn();
  }
}

interface Pair { src: Session; dst: Session }

interface ChunkResult {
  rows: number;
  inserted: number;
  updated: number;
  deleted: number;
  different: boolean;
  deferred?: { toDelete: unknown[][]; toCopy: unknown[][] };
}

interface TableJob {
  table: string;
  dstTable: string;
  meta: TableMeta;
  hash: string;
  apply: boolean;
  /** Whether each recent chunk differed (newest last) */
  recent: boolean[];
}

const RECENT_CHUNKS = 20;
/**
 * When most recent chunks of a table differ (rows changed all over it), a
 * chunk checksum almost never says "same" and only adds a second pass over the
 * rows on both servers: compare row hashes straight away instead.
 */
function skipChecksum(job: TableJob): boolean {
  if (job.recent.length < RECENT_CHUNKS / 2) return false;
  return job.recent.filter(Boolean).length >= job.recent.length * 0.75;
}

/** Compare one chunk on both sides and, when applying, copy its differences. Safe to run again. */
async function checkChunk(pair: Pair, job: TableJob, lo: Bound, hi: Bound): Promise<ChunkResult> {
  const { table, dstTable, meta, hash } = job;
  const where = rangeWhere(meta.pk, lo, hi);
  const out: ChunkResult = { rows: 0, inserted: 0, updated: 0, deleted: 0, different: true };
  if (!skipChecksum(job)) {
    const [a, b] = await Promise.all([chunkChecksum(pair.src.c, table, hash, where), chunkChecksum(pair.dst.c, dstTable, hash, where)]);
    out.rows = a.n;
    out.different = a.sum !== b.sum;
    if (!out.different) return out;
  }

  const [sm, dm] = await Promise.all([rowHashes(pair.src.c, table, meta.pk, hash, where), rowHashes(pair.dst.c, dstTable, meta.pk, hash, where)]);
  out.rows = sm.size;
  const toCopy: unknown[][] = [];
  const toDelete: unknown[][] = [];
  for (const [k, s] of sm) {
    const d = dm.get(k);
    if (!d) { out.inserted++; toCopy.push(s.key); }
    else if (d.h !== s.h) { out.updated++; toCopy.push(s.key); toDelete.push(s.key); }
  }
  for (const [k, d] of dm) if (!sm.has(k)) { out.deleted++; toDelete.push(d.key); }
  out.different = toCopy.length > 0 || toDelete.length > 0;
  if (!job.apply || (toCopy.length === 0 && toDelete.length === 0)) return out;
  try {
    await applyChunk(pair.src.c, pair.dst.c, table, dstTable, meta, toDelete, toCopy);
  } catch (err) {
    // A unique value that moved to a row in another chunk: retried once the rest of the table is done
    if (!isDeferrable(err)) throw err;
    out.deferred = { toDelete, toCopy };
  }
  return out;
}

const UPDATED_AT = /^updated_?at$/i;
const INT_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint']);
/** Changed rows read per page in quick mode */
const QUICK_PAGE = 5000;
/** Groups the key range is split into when looking for new and deleted rows */
const KEY_BUCKETS = 2000;

/** The table's last-modified column, if it has one */
export function updatedAtColumn(meta: { columns: Column[] }): Column | undefined {
  return meta.columns.find((c) => UPDATED_AT.test(c.name) && (c.dataType === 'datetime' || c.dataType === 'timestamp'));
}

const hasIntKey = (meta: TableMeta) =>
  meta.pk.length === 1 && INT_TYPES.has(meta.columns.find((c) => c.name.toLowerCase() === meta.pk[0].toLowerCase())?.dataType ?? '');

interface QuickResult { rows: number; inserted: number; updated: number; deleted: number; batches: number; batchesDifferent: number }

/**
 * Quick compare of one table: rows changed since `since` (by their updatedAt),
 * then new and deleted rows. With a whole-number primary key, both sides
 * summarise their keys in ~2000 ranges from an index, and only ranges whose
 * summaries differ are listed. Other keys compare row counts. Returns null
 * when the table has to be compared in full instead (the counts differ).
 */
async function quickTable(
  pair: Pair,
  job: TableJob,
  upd: Column,
  since: string,
  onRows: (n: number) => void,
  shouldStop: () => boolean,
): Promise<QuickResult | null> {
  const { table, dstTable, meta, hash } = job;
  const pk = meta.pk;
  const out: QuickResult = { rows: 0, inserted: 0, updated: 0, deleted: 0, batches: 0, batchesDifferent: 0 };
  const deferred: { toDelete: unknown[][]; toCopy: unknown[][] }[] = [];
  /** Rows found missing on the target (compare only: not counted twice) */
  const missing = new Set<string>();
  const apply = async (toDelete: unknown[][], toCopy: unknown[][]) => {
    if (!job.apply || (toDelete.length === 0 && toCopy.length === 0)) return;
    try {
      await applyChunk(pair.src.c, pair.dst.c, table, dstTable, meta, toDelete, toCopy);
    } catch (err) {
      if (!isDeferrable(err)) throw err;
      deferred.push({ toDelete, toCopy });
    }
  };

  // 1. Rows changed since the last sync. With an index on updatedAt, pages follow it in
  // (updatedAt, key) order. Without one, every such page would scan the whole table again,
  // so walk the table once in key order instead, keeping only the changed rows.
  const indexed = meta.leading.includes(upd.name.toLowerCase());
  const order = indexed ? [upd.name, ...pk] : pk;
  const cols = [...new Set([upd.name, ...order])].map(qid).join(', ');
  const orderBy = order.map(qid).join(', ');
  let lo: unknown[] | null = null;
  for (;;) {
    if (shouldStop()) throw new DataSyncStopped();
    const w = rangeWhere(order, lo, null);
    const page = await rows(pair.src.c,
      `SELECT ${cols}, ${hash} AS __h FROM ${qid(table)} WHERE ${qid(upd.name)} >= ? AND ${w.sql} ORDER BY ${orderBy} LIMIT ${QUICK_PAGE}`,
      [since, ...w.params]);
    if (page.length === 0) break;
    lo = order.map((k) => page[page.length - 1][k]);
    const keys = page.map((r) => pk.map((k) => r[k]));
    const dm = new Map<string, string>();
    for (let i = 0; i < keys.length; i += KEY_BATCH) {
      for (const [k, v] of await rowHashes(pair.dst.c, dstTable, pk, hash, keysIn(pk, keys.slice(i, i + KEY_BATCH)))) dm.set(k, v.h);
    }
    const toCopy: unknown[][] = [];
    const toDelete: unknown[][] = [];
    for (const [i, r] of page.entries()) {
      const k = keyOf(r, pk);
      const d = dm.get(k);
      if (d === undefined) { out.inserted++; toCopy.push(keys[i]); missing.add(k); }
      else if (d !== String(r.__h)) { out.updated++; toCopy.push(keys[i]); toDelete.push(keys[i]); }
    }
    out.batches++;
    if (toCopy.length) out.batchesDifferent++;
    out.rows += page.length;
    onRows(page.length);
    await apply(toDelete, toCopy);
    if (page.length < QUICK_PAGE) break;
  }

  // 2. New and deleted rows (also ones whose updatedAt wasn't touched)
  if (hasIntKey(meta)) {
    const key = qid(pk[0]);
    const [a] = await rows<{ lo: string | null; hi: string | null }>(pair.src.c, `SELECT MIN(${key}) AS lo, MAX(${key}) AS hi FROM ${qid(table)}`);
    const [b] = await rows<{ lo: string | null; hi: string | null }>(pair.dst.c, `SELECT MIN(${key}) AS lo, MAX(${key}) AS hi FROM ${qid(dstTable)}`);
    const ends = [a.lo, a.hi, b.lo, b.hi].filter((v): v is string => v !== null && v !== undefined).map((v) => BigInt(v));
    if (ends.length) {
      const min = ends.reduce((x, y) => (y < x ? y : x));
      const max = ends.reduce((x, y) => (y > x ? y : x));
      const width = (max - min) / BigInt(KEY_BUCKETS) + 1n;
      const summary = async (c: mysql2.Connection, t: string) => {
        const r = await rows<{ b: string | number; n: string | number; x: string | number }>(c,
          `SELECT FLOOR((${key} - ?) / ?) AS b, COUNT(*) AS n, BIT_XOR(CRC32(${key})) AS x FROM ${qid(t)} GROUP BY b`,
          [min.toString(), width.toString()]);
        return new Map(r.map((x) => [String(x.b), `${x.n}:${x.x}`]));
      };
      const [sb, db] = await Promise.all([summary(pair.src.c, table), summary(pair.dst.c, dstTable)]);
      const differ = [...new Set([...sb.keys(), ...db.keys()])].filter((b) => sb.get(b) !== db.get(b));
      for (const bucket of differ) {
        if (shouldStop()) throw new DataSyncStopped();
        const from = min + BigInt(bucket) * width;
        const range = { sql: `${key} >= ? AND ${key} < ?`, params: [from.toString(), (from + width).toString()] };
        const list = async (c: mysql2.Connection, t: string) =>
          new Map((await rows(c, `SELECT ${key} FROM ${qid(t)} WHERE ${range.sql}`, range.params)).map((r) => [keyOf(r, pk), [r[pk[0]]]]));
        const [sk, dk] = await Promise.all([list(pair.src.c, table), list(pair.dst.c, dstTable)]);
        const toCopy: unknown[][] = [];
        const toDelete: unknown[][] = [];
        for (const [k, v] of sk) if (!dk.has(k) && !missing.has(k)) { out.inserted++; toCopy.push(v); }
        for (const [k, v] of dk) if (!sk.has(k)) { out.deleted++; toDelete.push(v); }
        out.batches++;
        if (toCopy.length || toDelete.length) out.batchesDifferent++;
        await apply(toDelete, toCopy);
      }
    }
  } else {
    // Without a whole-number key: equal row counts mean nothing was added or deleted
    const count = async (c: mysql2.Connection, t: string) => Number((await rows<{ n: string | number }>(c, `SELECT COUNT(*) AS n FROM ${qid(t)}`))[0].n);
    const [n, m] = await Promise.all([count(pair.src.c, table), count(pair.dst.c, dstTable)]);
    if (n !== m + (job.apply ? 0 : missing.size)) return null;
  }

  if (deferred.length) {
    await applyChunk(pair.src.c, pair.dst.c, table, dstTable, meta, deferred.flatMap((d) => d.toDelete), deferred.flatMap((d) => d.toCopy));
  }
  return out;
}

export async function mysqlDataSync(
  sourceConfig: ConnectionConfig,
  targetConfig: ConnectionConfig,
  opts: DataSyncOptions,
): Promise<TableReport[]> {
  const size = Math.max(100, opts.chunkSize ?? 5000);
  const parallel = Math.min(16, Math.max(1, Math.floor(opts.parallel ?? 4)));
  // Same text for TIMESTAMPs on both sides. The source is only read, and so is the target when comparing.
  const srcInit = ["SET SESSION time_zone = '+00:00'", 'SET SESSION TRANSACTION READ ONLY'];
  const dstInit = opts.apply
    // Rows go in table by table, not in dependency order; zero dates and id 0 as in the source
    ? ["SET SESSION time_zone = '+00:00'", 'SET SESSION foreign_key_checks = 0', "SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'"]
    : ["SET SESSION time_zone = '+00:00'", 'SET SESSION TRANSACTION READ ONLY'];

  // Control connections (lists, metadata, chunk boundaries, CREATE TABLE) and one pair per parallel worker
  const ctlSrc = new Session(sourceConfig, srcInit);
  const ctlDst = new Session(targetConfig, dstInit);
  const pairs: Pair[] = Array.from({ length: parallel }, () => ({ src: new Session(sourceConfig, srcInit), dst: new Session(targetConfig, dstInit) }));
  const all = [ctlSrc, ctlDst, ...pairs.flatMap((p) => [p.src, p.dst])];
  try {
    // One connection at a time per server (an SSH jump host may refuse many handshakes at once)
    await Promise.all([
      (async () => { for (const s of [ctlSrc, ...pairs.map((p) => p.src)]) await s.open(); })(),
      (async () => { for (const s of [ctlDst, ...pairs.map((p) => p.dst)]) await s.open(); })(),
    ]);

    // The source's own clock: the next quick run looks for changes from here on
    const [clock] = await ctlSrc.query<{ t: string }>('SELECT UTC_TIMESTAMP(3) AS t');
    opts.onStart?.({ sourceTime: String(clock.t) });

    const srcTables = await tableNames(ctlSrc.c);
    let dstTables = await tableNames(ctlDst.c);
    const [srcMetaAll, dstMetaAll] = await Promise.all([loadMeta(ctlSrc.c), loadMeta(ctlDst.c)]);
    // Table names typed by the user match regardless of case
    const wanted = opts.tables?.length ? new Set(opts.tables.map((t) => t.toLowerCase())) : null;
    const tables = srcTables.filter((t) => !wanted || wanted.has(t.toLowerCase()));
    const matchedTargets = new Set<string>();
    const reports: TableReport[] = [];

    // Progress: real row counts for finished tables, statistics for the rest (they can be far off)
    let rowsChecked = 0;
    const quick = opts.quick ?? null;
    const quickMinRows = quick?.minRows ?? 100_000;
    // Big tables with an updatedAt column are compared quickly; the estimate only covers the rest
    const quickable = (m: TableMeta | undefined) => !!quick && !!m && m.rowsEstimate >= quickMinRows && !!updatedAtColumn(m) && m.pk.length > 0;
    const fullEstimate = (t: string) => (quickable(srcMetaAll.get(t)) ? 0 : srcMetaAll.get(t)?.rowsEstimate ?? 0);
    let remainingEstimate = tables.reduce((n, t) => n + fullEstimate(t), 0);
    let current = { table: '', index: 0, rows: 0, estimate: 0 };
    const progress = () => opts.onProgress?.({
      table: current.table,
      tableIndex: current.index,
      tableCount: tables.length,
      rowsChecked,
      rowsEstimate: rowsChecked - current.rows + Math.max(current.estimate, current.rows) + remainingEstimate,
    });

    for (const [index, table] of tables.entries()) {
      if (opts.shouldStop?.()) throw new DataSyncStopped();
      const srcMeta = srcMetaAll.get(table) ?? await tableMeta(ctlSrc.c, table);
      remainingEstimate -= fullEstimate(table);
      current = { table, index, rows: 0, estimate: fullEstimate(table) };
      progress();
      const started = Date.now();
      const report: TableReport = { table, status: 'SAME', rows: 0, inserted: 0, updated: 0, deleted: 0, chunks: 0, chunksDifferent: 0 };
      try {
        let dstTable = matchTargetTable(table, dstTables);
        if (dstTable) {
          matchedTargets.add(dstTable);
          if (dstTable !== table) report.targetTable = dstTable;
        }
        let dstMeta: TableMeta;
        if (!dstTable) {
          if (!opts.apply) {
            report.status = 'ONLY_IN_SOURCE';
            report.rows = srcMeta.rowsEstimate;
            report.inserted = srcMeta.rowsEstimate;
            report.reason = 'missing on the target; syncing creates it';
            throw Object.assign(new Error(report.reason), { done: true });
          }
          const [ddl] = await ctlSrc.query<Record<string, string>>(`SHOW CREATE TABLE ${qid(table)}`);
          await ctlDst.c.query(ddl['Create Table']);
          // The target may have stored the name in lowercase
          dstTables = await tableNames(ctlDst.c);
          dstTable = matchTargetTable(table, dstTables);
          if (!dstTable) throw new Error('the table was created on the target but cannot be found there');
          matchedTargets.add(dstTable);
          if (dstTable !== table) report.targetTable = dstTable;
          dstMeta = await tableMeta(ctlDst.c, dstTable);
          report.status = 'CREATED';
        } else {
          dstMeta = dstMetaAll.get(dstTable) ?? await tableMeta(ctlDst.c, dstTable);
        }
        const mismatch = schemaMismatch(srcMeta, dstMeta);
        if (mismatch) throw Object.assign(new Error(mismatch), { skip: true });
        if (srcMeta.pk.length === 0) throw Object.assign(new Error('no primary key, so rows cannot be matched'), { skip: true });
        if (opts.apply && dstMeta.hasTriggers) report.warning = 'the target table has triggers; they ran for every row written';

        const job: TableJob = { table, dstTable, meta: srcMeta, hash: rowHashExpr(srcMeta.columns), apply: opts.apply, recent: [] };
        const upd = updatedAtColumn(srcMeta);
        if (quick && report.status !== 'CREATED' && quickable(srcMeta) && upd) {
          const pair = pairs[0];
          const q = await withReconnect([pair.src, pair.dst], () => quickTable(pair, job, upd, quick.since,
            (n) => { rowsChecked += n; current.rows += n; progress(); },
            () => !!opts.shouldStop?.()));
          if (q) {
            report.method = 'QUICK';
            report.rows = q.rows;
            report.inserted = q.inserted;
            report.updated = q.updated;
            report.deleted = q.deleted;
            report.chunks = q.batches;
            report.chunksDifferent = q.batchesDifferent;
            const notes = [`only rows changed since ${quick.since.slice(0, 16)} UTC`];
            if (!srcMeta.leading.includes(upd.name.toLowerCase())) notes.push(`no index on ${upd.name}, so finding them read the whole table; adding one makes this fast`);
            else if (hasIntKey(srcMeta) && !srcMeta.hasSecondary) notes.push('no secondary index, so checking for new and deleted rows read the whole table');
            report.note = notes.join('; ');
            const changed = report.inserted + report.updated + report.deleted > 0;
            report.status = changed ? (opts.apply ? 'SYNCED' : 'DIFFERENT') : 'SAME';
            throw Object.assign(new Error('quick'), { done: true });
          }
          // Row counts differ: compare it in full
          rowsChecked -= current.rows;
          current.rows = 0;
          report.note = 'row counts differed, so compared in full';
        } else if (quick && srcMeta.rowsEstimate >= quickMinRows && !upd) {
          report.note = 'no updatedAt column, so compared in full';
        }
        report.method = 'FULL';
        const bounds = chunkBounds(ctlSrc.query, table, srcMeta.pk, size);
        const next = prefetch(bounds, parallel * 2);
        const deferred: { toDelete: unknown[][]; toCopy: unknown[][] }[] = [];
        let failure: unknown = null;
        await Promise.all(pairs.map(async (pair) => {
          while (failure === null) {
            if (opts.shouldStop?.()) { failure = new DataSyncStopped(); return; }
            try {
              const b = await next();
              if (!b || failure !== null) return;
              const r = await withReconnect([pair.src, pair.dst], () => checkChunk(pair, job, b.lo, b.hi));
              report.chunks++;
              report.rows += r.rows;
              report.inserted += r.inserted;
              report.updated += r.updated;
              report.deleted += r.deleted;
              if (r.different) report.chunksDifferent++;
              job.recent.push(r.different);
              if (job.recent.length > RECENT_CHUNKS) job.recent.shift();
              if (r.deferred) deferred.push(r.deferred);
              rowsChecked += r.rows;
              current.rows += r.rows;
              progress();
            } catch (err) {
              if (failure === null) failure = err;
              return;
            }
          }
        }));
        await bounds.return(undefined).catch(() => undefined);
        if (failure !== null) throw failure;

        if (deferred.length) {
          // Unique values that moved between rows (even swapped): fixing one chunk at a time
          // collides with the other row's old value, so apply all of them in one transaction,
          // every delete first. Every other chunk of the table is already right by now.
          const pair = pairs[0];
          await withReconnect([pair.src, pair.dst], () => applyChunk(
            pair.src.c, pair.dst.c, table, job.dstTable, srcMeta,
            deferred.flatMap((d) => d.toDelete),
            deferred.flatMap((d) => d.toCopy),
          ));
        }

        const changed = report.inserted + report.updated + report.deleted > 0;
        if (report.status !== 'CREATED') report.status = changed ? (opts.apply ? 'SYNCED' : 'DIFFERENT') : 'SAME';
      } catch (err) {
        if (err instanceof DataSyncStopped) throw err;
        if (!(err as { done?: boolean }).done) {
          report.status = (err as { skip?: boolean }).skip ? 'SKIPPED' : 'ERROR';
          report.reason = err instanceof Error ? err.message.slice(0, 500) : String(err);
        }
      }
      // Counted rows replace the estimate for this table
      current = { table, index, rows: 0, estimate: 0 };
      report.ms = Date.now() - started;
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
    return reports;
  } finally {
    await Promise.all(all.map((s) => s.close().catch(() => undefined)));
  }
}
