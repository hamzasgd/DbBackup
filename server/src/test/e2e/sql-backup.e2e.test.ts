import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import { engineFactory } from '../../services/engines/engine.factory';
import type { BackupFormat, ConnectionConfig } from '../../services/engines/base.engine';
import {
  PG, MARIADB, uniq, tmpDir, engineConfig, pgCreateDb, pgDropDb, pgFingerprint, pgAdmin, myAdmin, myFingerprint,
} from './helpers';
import { seedPostgres, seedMariaDB, BIG } from './seed';

/**
 * Backup → restore round trips through the real CLI tools: every backup is
 * restored into a fresh database and compared row by row with the source.
 */

describe.skipIf(!PG)('PostgreSQL backup and restore', () => {
  const source = uniq('e2e_pg_src');
  const out = tmpDir();
  let expected: Record<string, string>;
  let cfg: ConnectionConfig;

  beforeAll(async () => {
    await pgCreateDb(source);
    await seedPostgres(source);
    expected = await pgFingerprint(source);
    cfg = engineConfig('POSTGRESQL', PG!, source);
  });
  afterAll(async () => {
    await pgDropDb(source);
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('seeded the fixture', () => {
    expect(expected['public.customers']).toMatch(new RegExp(`^${BIG}:`));
    expect(expected['public.orders']).toMatch(new RegExp(`^${BIG}:`));
    expect(Object.keys(expected)).toEqual(expect.arrayContaining(['public.Weird Table', 'reporting.daily']));
  });

  it('testConnection reports the server version', async () => {
    const r = await engineFactory(cfg).testConnection();
    expect(r.success).toBe(true);
    expect(r.version).toMatch(/PostgreSQL/);
  });

  it.each<BackupFormat>(['CUSTOM', 'TAR', 'DIRECTORY', 'PLAIN_SQL', 'COMPRESSED_SQL'])(
    '%s backup restores to an identical database',
    async (format) => {
      const engine = engineFactory(cfg);
      const progress: number[] = [];
      const result = await engine.backup(out, { format, onProgress: (p) => progress.push(p) });
      expect(result.fileSize).toBeGreaterThan(0);
      expect(progress.at(-1)).toBe(100);

      const target = uniq('e2e_pg_rst');
      await pgCreateDb(target);
      try {
        await engine.restore(result.filePath, target);
        expect(await pgFingerprint(target)).toEqual(expected);
        // Objects other than tables came along too, and sequences continue after the restored ids
        await pgAdmin(target, async (c) => {
          const { rows: [v] } = await c.query('SELECT count(*)::int AS n FROM big_spenders');
          expect(v.n).toBeGreaterThan(0);
          const { rows: [o] } = await c.query("INSERT INTO orders (customer_id) VALUES (1) RETURNING id, note");
          expect(Number(o.id)).toBe(BIG + 1);
          expect(o.note).toBe('auto'); // trigger + function restored
          const { rows: [cu] } = await c.query("INSERT INTO customers (name) VALUES ('new') RETURNING id");
          expect(cu.id).toBe(BIG + 1);
        });
      } finally {
        await pgDropDb(target);
      }
    },
  );

  it('restoring a backup over the same database replaces the data (CUSTOM uses --clean)', async () => {
    const engine = engineFactory(cfg);
    const backup = await engine.backup(out, { format: 'CUSTOM' });
    const target = uniq('e2e_pg_rst');
    await pgCreateDb(target);
    try {
      await engine.restore(backup.filePath, target);
      await pgAdmin(target, (c) => c.query("DELETE FROM orders WHERE id > 100; UPDATE customers SET name = 'changed'"));
      await engine.restore(backup.filePath, target);
      expect(await pgFingerprint(target)).toEqual(expected);
    } finally {
      await pgDropDb(target);
    }
  });

  it('a wrong password fails with an error instead of producing an empty backup', async () => {
    const bad = engineFactory({ ...cfg, password: 'wrong-password' });
    await expect(bad.backup(out, { format: 'CUSTOM' })).rejects.toThrow(/password authentication failed/);
  });

  it('restore drill helpers count what was restored', async () => {
    const engine = engineFactory(cfg);
    const backup = await engine.backup(out, { format: 'CUSTOM' });
    const scratch = uniq('dbbackup_drill');
    await engine.createDatabase(scratch);
    try {
      await engine.restore(backup.filePath, scratch);
      const counts = await engine.countAllTables(scratch);
      // customers, orders, "Weird Table" and reporting.daily (31 rows)
      expect(counts.tables).toBe(4);
      expect(counts.rows).toBe(BigInt(BIG * 2 + 3 + 31));
    } finally {
      await engine.dropDatabase(scratch);
    }
  });
});

describe.skipIf(!MARIADB)('MariaDB / MySQL backup and restore', () => {
  const source = uniq('e2e_my_src');
  const out = tmpDir();
  let expected: Record<string, string>;

  beforeAll(async () => {
    await seedMariaDB(source);
    expected = await myFingerprint(source);
  });
  afterAll(async () => {
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${source}\``));
    fs.rmSync(out, { recursive: true, force: true });
  });

  it('seeded the fixture', () => {
    expect(expected.customers).toMatch(new RegExp(`^${BIG}:`));
    expect(expected['@routines']).toBe('customer_count');
    expect(expected['@triggers']).toBe('orders_touch');
  });

  // MYSQL uses `mysqldump`/`mysql`, MARIADB uses `mariadb-dump`/`mysql`
  for (const type of ['MARIADB', 'MYSQL'] as const) {
    it.each<BackupFormat>(['COMPRESSED_SQL', 'PLAIN_SQL'])(`${type} %s backup restores to an identical database`, async (format) => {
      const engine = engineFactory(engineConfig(type, MARIADB!, source));
      expect((await engine.testConnection()).success).toBe(true);
      const backup = await engine.backup(out, { format });
      expect(backup.fileName).toMatch(format === 'PLAIN_SQL' ? /\.sql$/ : /\.sql\.gz$/);

      const target = uniq('e2e_my_rst');
      await engine.createDatabase(target);
      try {
        await engine.restore(backup.filePath, target);
        expect(await myFingerprint(target)).toEqual(expected);
        const counts = await engine.countAllTables(target);
        expect(counts.rows).toBe(BigInt(BIG * 2));
      } finally {
        await engine.dropDatabase(target);
      }
    });
  }

  it('a wrong password fails the backup', async () => {
    const engine = engineFactory(engineConfig('MARIADB', MARIADB!, source, { password: 'nope' }));
    await expect(engine.backup(out, { format: 'PLAIN_SQL' })).rejects.toThrow(/Access denied/);
  });
});
