import type * as mysql2 from 'mysql2/promise';
import { qid, normalizeColumnType, matchTargetTable } from './mysql-data-sync';

/**
 * Schema check and additive schema sync between two MySQL/MariaDB databases.
 *
 * Compares tables, columns, indexes and foreign keys (information_schema,
 * a few queries per side). Only additions are ever applied to the target:
 * missing tables, columns, indexes and foreign keys, with the source's own
 * definitions (from SHOW CREATE TABLE). Anything that would need a change or a
 * removal (a column whose type differs, a column or index only on the target,
 * a different primary key) is reported with the SQL, never run: those can
 * lose data, so they stay a person's decision. The source is only read.
 */

export type SchemaChangeKind = 'CREATE_TABLE' | 'ADD_COLUMN' | 'ADD_INDEX' | 'ADD_FOREIGN_KEY';
export type SchemaNoteKind =
  | 'COLUMN_DIFFERS' | 'COLUMN_ONLY_ON_TARGET'
  | 'INDEX_DIFFERS' | 'INDEX_ONLY_ON_TARGET'
  | 'FOREIGN_KEY_DIFFERS' | 'FOREIGN_KEY_ONLY_ON_TARGET'
  | 'PRIMARY_KEY_DIFFERS' | 'TABLE_ONLY_ON_TARGET';

/** Something the target lacks; safe to add */
export interface SchemaChange {
  kind: SchemaChangeKind;
  table: string;
  /** The table's name on the target (may differ in case) */
  targetTable: string;
  name: string;
  /** The statement that adds it */
  sql: string;
  status?: 'APPLIED' | 'FAILED';
  error?: string;
}

/** A difference that is only reported, never applied */
export interface SchemaNote {
  kind: SchemaNoteKind;
  table: string;
  name: string;
  source?: string;
  target?: string;
  /** What would make the target match (to review and run by hand) */
  suggestedSql?: string;
}

export interface SchemaReport {
  changes: SchemaChange[];
  notes: SchemaNote[];
  tablesCompared: number;
}

interface ColumnShape { name: string; position: number; signature: string; describe: string; columnType: string; charset: string | null; collation: string | null }
interface IndexShape { name: string; primary: boolean; signature: string; describe: string }
interface ForeignKeyShape { name: string; signature: string; describe: string }
interface TableShape {
  name: string;
  columns: ColumnShape[];
  indexes: Map<string, IndexShape>;
  foreignKeys: Map<string, ForeignKeyShape>;
}

async function rows<T>(c: mysql2.Connection, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await c.query(sql, params);
  return r as T[];
}

const lc = (s: string) => s.toLowerCase();

/** Everything needed to compare, in four queries */
async function loadShapes(c: mysql2.Connection): Promise<Map<string, TableShape>> {
  const tables = await rows<{ t: string }>(c,
    "SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
  const cols = await rows<{ t: string; n: string; p: number; ct: string; nl: string; d: string | null; ex: string | null; g: string | null; co: string | null; cs: string | null }>(c,
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS n, ORDINAL_POSITION AS p, COLUMN_TYPE AS ct, IS_NULLABLE AS nl,
            COLUMN_DEFAULT AS d, EXTRA AS ex, GENERATION_EXPRESSION AS g, COLLATION_NAME AS co, CHARACTER_SET_NAME AS cs
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`);
  const idx = await rows<{ t: string; i: string; nu: number | string; q: number; n: string | null; sp: number | null; ty: string; o: string | null }>(c,
    `SELECT TABLE_NAME AS t, INDEX_NAME AS i, NON_UNIQUE AS nu, SEQ_IN_INDEX AS q, COLUMN_NAME AS n,
            SUB_PART AS sp, INDEX_TYPE AS ty, COLLATION AS o
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`);
  const fks = await rows<{ t: string; c: string; n: string; rt: string; rn: string; q: number; ur: string; dr: string }>(c,
    `SELECT k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS c, k.COLUMN_NAME AS n, k.REFERENCED_TABLE_NAME AS rt,
            k.REFERENCED_COLUMN_NAME AS rn, k.ORDINAL_POSITION AS q, r.UPDATE_RULE AS ur, r.DELETE_RULE AS dr
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`);

  const shapes = new Map<string, TableShape>();
  for (const t of tables) shapes.set(t.t, { name: t.t, columns: [], indexes: new Map(), foreignKeys: new Map() });

  for (const x of cols) {
    const s = shapes.get(x.t);
    if (!s) continue;
    // DEFAULT_GENERATED only marks an expression default; the default itself is compared
    const extra = String(x.ex ?? '').replace(/DEFAULT_GENERATED/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const def = x.d === null || x.d === undefined ? 'NULL' : String(x.d);
    const gen = String(x.g ?? '').trim();
    s.columns.push({
      name: x.n,
      position: Number(x.p),
      columnType: String(x.ct),
      charset: x.cs ?? null,
      collation: x.co ?? null,
      signature: [normalizeColumnType(String(x.ct)), x.nl, def, extra, gen, String(x.co ?? '')].join('|'),
      describe: `${normalizeColumnType(String(x.ct))}${x.nl === 'NO' ? ' NOT NULL' : ''}${x.d !== null && x.d !== undefined ? ` DEFAULT ${def}` : ''}${extra ? ` ${extra}` : ''}${x.co ? ` ${x.co}` : ''}`,
    });
  }

  const idxParts = new Map<string, { t: string; i: string; unique: boolean; type: string; parts: string[] }>();
  for (const x of idx) {
    const key = `${x.t}\u0000${x.i}`;
    if (!idxParts.has(key)) idxParts.set(key, { t: x.t, i: x.i, unique: Number(x.nu) === 0, type: String(x.ty), parts: [] });
    // Functional key parts have no column name (MySQL 8.0.13+): compare them by position only
    idxParts.get(key)!.parts.push(`${lc(String(x.n ?? '(expression)'))}${x.sp ? `(${x.sp})` : ''}${x.o === 'D' ? ' DESC' : ''}`);
  }
  for (const v of idxParts.values()) {
    const s = shapes.get(v.t);
    if (!s) continue;
    const kind = v.i === 'PRIMARY' ? 'PRIMARY KEY' : `${v.unique ? 'UNIQUE ' : ''}${v.type === 'BTREE' ? '' : `${v.type} `}KEY`;
    s.indexes.set(lc(v.i), {
      name: v.i,
      primary: v.i === 'PRIMARY',
      signature: `${kind} (${v.parts.join(', ')})`,
      describe: `${kind} (${v.parts.join(', ')})`,
    });
  }

  const fkParts = new Map<string, { t: string; c: string; cols: string[]; rt: string; rcols: string[]; ur: string; dr: string }>();
  for (const x of fks) {
    const key = `${x.t}\u0000${x.c}`;
    if (!fkParts.has(key)) fkParts.set(key, { t: x.t, c: x.c, cols: [], rt: x.rt, rcols: [], ur: x.ur, dr: x.dr });
    const f = fkParts.get(key)!;
    f.cols.push(lc(x.n));
    f.rcols.push(lc(x.rn));
  }
  for (const f of fkParts.values()) {
    const s = shapes.get(f.t);
    if (!s) continue;
    const describe = `(${f.cols.join(', ')}) REFERENCES ${f.rt} (${f.rcols.join(', ')}) ON DELETE ${f.dr} ON UPDATE ${f.ur}`;
    // Referenced table compared without case (a lowercasing target stores it in lowercase)
    s.foreignKeys.set(lc(f.c), { name: f.c, signature: lc(describe), describe });
  }
  return shapes;
}

/** The lines of a CREATE TABLE statement between the parentheses, without trailing commas */
function definitionLines(createTable: string): string[] {
  const lines = createTable.split('\n');
  const out: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\)/.test(line)) break;
    out.push(line.trim().replace(/,$/, ''));
  }
  return out;
}

/**
 * SHOW CREATE TABLE leaves out a column's character set and collation when they
 * equal the table's default. The target table's default may differ, so spell
 * the source column's out: the added column then is exactly the source's.
 */
function withCollation(line: string, c: ColumnShape): string {
  if (!c.collation || /\bCOLLATE\b/i.test(line)) return line;
  const prefix = `${qid(c.name)} ${c.columnType}`;
  if (!line.startsWith(prefix)) return line;
  return `${prefix} CHARACTER SET ${c.charset} COLLATE ${c.collation}${line.slice(prefix.length)}`;
}

const nameOf = (line: string): string | null => {
  const m = line.match(/^(?:(?:UNIQUE|FULLTEXT|SPATIAL) )?KEY `((?:[^`]|``)+)`/) ?? line.match(/^CONSTRAINT `((?:[^`]|``)+)`/) ?? line.match(/^`((?:[^`]|``)+)`/);
  return m ? m[1].replace(/``/g, '`') : null;
};

/**
 * Compare the two databases. Missing tables, columns, indexes and foreign keys
 * become changes (with their statements); everything else becomes a note.
 * Only the source's SHOW CREATE TABLE is read, for tables that need a change.
 */
export async function compareMysqlSchema(src: mysql2.Connection, dst: mysql2.Connection, onlyTables?: string[] | null): Promise<SchemaReport> {
  const [a, b] = await Promise.all([loadShapes(src), loadShapes(dst)]);
  const wanted = onlyTables?.length ? new Set(onlyTables.map(lc)) : null;
  const dstNames = [...b.keys()];
  const changes: SchemaChange[] = [];
  const notes: SchemaNote[] = [];
  const createCache = new Map<string, string>();
  const showCreate = async (table: string) => {
    if (!createCache.has(table)) {
      const [r] = await rows<Record<string, string>>(src, `SHOW CREATE TABLE ${qid(table)}`);
      createCache.set(table, r['Create Table']);
    }
    return createCache.get(table)!;
  };

  const sourceTables = [...a.keys()].filter((t) => !wanted || wanted.has(lc(t))).sort();
  const matched = new Set<string>();
  for (const table of sourceTables) {
    const s = a.get(table)!;
    const targetName = matchTargetTable(table, dstNames);
    if (!targetName) {
      // FKs inside the definition may point at tables created later: applied with foreign_key_checks = 0
      changes.push({ kind: 'CREATE_TABLE', table, targetTable: table, name: table, sql: (await showCreate(table)).replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ') });
      continue;
    }
    matched.add(targetName);
    const t = b.get(targetName)!;

    // Columns
    const tCols = new Map(t.columns.map((c) => [lc(c.name), c]));
    const sColNames = new Set(s.columns.map((c) => lc(c.name)));
    let create: string[] | null = null;
    const lineFor = async (name: string) => {
      create ??= definitionLines(await showCreate(table));
      return create.find((l) => nameOf(l) !== null && lc(nameOf(l)!) === lc(name) && !/^(?:(?:UNIQUE|FULLTEXT|SPATIAL) )?KEY |^CONSTRAINT |^PRIMARY KEY/.test(l)) ?? null;
    };
    const indexLineFor = async (name: string) => {
      create ??= definitionLines(await showCreate(table));
      return create.find((l) => /^(?:(?:UNIQUE|FULLTEXT|SPATIAL) )?KEY `/.test(l) && lc(nameOf(l)!) === lc(name)) ?? null;
    };
    const fkLineFor = async (name: string) => {
      create ??= definitionLines(await showCreate(table));
      return create.find((l) => /^CONSTRAINT `/.test(l) && /FOREIGN KEY/.test(l) && lc(nameOf(l)!) === lc(name)) ?? null;
    };

    for (const [i, c] of s.columns.entries()) {
      const tc = tCols.get(lc(c.name));
      if (!tc) {
        const line = await lineFor(c.name);
        if (!line) continue;
        const after = i === 0 ? 'FIRST' : `AFTER ${qid(s.columns[i - 1].name)}`;
        changes.push({ kind: 'ADD_COLUMN', table, targetTable: targetName, name: c.name, sql: `ALTER TABLE ${qid(targetName)} ADD COLUMN ${withCollation(line, c)} ${after}` });
      } else if (tc.signature !== c.signature) {
        const line = await lineFor(c.name);
        notes.push({
          kind: 'COLUMN_DIFFERS', table, name: c.name, source: c.describe, target: tc.describe,
          suggestedSql: line ? `ALTER TABLE ${qid(targetName)} MODIFY COLUMN ${line}` : undefined,
        });
      }
    }
    for (const c of t.columns) {
      if (!sColNames.has(lc(c.name))) {
        notes.push({ kind: 'COLUMN_ONLY_ON_TARGET', table, name: c.name, target: c.describe, suggestedSql: `ALTER TABLE ${qid(targetName)} DROP COLUMN ${qid(c.name)}` });
      }
    }

    // Indexes: matched by name; an index with the same definition under another name counts as present
    const tSigs = new Set([...t.indexes.values()].map((x) => x.signature));
    const sSigs = new Set([...s.indexes.values()].map((x) => x.signature));
    for (const [key, ix] of s.indexes) {
      const tx = t.indexes.get(key);
      if (ix.primary) {
        if (!tx || tx.signature !== ix.signature) notes.push({ kind: 'PRIMARY_KEY_DIFFERS', table, name: 'PRIMARY', source: ix.describe, target: tx?.describe ?? 'none' });
        continue;
      }
      if (!tx) {
        if (tSigs.has(ix.signature)) continue;
        const line = await indexLineFor(ix.name);
        if (line) changes.push({ kind: 'ADD_INDEX', table, targetTable: targetName, name: ix.name, sql: `ALTER TABLE ${qid(targetName)} ADD ${line}` });
      } else if (tx.signature !== ix.signature) {
        const line = await indexLineFor(ix.name);
        notes.push({
          kind: 'INDEX_DIFFERS', table, name: ix.name, source: ix.describe, target: tx.describe,
          suggestedSql: line ? `ALTER TABLE ${qid(targetName)} DROP INDEX ${qid(tx.name)}, ADD ${line}` : undefined,
        });
      }
    }
    for (const [key, tx] of t.indexes) {
      if (!s.indexes.has(key) && !tx.primary && !sSigs.has(tx.signature)) {
        notes.push({ kind: 'INDEX_ONLY_ON_TARGET', table, name: tx.name, target: tx.describe, suggestedSql: `ALTER TABLE ${qid(targetName)} DROP INDEX ${qid(tx.name)}` });
      }
    }

    // Foreign keys
    const tFkSigs = new Set([...t.foreignKeys.values()].map((x) => x.signature));
    const sFkSigs = new Set([...s.foreignKeys.values()].map((x) => x.signature));
    for (const [key, fk] of s.foreignKeys) {
      const tf = t.foreignKeys.get(key);
      if (!tf) {
        if (tFkSigs.has(fk.signature)) continue;
        const line = await fkLineFor(fk.name);
        if (line) changes.push({ kind: 'ADD_FOREIGN_KEY', table, targetTable: targetName, name: fk.name, sql: `ALTER TABLE ${qid(targetName)} ADD ${line}` });
      } else if (tf.signature !== fk.signature) {
        notes.push({ kind: 'FOREIGN_KEY_DIFFERS', table, name: fk.name, source: fk.describe, target: tf.describe });
      }
    }
    for (const [key, tf] of t.foreignKeys) {
      if (!s.foreignKeys.has(key) && !sFkSigs.has(tf.signature)) {
        notes.push({ kind: 'FOREIGN_KEY_ONLY_ON_TARGET', table, name: tf.name, target: tf.describe, suggestedSql: `ALTER TABLE ${qid(targetName)} DROP FOREIGN KEY ${qid(tf.name)}` });
      }
    }
  }

  for (const name of dstNames) {
    if (!matched.has(name) && !sourceTables.some((x) => matchTargetTable(x, dstNames) === name) && (!wanted || wanted.has(lc(name)))) {
      notes.push({ kind: 'TABLE_ONLY_ON_TARGET', table: name, name });
    }
  }

  // Tables first, then columns, then indexes, then foreign keys (they may reference new tables or columns)
  const order: SchemaChangeKind[] = ['CREATE_TABLE', 'ADD_COLUMN', 'ADD_INDEX', 'ADD_FOREIGN_KEY'];
  changes.sort((x, y) => order.indexOf(x.kind) - order.indexOf(y.kind));
  return { changes, notes, tablesCompared: sourceTables.length };
}

/**
 * Apply the additive changes to the target, one statement at a time, with
 * foreign key checks off (as mysqldump does) so a new table or key can refer
 * to one added after it. A statement that fails is reported; nothing is
 * dropped or modified. Changes to the same table go in one ALTER where
 * possible, so a big table is rebuilt or scanned once.
 */
/**
 * The last line of defence for "no data loss": only CREATE TABLE IF NOT EXISTS
 * and ALTER TABLE ... ADD ... (every clause an ADD) may run on the target.
 * Anything else is refused before it reaches the server.
 */
export function assertAdditive(sql: string): void {
  if (/^CREATE TABLE IF NOT EXISTS `/.test(sql)) return;
  const m = sql.match(/^ALTER TABLE `(?:[^`]|``)+` ([\s\S]+)$/);
  if (m) {
    // Split on top-level commas only (definitions contain commas inside parentheses and quotes)
    const clauses: string[] = [];
    let depth = 0; let quote: string | null = null; let cur = '';
    for (const ch of m[1]) {
      if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { clauses.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    clauses.push(cur.trim());
    if (clauses.every((c) => /^ADD /.test(c))) return;
  }
  throw new Error(`Refused a schema statement that is not purely additive: ${sql.slice(0, 200)}`);
}

export async function applyMysqlSchema(
  dst: mysql2.Connection,
  report: SchemaReport,
  onStatement?: (change: SchemaChange) => void,
  /** Checked before each statement; throws to stop (e.g. the run was stopped) */
  checkStop?: () => void,
): Promise<SchemaChange[]> {
  await dst.query('SET SESSION foreign_key_checks = 0');
  const done: SchemaChange[] = [];
  const run = async (sql: string, items: SchemaChange[]) => {
    checkStop?.();
    try {
      assertAdditive(sql);
      await dst.query(sql);
      for (const c of items) c.status = 'APPLIED';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const c of items) { c.status = 'FAILED'; c.error = message.slice(0, 500); }
    }
    for (const c of items) { done.push(c); onStatement?.(c); }
  };

  for (const c of report.changes.filter((x) => x.kind === 'CREATE_TABLE')) await run(c.sql, [c]);
  // Columns, then indexes, per table: one ALTER each
  for (const kind of ['ADD_COLUMN', 'ADD_INDEX', 'ADD_FOREIGN_KEY'] as const) {
    const byTable = new Map<string, SchemaChange[]>();
    for (const c of report.changes.filter((x) => x.kind === kind)) {
      if (!byTable.has(c.targetTable)) byTable.set(c.targetTable, []);
      byTable.get(c.targetTable)!.push(c);
    }
    for (const [table, items] of byTable) {
      const clauses = items.map((c) => c.sql.slice(`ALTER TABLE ${qid(table)} `.length));
      await run(`ALTER TABLE ${qid(table)} ${clauses.join(', ')}`, items);
    }
  }
  return done;
}
