import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, Writable } from 'stream';

// ── pg: Pool.connect() → client whose query() is recorded
const pgQuery = vi.fn();
const release = vi.fn();
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  return {
    ...actual,
    Pool: class {
      connect = vi.fn().mockResolvedValue({ query: pgQuery, release });
      end = vi.fn().mockResolvedValue(undefined);
    },
  };
});

// ── mysql2: core connection with query().stream() and a .promise() wrapper
const myStreamQuery = vi.fn();
const myPromiseQuery = vi.fn().mockResolvedValue([[]]);
vi.mock('mysql2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mysql2')>();
  return {
    default: {
      escape: actual.escape,
      createConnection: vi.fn(() => ({
        query: (opts: unknown) => ({ stream: () => myStreamQuery(opts) }),
        promise: () => ({ query: myPromiseQuery, end: vi.fn().mockResolvedValue(undefined) }),
        destroy: vi.fn(),
      })),
    },
  };
});

import { exportMySQL, exportPostgres } from './export.service';

const config = { type: 'POSTGRESQL', host: 'h', port: 1, username: 'u', password: 'p', database: 'db' } as never;

function fakeRes() {
  const chunks: string[] = [];
  const w = new Writable({ write(chunk, _e, cb) { chunks.push(chunk.toString()); cb(); } });
  Object.assign(w, { headersSent: false, setHeader: vi.fn() });
  // (a getter: Object.assign would copy its value once)
  Object.defineProperty(w, 'out', { get: () => chunks.join('') });
  return w as unknown as import('express').Response & { out: string };
}

/** Make pg answer: catalog lookup, BEGIN, then per table DECLARE / FETCH… / CLOSE. */
function pgRespond(catalog: string[], rowsByTable: Record<string, unknown[]>) {
  let current: unknown[] = [];
  pgQuery.mockImplementation(async (q: string | { text: string }, params?: unknown[]) => {
    const text = typeof q === 'string' ? q : q.text;
    if (text.includes('information_schema.tables')) {
      const wanted = (params?.[0] as string[]) ?? [];
      return { rows: catalog.filter((t) => wanted.includes(t)).map((table_name) => ({ table_name })) };
    }
    const declare = /^DECLARE dbbk_export NO SCROLL CURSOR FOR SELECT \* FROM "(.+)"$/.exec(text);
    if (declare) { current = [...(rowsByTable[declare[1]] ?? [])]; return { rows: [] }; }
    if (text.startsWith('FETCH')) return { rows: current.splice(0, 5000) };
    return { rows: [] };
  });
}

beforeEach(() => {
  pgQuery.mockReset();
  release.mockReset();
  myStreamQuery.mockReset();
  myPromiseQuery.mockClear();
});

describe('exportPostgres', () => {
  it('only queries tables found in the catalog, in one read-only snapshot, through a cursor', async () => {
    pgRespond(['users'], { users: [{ id: 1, name: "O'Hara" }] });
    const res = fakeRes();
    await exportPostgres(config, ['users'], 'json', res);

    const texts = pgQuery.mock.calls.map(([q]) => (typeof q === 'string' ? q : q.text));
    expect(pgQuery.mock.calls[0][1]).toEqual([['users']]);
    expect(texts).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(texts).toContain('DECLARE dbbk_export NO SCROLL CURSOR FOR SELECT * FROM "users"');
    expect(texts.some((t) => t.startsWith('FETCH 5000 FROM dbbk_export'))).toBe(true);
    expect(texts.at(-1)).toBe('ROLLBACK');
    expect(release).toHaveBeenCalled();
    expect(JSON.parse(res.out)).toEqual({ users: [{ id: 1, name: "O'Hara" }] });
  });

  it('fetches in batches until a short batch', async () => {
    const rows = Array.from({ length: 12_001 }, (_, i) => ({ id: i }));
    pgRespond(['big'], { big: rows });
    const res = fakeRes();
    await exportPostgres(config, ['big'], 'csv', res);
    const fetches = pgQuery.mock.calls.filter(([q]) => (typeof q === 'string' ? q : q.text).startsWith('FETCH'));
    expect(fetches).toHaveLength(3); // 5000 + 5000 + 2001
    expect(res.out.trim().split('\n')).toHaveLength(1 + 1 + 12_001); // "# TABLE", header, rows
  });

  it('rejects a table that does not exist before running any query for it', async () => {
    pgRespond([], {});
    await expect(exportPostgres(config, ['missing'], 'json', fakeRes())).rejects.toMatchObject({ statusCode: 404 });
    const texts = pgQuery.mock.calls.map(([q]) => (typeof q === 'string' ? q : q.text));
    expect(texts.some((t) => t.startsWith('DECLARE'))).toBe(false);
  });

  it('rejects malformed names before connecting', async () => {
    await expect(exportPostgres(config, ['users"; DROP TABLE users;--'], 'json', fakeRes())).rejects.toMatchObject({ statusCode: 400 });
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('a "__proto__" table name does not pollute objects', async () => {
    pgRespond(['__proto__'], { __proto__: [{ id: 1 }] } as never);
    const res = fakeRes();
    await exportPostgres(config, ['__proto__'], 'json', res);
    expect(({} as Record<string, unknown>).id).toBeUndefined();
    expect(res.out).toContain('"__proto__": [');
  });

  it('SQL export writes standard-conforming literals', async () => {
    pgRespond(['t'], { t: [{ a: "it's", b: 'back\\slash', c: null }] });
    const res = fakeRes();
    await exportPostgres(config, ['t'], 'sql', res);
    expect(res.out).toContain(`INSERT INTO "t" ("a", "b", "c") VALUES ('it''s', E'back\\\\slash', NULL);`);
  });
});

describe('exportMySQL', () => {
  it('binds the table identifier (??) and streams rows inside one snapshot', async () => {
    myStreamQuery.mockReturnValue(Readable.from([{ id: 1 }, { id: 2 }]));
    const res = fakeRes();
    await exportMySQL({ ...(config as object), type: 'MYSQL' } as never, ['orders'], 'csv', res);
    expect(myStreamQuery).toHaveBeenCalledWith({ sql: 'SELECT * FROM ??', values: ['orders'] });
    expect(myPromiseQuery).toHaveBeenCalledWith('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    expect(res.out).toBe('# TABLE: orders\nid\n1\n2\n\n');
  });

  it('SQL export escapes values with the driver and keeps JSON objects as JSON', async () => {
    myStreamQuery.mockReturnValue(Readable.from([{ id: 1, name: "O'Hara\\", doc: { a: 1 } }]));
    const res = fakeRes();
    await exportMySQL({ ...(config as object), type: 'MYSQL' } as never, ['t'], 'sql', res);
    expect(res.out).toContain("INSERT INTO `t` (`id`, `name`, `doc`) VALUES (1, 'O\\'Hara\\\\', '{\\\"a\\\":1}');");
  });
});
