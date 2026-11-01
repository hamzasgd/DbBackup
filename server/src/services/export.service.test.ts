import { describe, it, expect, vi, beforeEach } from 'vitest';

const pgQuery = vi.fn();
const mysqlQuery = vi.fn();

vi.mock('pg', () => ({
  Pool: class {
    query = pgQuery;
    end = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: vi.fn().mockResolvedValue({ query: (...a: unknown[]) => mysqlQuery(...a), end: vi.fn().mockResolvedValue(undefined) }),
  },
}));

import { exportMySQL, exportPostgres } from './export.service';

const config = { type: 'POSTGRESQL', host: 'h', port: 1, username: 'u', password: 'p', database: 'db' } as never;

function fakeRes() {
  const out: string[] = [];
  return {
    out,
    setHeader: vi.fn(),
    write: (s: string) => { out.push(s); return true; },
    end: (s?: string) => { if (s) out.push(s); },
  } as never as import('express').Response & { out: string[] };
}

beforeEach(() => {
  pgQuery.mockReset();
  mysqlQuery.mockReset();
});

describe('exportPostgres', () => {
  it('only queries tables found in the catalog, with LIMIT/OFFSET bound as parameters', async () => {
    pgQuery
      .mockResolvedValueOnce({ rows: [{ table_name: 'users' }] }) // catalog lookup
      .mockResolvedValueOnce({ rows: [{ id: 1, name: "O'Hara" }] }); // data
    const res = fakeRes();
    await exportPostgres(config, ['users'], 'json', res);

    expect(pgQuery.mock.calls[0][1]).toEqual([['users']]);
    expect(pgQuery.mock.calls[1][0]).toBe('SELECT * FROM "users" LIMIT $1');
    expect(pgQuery.mock.calls[1][1]).toEqual([1000000]);
    expect(JSON.parse(res.out.join(''))).toEqual({ users: [{ id: 1, name: "O'Hara" }] });
  });

  it('pages csv exports with bound LIMIT/OFFSET', async () => {
    pgQuery
      .mockResolvedValueOnce({ rows: [{ table_name: 'users' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });
    await exportPostgres(config, ['users'], 'csv', fakeRes());
    expect(pgQuery.mock.calls[1][0]).toBe('SELECT * FROM "users" LIMIT $1 OFFSET $2');
    expect(pgQuery.mock.calls[1][1]).toEqual([5000, 0]);
  });

  it('rejects a table that does not exist instead of running a query for it', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [] });
    await expect(exportPostgres(config, ['missing'], 'json', fakeRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed names before any query runs', async () => {
    await expect(exportPostgres(config, ['users"; DROP TABLE users;--'], 'json', fakeRes())).rejects.toMatchObject({ statusCode: 400 });
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('does not let a "__proto__" table name pollute the result object', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ table_name: '__proto__' }] }).mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const res = fakeRes();
    await exportPostgres(config, ['__proto__'], 'json', res);
    expect(({} as Record<string, unknown>).id).toBeUndefined();
    expect(Object.keys(JSON.parse(res.out.join('')))).toEqual(['__proto__']);
  });
});

describe('exportMySQL', () => {
  it('binds identifiers (??) and paging values instead of concatenating them', async () => {
    mysqlQuery.mockResolvedValueOnce([[{ id: 1 }]]);
    await exportMySQL({ ...(config as object), type: 'MYSQL' } as never, ['orders'], 'csv', fakeRes());
    expect(mysqlQuery).toHaveBeenCalledWith('SELECT * FROM ?? LIMIT ? OFFSET ?', ['orders', 5000, 0]);
  });

  it('uses a bound LIMIT for json exports', async () => {
    mysqlQuery.mockResolvedValueOnce([[{ id: 1 }]]);
    await exportMySQL({ ...(config as object), type: 'MYSQL' } as never, ['orders'], 'json', fakeRes());
    expect(mysqlQuery).toHaveBeenCalledWith('SELECT * FROM ?? LIMIT ?', ['orders', 1000000]);
  });
});
