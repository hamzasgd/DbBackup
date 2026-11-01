import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runMigration } from '../../services/migrations';
import { engineFactory } from '../../services/engines/engine.factory';
import { PG, MARIADB, uniq, engineConfig, pgCreateDb, pgDropDb, pgFingerprint, pgAdmin, myAdmin, myFingerprint } from './helpers';
import { seedPostgres, seedMariaDB, BIG } from './seed';

describe.skipIf(!PG)('PostgreSQL → PostgreSQL migration', () => {
  const source = uniq('e2e_mig_src');
  let expected: Record<string, string>;
  const cfg = (db: string) => engineConfig('POSTGRESQL', PG!, db);

  beforeAll(async () => {
    await pgCreateDb(source);
    await seedPostgres(source);
    expected = await pgFingerprint(source);
  });
  afterAll(() => pgDropDb(source));

  async function withTarget(fn: (db: string) => Promise<void>): Promise<void> {
    const db = uniq('e2e_mig_dst');
    await pgCreateDb(db);
    try {
      await fn(db);
    } finally {
      await pgDropDb(db);
    }
  }

  it('empty target: copies the whole schema (types, sequences, views, functions, triggers) and all data', async () => {
    await withTarget(async (db) => {
      const progress: number[] = [];
      const r = await runMigration(cfg(source), cfg(db), { onProgress: (p) => progress.push(p.progress) });
      expect(r.rowsMigrated).toBe(-1);
      expect(progress.at(-1)).toBe(100);
      expect(await pgFingerprint(db)).toEqual(expected);
      await pgAdmin(db, async (c) => {
        const { rows: [o] } = await c.query('INSERT INTO orders (customer_id) VALUES (1) RETURNING id, note');
        expect(Number(o.id)).toBe(BIG + 1); // identity sequence value came along
        expect(o.note).toBe('auto');
        expect((await c.query('SELECT count(*)::int AS n FROM big_spenders')).rows[0].n).toBeGreaterThan(0);
      });
    });
  });

  // Same definitions the source has, created by hand on the target
  const CUSTOMERS_DDL = `
    CREATE TYPE mood AS ENUM ('happy', 'sad', 'meh');
    CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL, email text UNIQUE, mood mood, tags text[], profile jsonb,
      avatar bytea, balance numeric(12,2), active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT '2026-01-01T00:00:00Z');`;

  it('target with some tables already: creates only the missing ones (incl. a new schema), then copies the data', async () => {
    await withTarget(async (db) => {
      await pgAdmin(db, (c) => c.query(`${CUSTOMERS_DDL}
        CREATE FUNCTION touch_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.note := coalesce(NEW.note, 'auto'); RETURN NEW; END $$;`));
      await runMigration(cfg(source), cfg(db), {});
      expect(await pgFingerprint(db)).toEqual(expected);
      await pgAdmin(db, async (c) => {
        const { rows: [o] } = await c.query('INSERT INTO orders (customer_id) VALUES (1) RETURNING note');
        expect(o.note).toBe('auto'); // the missing table came with its trigger
      });
    });
  });

  it('a missing table that needs an object the target lacks fails with an explanation', async () => {
    await withTarget(async (db) => {
      await pgAdmin(db, (c) => c.query(CUSTOMERS_DDL)); // no touch_note() function, which orders' trigger needs
      await expect(runMigration(cfg(source), cfg(db), {})).rejects.toThrow(/Could not create the missing tables .*public\.orders.*only copied when the target database is empty/s);
    });
  });

  it('selected tables only', async () => {
    await withTarget(async (db) => {
      await runMigration(cfg(source), cfg(db), { tables: ['Weird Table', 'reporting.daily'] });
      const fp = await pgFingerprint(db);
      expect(Object.keys(fp).sort()).toEqual(['public.Weird Table', 'reporting.daily']);
      expect(fp['public.Weird Table']).toBe(expected['public.Weird Table']);
      expect(fp['reporting.daily']).toBe(expected['reporting.daily']);
    });
  });

  it('existing rows on the target stop the migration with an error instead of mixing data', async () => {
    await withTarget(async (db) => {
      await runMigration(cfg(source), cfg(db), { tables: ['Weird Table', 'reporting.daily'] });
      await expect(runMigration(cfg(source), cfg(db), { tables: ['reporting.daily'] })).rejects.toThrow(/duplicate key/);
    });
  });

  it('unknown selected tables are reported', async () => {
    await withTarget(async (db) => {
      await expect(runMigration(cfg(source), cfg(db), { tables: ['nope'] })).rejects.toThrow(/None of the selected tables exist/);
    });
  });
});

describe.skipIf(!MARIADB)('MariaDB → MariaDB migration', () => {
  const source = uniq('e2e_mymig_src');
  let expected: Record<string, string>;
  const cfg = (db: string, type: 'MARIADB' | 'MYSQL' = 'MARIADB') => engineConfig(type, MARIADB!, db);

  beforeAll(async () => {
    await seedMariaDB(source);
    expected = await myFingerprint(source);
  });
  afterAll(() => myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${source}\``)));

  it('copies schema, routines, triggers and data (password via MYSQL_PWD, not argv)', async () => {
    const target = uniq('e2e_mymig_dst');
    await engineFactory(cfg(source)).createDatabase(target);
    try {
      await runMigration(cfg(source), cfg(target), {});
      expect(await myFingerprint(target)).toEqual(expected);
    } finally {
      await engineFactory(cfg(source)).dropDatabase(target);
    }
  });

  it('a wrong source password fails the migration (the dump error is not swallowed)', async () => {
    const target = uniq('e2e_mymig_dst');
    await engineFactory(cfg(source)).createDatabase(target);
    try {
      await expect(runMigration({ ...cfg(source), password: 'bad' }, cfg(target), {})).rejects.toThrow(/Access denied/);
    } finally {
      await engineFactory(cfg(source)).dropDatabase(target);
    }
  });
});
