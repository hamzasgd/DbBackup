import type * as mysql2 from 'mysql2/promise';
import type ZongJi from '@vlasky/zongji';
import type { AnyBinlogEvent, QueryEvent, TableMapEvent, RowData, UpdateRowData } from '@vlasky/zongji';
import { ConnectionFactory, type MySQLConnectionResult } from '../engines/connection-factory';
import type { ConnectionConfig } from '../engines/base.engine';
import { EXACT, qid, loadMeta, tableNames, matchTargetTable, type TableMeta } from './mysql-data-sync';
import { compareMysqlSchema, applyMysqlSchema } from './mysql-schema';

/**
 * Live sync: follow the source's binary log (the record MySQL keeps of every
 * row it inserts, changes or deletes) and apply each change to the target, in
 * the same order, one source transaction per target transaction. This is how
 * MySQL's own replicas work; it reads nothing from the tables themselves.
 *
 * Changes are applied by primary key: an insert or update writes the row's new
 * image (REPLACE), a delete removes the key. Applying the same change twice
 * gives the same result, so after a restart it simply continues from the last
 * position saved, even if a few changes were applied already.
 *
 * The source needs binlog_format=ROW and binlog_row_image=FULL (AWS RDS's
 * defaults) and a user with REPLICATION SLAVE and REPLICATION CLIENT.
 */

export interface BinlogPosition {
  file: string;
  pos: number;
}

export type LiveErrorKind =
  /** Needs the user: privileges, server settings, unsupported data */
  | 'CONFIG'
  /** The saved position can't be continued from (log purged, schema changed meanwhile): catch up with a sync, then follow again */
  | 'RESYNC'
  /** A change could not be applied to the target */
  | 'APPLY'
  /** Connection trouble: try again */
  | 'TRANSIENT';

export class LiveSyncError extends Error {
  constructor(message: string, readonly kind: LiveErrorKind) {
    super(message);
  }
}

export interface SourceCheck {
  position: BinlogPosition;
  /** Live sync can't run until these are fixed */
  problems: string[];
  /** It runs, but worth knowing */
  warnings: string[];
}

export interface LiveProgress {
  /** Where to continue from: everything before it is applied */
  position: BinlogPosition;
  /** Source time of the change just applied (null: only the position moved) */
  eventAt: Date | null;
  inserted: number;
  updated: number;
  deleted: number;
  transactions: number;
}

export interface LiveStreamOptions {
  /** Replica id used on the source; unique among the source's replicas */
  serverId: number;
  start: BinlogPosition;
  onProgress: (p: LiveProgress) => void;
  /** Something worth showing (a table not copied, a schema change seen) */
  onNote?: (note: string) => void;
}

export interface LiveStream {
  /** Resolves when stopped, rejects with a LiveSyncError when it can't go on */
  done: Promise<void>;
  stop(): Promise<void>;
  /** The end of the source's binary log right now */
  head(): Promise<BinlogPosition>;
  /** When the last event arrived from the source (ms) */
  lastEventMs(): number;
  /** Changes received but not applied yet */
  pending(): number;
}

// The package is ESM only. tsc (CommonJS output) turns import() into require(), which older
// Node versions refuse for ESM, so the built app imports it natively; test runners that load
// code in their own sandbox (no native import there) take the transformed import instead.
const nativeImport = new Function('s', 'return import(s)') as (s: string) => Promise<unknown>;
async function loadZongJi(): Promise<{ default: typeof ZongJi }> {
  try {
    return await nativeImport('@vlasky/zongji') as { default: typeof ZongJi };
  } catch (err) {
    if (!/dynamic import callback/i.test(messageOf(err))) throw err;
    return import('@vlasky/zongji');
  }
}

const errno = (err: unknown) => (err as { errno?: number })?.errno ?? 0;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

const PRIVILEGE_HELP = 'The source user needs the REPLICATION SLAVE and REPLICATION CLIENT privileges, e.g. '
  + "GRANT REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'user'@'%'; (the RDS master user has them).";

/** Turn a source-side error into a LiveSyncError */
export function classifySourceError(err: unknown): LiveSyncError {
  if (err instanceof LiveSyncError) return err;
  const n = errno(err);
  const msg = messageOf(err);
  if ([1227, 1044, 1045, 1142, 1370].includes(n) || /REPLICATION (SLAVE|CLIENT)|access denied/i.test(msg)) {
    return new LiveSyncError(`${msg}. ${PRIVILEGE_HELP}`, 'CONFIG');
  }
  // 1236: the binary log file we stopped at was purged (or the position is invalid)
  if (n === 1236 || /could not find first log file|binary log.*purged|log event entry exceeded/i.test(msg)) {
    return new LiveSyncError(`The source no longer has the binary log where Live sync stopped (${msg})`, 'RESYNC');
  }
  if (/binlog_transaction_compression|PARTIAL_JSON|binlog_row_value_options/i.test(msg)) {
    return new LiveSyncError(msg, 'CONFIG');
  }
  return new LiveSyncError(msg, 'TRANSIENT');
}

async function rows<T = Record<string, unknown>>(c: mysql2.Connection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await c.query(sql, params);
  return r as T[];
}

/** The end of the source's binary log: the position a new follower starts from */
export async function binlogHead(c: mysql2.Connection): Promise<BinlogPosition> {
  // MySQL 8.2+ renamed SHOW MASTER STATUS (and 8.4 removed it); MariaDB has both
  for (const sql of ['SHOW BINARY LOG STATUS', 'SHOW MASTER STATUS']) {
    let r: { File?: string; Position?: number | string }[];
    try {
      r = await rows(c, sql);
    } catch (err) {
      if (errno(err) === 1064) continue; // syntax: not this server's spelling
      throw classifySourceError(err);
    }
    if (!r[0]?.File) throw new LiveSyncError('Binary logging is off on the source', 'CONFIG');
    return { file: String(r[0].File), pos: Number(r[0].Position) };
  }
  throw new LiveSyncError('The source does not report its binary log position', 'CONFIG');
}

/** ENUM/SET values with commas or quotes: the binary log reader can't tell them apart reliably */
export function ambiguousEnumValues(columnType: string): string[] {
  const m = /^(enum|set)\((.*)\)$/i.exec(columnType.trim());
  if (!m) return [];
  const values = [...m[2].matchAll(/'((?:[^'\\]|''|\\.)*)'/g)].map((x) => x[1]);
  return values.filter((v) => v.includes(',') || v.includes("''") || v.includes("\\'"));
}

/**
 * Whether the source can be followed, and from where. Reads server settings
 * and table definitions only.
 */
export async function checkLiveSource(config: ConnectionConfig): Promise<SourceCheck> {
  const { connection, tunnel } = await ConnectionFactory.createMySQLConnection(config, { connectTimeout: 20_000 });
  try {
    const problems: string[] = [];
    const warnings: string[] = [];
    const vars = Object.fromEntries((await rows<{ Variable_name: string; Value: string }>(connection,
      `SHOW GLOBAL VARIABLES WHERE Variable_name IN
        ('log_bin','binlog_format','binlog_row_image','binlog_row_metadata','binlog_row_value_options','binlog_transaction_compression')`))
      .map((v) => [v.Variable_name, String(v.Value ?? '')]));
    const on = (v?: string) => /^(ON|1)$/i.test(v ?? '');
    if (!on(vars.log_bin)) {
      problems.push('Binary logging is off on the source. On AWS RDS it is on while automated backups are enabled.');
    }
    if (vars.binlog_format && vars.binlog_format.toUpperCase() !== 'ROW') {
      problems.push(`binlog_format is ${vars.binlog_format}; Live sync needs ROW (on RDS: the parameter group).`);
    }
    if (vars.binlog_row_image && vars.binlog_row_image.toUpperCase() !== 'FULL') {
      problems.push(`binlog_row_image is ${vars.binlog_row_image}; Live sync needs FULL (on RDS: the parameter group).`);
    }
    if (/PARTIAL_JSON/i.test(vars.binlog_row_value_options ?? '')) {
      problems.push('binlog_row_value_options is PARTIAL_JSON; Live sync needs it empty (on RDS: the parameter group).');
    }
    if (on(vars.binlog_transaction_compression)) {
      problems.push('binlog_transaction_compression is ON; Live sync needs it OFF (on RDS: the parameter group).');
    }
    if (vars.binlog_row_metadata !== undefined && vars.binlog_row_metadata.toUpperCase() !== 'FULL') {
      warnings.push('Recommended: set binlog_row_metadata=FULL in the source\'s settings (RDS parameter group, no restart). '
        + 'Then a column added on the source while Live sync is behind is always read right; without it Live sync catches up with a sync instead.');
    }

    let position: BinlogPosition = { file: '', pos: 0 };
    if (problems.length === 0) {
      try {
        position = await binlogHead(connection);
        await rows(connection, 'SHOW BINARY LOGS');
      } catch (err) {
        problems.push(classifySourceError(err).message);
      }
    }

    // AWS RDS deletes binary logs right away unless told to keep them
    try {
      const [sets] = await connection.query('CALL mysql.rds_show_configuration') as unknown as [unknown[]];
      const list = (Array.isArray(sets[0]) ? sets[0] : sets) as { name?: string; value?: string | null }[];
      const keep = list.find((x) => x?.name === 'binlog retention hours');
      if (keep && (keep.value === null || keep.value === undefined || keep.value === '')) {
        warnings.push("The source deletes its binary logs right away (binlog retention hours is not set), so Live sync can't continue "
          + "after being off for more than a few minutes and catches up with a sync instead. Set it on the source: CALL mysql.rds_set_configuration('binlog retention hours', 24);");
      }
    } catch { /* not RDS */ }

    const meta = await loadMeta(connection);
    const ambiguous: string[] = [];
    const noKey: string[] = [];
    for (const [table, m] of meta) {
      if (m.pk.length === 0) noKey.push(table);
      for (const c of m.columns) if (ambiguousEnumValues(c.columnType).length) ambiguous.push(`${table}.${c.name}`);
    }
    if (ambiguous.length) {
      problems.push(`These ENUM/SET columns have values with commas or quotes, which Live sync can't copy exactly: ${ambiguous.join(', ')}. Use Compare & Sync for this database.`);
    }
    if (noKey.length) {
      warnings.push(`Not copied by Live sync (no primary key, so rows can't be matched; Compare & Sync skips them too): ${noKey.join(', ')}`);
    }
    return { position, problems, warnings };
  } finally {
    await connection.end().catch(() => undefined);
    tunnel?.close();
  }
}

/** The statement without comments, on one line */
function bareSql(sql: string): string {
  return sql.replace(/\/\*(?!!)[\s\S]*?\*\//g, ' ').replace(/^\s*(--|#).*$/gm, ' ').replace(/\s+/g, ' ').trim();
}

const NAME = '(?:`((?:[^`]|``)+)`|([\\w$]+))';
const unq = (a?: string, b?: string) => (a !== undefined ? a.replace(/``/g, '`') : b);

/** TRUNCATE [TABLE] [db.]t: the table, when it is in `db` */
export function truncatedTable(sql: string, currentDb: string, db: string): string | null {
  const m = new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?(?:${NAME}\\s*\\.\\s*)?${NAME}\\s*;?$`, 'i').exec(sql);
  if (!m) return null;
  const schema = unq(m[1], m[2]) ?? currentDb;
  return schema === db ? unq(m[3], m[4]) ?? null : null;
}

type Op =
  | { kind: 'writerows'; table: string; rows: RowData[] }
  | { kind: 'deleterows'; table: string; rows: RowData[] }
  | { kind: 'updaterows'; table: string; rows: UpdateRowData[] };

type Item =
  | { type: 'txn'; ops: Op[]; position: BinlogPosition; at: number }
  | { type: 'ddl'; sql: string; schema: string; position: BinlogPosition; at: number }
  | { type: 'mark'; position: BinlogPosition };

interface Plan {
  target: string;
  /** Source column names written, and the target's names for them */
  cols: string[];
  targetCols: string[];
  /** Source primary key columns */
  pk: string[];
  /** Not copied, and why */
  skip?: string;
}

/** Changes buffered before the source stream is paused */
const HIGH_WATER = 5000;
const LOW_WATER = 1000;
/**
 * Source transactions applied together in one target transaction. Each round
 * trip to a distant target costs tens of milliseconds, so one at a time can't
 * keep up with a busy source; together, consecutive rows of a table go in one
 * statement. Still all or nothing, and in order.
 */
const GROUP_TXNS = 1000;
const GROUP_ROWS = 20_000;
/** Rows per statement */
const BATCH_ROWS = 200;
const BATCH_BYTES = 4 * 1024 * 1024;

function sizeOf(v: unknown): number {
  if (v === null || v === undefined) return 4;
  if (Buffer.isBuffer(v)) return v.length * 2 + 3;
  return String(v).length + 2;
}

/** Split rows into statements of at most BATCH_ROWS rows and about BATCH_BYTES */
function batches<T>(list: T[], size: (x: T) => number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const x of list) {
    const s = size(x);
    if (cur.length && (cur.length >= BATCH_ROWS || bytes + s > BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(x);
    bytes += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Target connection with the session settings exact copies need, reopened when it breaks */
class Target {
  private res: MySQLConnectionResult | null = null;
  constructor(private readonly cfg: ConnectionConfig) {}
  get c(): mysql2.Connection {
    if (!this.res) throw Object.assign(new Error('not connected'), { fatal: true });
    return this.res.connection;
  }
  async open(): Promise<void> {
    await this.close();
    const r = await ConnectionFactory.createMySQLConnection(this.cfg, EXACT);
    r.connection.on('error', () => undefined);
    this.res = r;
    for (const sql of [
      "SET SESSION time_zone = '+00:00'",
      'SET SESSION foreign_key_checks = 0',
      "SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'",
    ]) await r.connection.query(sql);
  }
  async close(): Promise<void> {
    const r = this.res;
    this.res = null;
    if (!r) return;
    await r.connection.end().catch(() => r.connection.destroy());
    r.tunnel?.close();
  }
}

const LOST = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ER_CLIENT_INTERACTION_TIMEOUT']);
const isLost = (err: unknown) => {
  const e = err as { fatal?: boolean; code?: string } | null;
  return !!e && (e.fatal === true || LOST.has(e.code ?? ''));
};
/** Lock wait timeout, deadlock: worth trying again */
const isRetryable = (err: unknown) => [1205, 1213].includes(errno(err));

/**
 * Follow the source's binary log from `start` and apply each change to the
 * target. Resolves `done` when stopped; rejects it with a LiveSyncError.
 */
export async function startLiveStream(source: ConnectionConfig, target: ConnectionConfig, opts: LiveStreamOptions): Promise<LiveStream> {
  // Values exactly as stored: dates as text in UTC, big numbers and JSON as text
  const src = await ConnectionFactory.createMySQLConnection(source, { ...EXACT, typeCast: true, timezone: 'Z' });
  src.connection.on('error', () => undefined);
  const dst = new Target(target);
  let z: ZongJi | null = null;
  try {
    await dst.open();
    const db = (await rows<{ db: string | null }>(src.connection, 'SELECT DATABASE() AS db'))[0]?.db;
    if (!db) throw new LiveSyncError('The source connection has no database selected', 'CONFIG');
    const { default: ZongJiClass } = await loadZongJi();
    // Our connection answers its metadata queries; it opens its own for the log, with the same settings
    z = new ZongJiClass((src.connection as unknown as { connection: mysql2.Connection }).connection as never);
    return run(z, src, dst, db, opts);
  } catch (err) {
    z?.stop();
    await dst.close();
    await src.connection.end().catch(() => undefined);
    src.tunnel?.close();
    throw classifySourceError(err);
  }
}

function run(z: ZongJi, src: MySQLConnectionResult, dst: Target, db: string, opts: LiveStreamOptions): LiveStream {
  const queue: Item[] = [];
  let txn: Op[] = [];
  let paused = false;
  let stopping = false;
  let failure: LiveSyncError | null = null;
  let lastEvent = Date.now();
  let draining: Promise<void> | null = null;
  const plans = new Map<string, Plan>();
  let targetNames: string[] | null = null;
  const noted = new Set<string>();

  let resolveDone!: () => void;
  let rejectDone!: (e: LiveSyncError) => void;
  const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });
  // Rejections are observed by whoever awaits done; never unhandled
  done.catch(() => undefined);

  const note = (msg: string) => {
    if (noted.has(msg)) return;
    noted.add(msg);
    opts.onNote?.(msg);
  };
  const position = (): BinlogPosition => ({ file: String(z.options.filename), pos: Number(z.options.position) });

  const finish = async (err: LiveSyncError | null) => {
    if (stopping) return;
    stopping = true;
    try { z.stop(); } catch { /* already stopped */ }
    await draining?.catch(() => undefined);
    await dst.close();
    await src.connection.end().catch(() => src.connection.destroy());
    src.tunnel?.close();
    if (err) rejectDone(err); else resolveDone();
  };
  const fail = (err: unknown) => {
    if (failure || stopping) return;
    failure = err instanceof LiveSyncError ? err : classifySourceError(err);
    void finish(failure);
  };

  const enqueue = (item: Item) => {
    const last = queue[queue.length - 1];
    if (item.type === 'mark' && last?.type === 'mark') last.position = item.position;
    else queue.push(item);
    if (!paused && queue.length >= HIGH_WATER) {
      paused = true;
      z.connection?.pause();
    }
    if (!draining) draining = drain().finally(() => { draining = null; });
  };

  const drain = async () => {
    while (queue.length && !stopping) {
      const item = queue.shift()!;
      // Transactions waiting behind it go along (up to a schema change)
      const group: Item[] = [item];
      if (item.type !== 'ddl') {
        let txns = item.type === 'txn' ? 1 : 0;
        let rowCount = item.type === 'txn' ? item.ops.reduce((n, o) => n + o.rows.length, 0) : 0;
        while (queue.length && queue[0].type !== 'ddl' && txns < GROUP_TXNS && rowCount < GROUP_ROWS) {
          const next = queue.shift()!;
          group.push(next);
          if (next.type === 'txn') { txns++; rowCount += next.ops.reduce((n, o) => n + o.rows.length, 0); }
        }
      }
      if (paused && queue.length <= LOW_WATER) {
        paused = false;
        z.connection?.resume();
      }
      try {
        await apply(group);
      } catch (err) {
        fail(err instanceof LiveSyncError ? err : new LiveSyncError(messageOf(err), isLost(err) ? 'TRANSIENT' : 'APPLY'));
        return;
      }
    }
  };

  // ---- applying -----------------------------------------------------------

  const targetTables = async () => {
    if (!targetNames) targetNames = await tableNames(dst.c);
    return targetNames;
  };

  /** Add what the target lacks (tables, columns, indexes), never removing or changing anything */
  const schemaSync = async (only: string[] | null) => {
    const report = await compareMysqlSchema(src.connection, dst.c, only);
    if (report.changes.length) {
      await applyMysqlSchema(dst.c, report);
      await dst.c.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");
      await dst.c.query('SET SESSION foreign_key_checks = 0');
      for (const c of report.changes) {
        if (c.status === 'FAILED') note(`Could not add ${c.name} to ${c.targetTable} on the target: ${c.error}`);
      }
    }
    for (const n of report.notes) {
      note(`Schema difference not copied (${n.table}${n.name ? `.${n.name}` : ''}): ${n.kind.toLowerCase().replace(/_/g, ' ')}`);
    }
    targetNames = null;
    plans.clear();
  };

  const plan = async (table: string): Promise<Plan> => {
    const cached = plans.get(table);
    if (cached) return cached;
    const build = async (): Promise<Plan | string> => {
      const s = (await loadMeta(src.connection, table)).get(table);
      if (!s) return { target: table, cols: [], targetCols: [], pk: [], skip: 'the table no longer exists on the source' };
      if (s.pk.length === 0) return { target: table, cols: [], targetCols: [], pk: [], skip: 'no primary key, so rows cannot be matched' };
      const bad = s.columns.filter((c) => ambiguousEnumValues(c.columnType).length);
      if (bad.length) {
        throw new LiveSyncError(`${table}.${bad[0].name} has ENUM/SET values with commas or quotes, which Live sync can't copy exactly`, 'CONFIG');
      }
      const t = matchTargetTable(table, await targetTables());
      if (!t) return 'missing table';
      const d: TableMeta | undefined = (await loadMeta(dst.c, t)).get(t);
      if (!d) return 'missing table';
      const byName = new Map(d.columns.map((c) => [c.name.toLowerCase(), c]));
      const cols: string[] = [];
      const targetCols: string[] = [];
      for (const c of s.columns) {
        const tc = byName.get(c.name.toLowerCase());
        if (!tc) return `missing column ${c.name}`;
        if (tc.generated || c.generated) continue;
        cols.push(c.name);
        targetCols.push(tc.name);
      }
      if (s.pk.map((k) => k.toLowerCase()).join(',') !== d.pk.map((k) => k.toLowerCase()).join(',')) {
        throw new LiveSyncError(`${table}: the primary key differs between the source and the target`, 'APPLY');
      }
      return { target: t, cols, targetCols, pk: s.pk };
    };
    let p = await build();
    if (typeof p === 'string') {
      // A table or column added on the source: add it to the target too
      await schemaSync([table]);
      p = await build();
      if (typeof p === 'string') throw new LiveSyncError(`${table}: ${p} on the target`, 'APPLY');
    }
    if (p.skip) note(`Not copied: ${table} (${p.skip})`);
    plans.set(table, p);
    return p;
  };

  const keyWhere = (p: Plan, keys: unknown[][]) => {
    const tcols = p.pk.map((k) => qid(p.targetCols[p.cols.indexOf(k)] ?? k));
    if (tcols.length === 1) return { sql: `${tcols[0]} IN (${keys.map(() => '?').join(', ')})`, params: keys.map((k) => k[0]) };
    const one = `(${tcols.map((c) => `${c} = ?`).join(' AND ')})`;
    return { sql: keys.map(() => one).join(' OR '), params: keys.flat() };
  };
  const val = (v: unknown) => (v === undefined ? null : v);
  const keyOf = (p: Plan, r: RowData) => p.pk.map((k) => val(r[k]));
  const sameKey = (a: unknown[], b: unknown[]) => a.every((x, i) => {
    const y = b[i];
    if (Buffer.isBuffer(x) && Buffer.isBuffer(y)) return x.equals(y);
    return String(x) === String(y);
  });

  const write = async (p: Plan, list: RowData[]) => {
    const one = `(${p.cols.map(() => '?').join(', ')})`;
    for (const b of batches(list, (r) => p.cols.reduce((n, c) => n + sizeOf(r[c]), 0))) {
      await dst.c.query(
        `REPLACE INTO ${qid(p.target)} (${p.targetCols.map(qid).join(', ')}) VALUES ${b.map(() => one).join(', ')}`,
        b.flatMap((r) => p.cols.map((c) => val(r[c]))),
      );
    }
  };
  const remove = async (p: Plan, keys: unknown[][]) => {
    for (const b of batches(keys, () => 64)) {
      const w = keyWhere(p, b);
      await dst.c.query(`DELETE FROM ${qid(p.target)} WHERE ${w.sql}`, w.params);
    }
  };

  type Step = { p: Plan; kind: 'write'; rows: RowData[] } | { p: Plan; kind: 'delete'; keys: unknown[][] };

  /** The writes and deletes for these changes, consecutive ones on the same table merged */
  const steps = (ops: Op[], planOf: Map<string, Plan>, counts: { inserted: number; updated: number; deleted: number }) => {
    const out: Step[] = [];
    const push = (st: Step) => {
      const last = out[out.length - 1];
      if (last && last.p === st.p && last.kind === st.kind) {
        if (last.kind === 'write' && st.kind === 'write') last.rows.push(...st.rows);
        else if (last.kind === 'delete' && st.kind === 'delete') last.keys.push(...st.keys);
      } else {
        out.push(st.kind === 'write' ? { ...st, rows: [...st.rows] } : { ...st, keys: [...st.keys] });
      }
    };
    for (const op of ops) {
      const p = planOf.get(op.table)!;
      if (p.skip) continue;
      if (op.kind === 'writerows') {
        push({ p, kind: 'write', rows: op.rows });
        counts.inserted += op.rows.length;
      } else if (op.kind === 'deleterows') {
        push({ p, kind: 'delete', keys: op.rows.map((r) => keyOf(p, r)) });
        counts.deleted += op.rows.length;
      } else {
        // Rows whose key changed lose their old key first, then every row gets its new image
        const moved = op.rows.filter((r) => !sameKey(keyOf(p, r.before), keyOf(p, r.after)));
        if (moved.length) push({ p, kind: 'delete', keys: moved.map((r) => keyOf(p, r.before)) });
        push({ p, kind: 'write', rows: op.rows.map((r) => r.after) });
        counts.updated += op.rows.length;
      }
    }
    return out;
  };

  /** Run fn in a target transaction; reconnect or retry when that is safe */
  const inTransaction = async (fn: () => Promise<void>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        await dst.c.query('START TRANSACTION');
        try {
          await fn();
          await dst.c.query('COMMIT');
          return;
        } catch (err) {
          await dst.c.query('ROLLBACK').catch(() => undefined);
          throw err;
        }
      } catch (err) {
        if (stopping) throw err;
        if (attempt >= 4 || !(isLost(err) || isRetryable(err))) throw err;
        await new Promise((r) => setTimeout(r, attempt * 1000));
        if (isLost(err)) await dst.open();
      }
    }
  };

  const apply = async (group: Item[]) => {
    const last = group[group.length - 1];
    if (group.length === 1 && last.type === 'ddl') {
      await applyDdl(last);
      opts.onProgress({ position: last.position, eventAt: new Date(last.at), inserted: 0, updated: 0, deleted: 0, transactions: 0 });
      return;
    }
    const txns = group.filter((g): g is Extract<Item, { type: 'txn' }> => g.type === 'txn');
    if (txns.length === 0) {
      opts.onProgress({ position: last.position, eventAt: null, inserted: 0, updated: 0, deleted: 0, transactions: 0 });
      return;
    }
    const ops = txns.flatMap((t) => t.ops);
    // Table definitions first (they may add a table or column to the target), outside the transaction
    const planOf = new Map<string, Plan>();
    for (const table of new Set(ops.map((o) => o.table))) planOf.set(table, await withTarget(() => plan(table)));
    let counts = { inserted: 0, updated: 0, deleted: 0 };
    try {
      await inTransaction(async () => {
        counts = { inserted: 0, updated: 0, deleted: 0 };
        for (const st of steps(ops, planOf, counts)) {
          if (st.kind === 'write') await write(st.p, st.rows);
          else await remove(st.p, st.keys);
        }
      });
    } catch (err) {
      if (err instanceof LiveSyncError) throw err;
      if (isLost(err)) throw new LiveSyncError(messageOf(err), 'TRANSIENT');
      const tables = [...new Set(ops.map((o) => o.table))].slice(0, 5).join(', ');
      throw new LiveSyncError(`Could not apply changes to ${tables} on the target: ${messageOf(err)}`, 'APPLY');
    }
    opts.onProgress({ position: last.position, eventAt: new Date(txns[txns.length - 1].at), ...counts, transactions: txns.length });
  };

  const withTarget = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!isLost(err)) throw err;
      await dst.open();
      return fn();
    }
  };

  const applyDdl = async (item: Extract<Item, { type: 'ddl' }>) => {
    const sql = item.sql;
    const truncated = truncatedTable(sql, item.schema, db);
    if (truncated) {
      const t = matchTargetTable(truncated, await withTarget(targetTables));
      if (t) await withTarget(() => dst.c.query(`TRUNCATE TABLE ${qid(t)}`));
      return;
    }
    if (/^DROP\s+(TEMPORARY\s+)?TABLE/i.test(sql)) {
      if (!/^DROP\s+TEMPORARY/i.test(sql)) note(`A table was dropped on the source and kept on the target: ${sql.slice(0, 200)}`);
      plans.clear();
      targetNames = null;
      return;
    }
    if (/^(CREATE|ALTER|RENAME)\s+(TABLE|(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?INDEX)\b/i.test(sql) || /^DROP\s+INDEX\b/i.test(sql)) {
      if (/^CREATE\s+TEMPORARY/i.test(sql)) return;
      await withTarget(() => schemaSync(null));
    }
  };

  // ---- reading --------------------------------------------------------------

  z.on('binlog', (e: AnyBinlogEvent) => {
    if (stopping) return;
    lastEvent = Date.now();
    try {
      switch (e.getEventName()) {
        case 'tablemap': {
          const ev = e as TableMapEvent;
          const entry = ev.tableMap[ev.tableId];
          // Without binlog_row_metadata=FULL, columns are looked up now; a later ALTER would misread older changes
          if (ev.schemaName === db && entry?.columnSchemas && entry.columnSchemas.length !== ev.columnCount) {
            throw new LiveSyncError(`${ev.tableName} changed on the source since these changes were made`, 'RESYNC');
          }
          return;
        }
        case 'writerows':
        case 'deleterows':
        case 'updaterows': {
          const ev = e as unknown as { tableId: number; tableMap: Record<number, { parentSchema: string; tableName: string }>; rows: RowData[] };
          const t = ev.tableMap[ev.tableId];
          if (!t || t.parentSchema !== db) return;
          txn.push({ kind: e.getEventName(), table: t.tableName, rows: ev.rows } as Op);
          return;
        }
        case 'mariadbgtid':
          txn = [];
          return;
        case 'query': {
          const ev = e as QueryEvent;
          const sql = bareSql(ev.query);
          if (/^(BEGIN|START TRANSACTION|XA START)\b/i.test(sql)) { txn = []; return; }
          if (/^(COMMIT|XA COMMIT)\b/i.test(sql)) { commit(ev.timestamp); return; }
          if (/^(ROLLBACK|XA ROLLBACK)\b/i.test(sql)) { txn = []; enqueue({ type: 'mark', position: position() }); return; }
          if (/^(SAVEPOINT|RELEASE|XA END)\b/i.test(sql)) return;
          if (txn.length) commit(ev.timestamp);
          if (ev.schema === db || sql.includes(db)) enqueue({ type: 'ddl', sql, schema: ev.schema, position: position(), at: ev.timestamp });
          else enqueue({ type: 'mark', position: position() });
          return;
        }
        case 'xid':
          commit(e.timestamp);
          return;
        case 'xaprepare':
          throw new LiveSyncError('The source uses XA transactions, which Live sync does not support', 'CONFIG');
        case 'rotate':
        case 'heartbeat':
          if (!txn.length) enqueue({ type: 'mark', position: position() });
          return;
        default:
      }
    } catch (err) {
      fail(err);
    }
  });

  const commit = (at: number) => {
    const ops = txn;
    txn = [];
    if (ops.length) enqueue({ type: 'txn', ops, position: position(), at });
    else enqueue({ type: 'mark', position: position() });
  };

  z.on('error', (err: Error) => fail(classifySourceError(err)));
  z.start({ serverId: opts.serverId, filename: opts.start.file, position: opts.start.pos, includeSchema: { [db]: true } });

  return {
    done,
    stop: async () => {
      await finish(null);
      await done.catch(() => undefined);
    },
    head: () => binlogHead(src.connection),
    lastEventMs: () => lastEvent,
    pending: () => queue.length + txn.length,
  };
}
