import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type mysql2 from 'mysql2/promise';
import { mysqlDataSync } from '../../services/data-sync/mysql-data-sync';
import { MARIADB, uniq, engineConfig, myAdmin } from './helpers';

/**
 * FLOAT and DOUBLE values copy exactly (E2E_MARIADB_URL). MySQL shows a FLOAT
 * with 6 digits, and mysql2 could misread the last digit of a DOUBLE, so a
 * copy through JavaScript numbers changed them slightly, and comparing their
 * text hid the FLOAT changes.
 */
describe.skipIf(!MARIADB)('MySQL data sync: floating point values', () => {
  const src = uniq('e2e_float_src');
  const dst = uniq('e2e_float_dst');
  const cfg = (db: string) => engineConfig('MYSQL', MARIADB!, db);
  const N = 2000;
  const unequal = () => myAdmin(async (c) => {
    const [r] = await c.query<mysql2.RowDataPacket[]>(
      `SELECT COUNT(*) n, SUM(NOT (a.f <=> b.f)) f, SUM(NOT (a.d <=> b.d)) d
         FROM \`${src}\`.m a LEFT JOIN \`${dst}\`.m b USING (id)`);
    return { n: Number(r[0].n), f: Number(r[0].f), d: Number(r[0].d) };
  });

  beforeAll(async () => {
    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${src}\`; CREATE DATABASE \`${dst}\``);
      await c.query(`CREATE TABLE \`${src}\`.m (id INT PRIMARY KEY, f FLOAT, d DOUBLE, v VARCHAR(10))`);
      // Values with every digit used, small and large
      const values = Array.from({ length: N }, (_, i) => [i + 1, Math.sin(i + 1) * 10 ** ((i % 12) - 4), Math.cos(i + 1) * 1e6, `r${i}`]);
      await c.query(`INSERT INTO \`${src}\`.m VALUES ?`, [values]);
      await c.query(`CREATE TABLE \`${dst}\`.m LIKE \`${src}\`.m`);
    });
  });

  afterAll(async () => {
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${src}\`; DROP DATABASE IF EXISTS \`${dst}\``));
  });

  it('copies every FLOAT and DOUBLE bit for bit', async () => {
    const [r] = await mysqlDataSync(cfg(src), cfg(dst), { apply: true });
    expect(r).toMatchObject({ table: 'm', status: 'SYNCED', inserted: N });
    expect(await unequal()).toEqual({ n: N, f: 0, d: 0 });
  }, 120_000);

  it('sees values that differ only in the last digits, and fixes them', async () => {
    // What an earlier copy through JavaScript numbers left behind: FLOATs rounded to 6 digits
    await myAdmin((c) => c.query(`UPDATE \`${dst}\`.m SET f = CAST(CAST(f AS CHAR) AS DECIMAL(65,30)) WHERE id % 10 = 0`));
    const before = await unequal();
    expect(before.f).toBeGreaterThan(50);

    const [cmp] = await mysqlDataSync(cfg(src), cfg(dst), { apply: false });
    expect(cmp).toMatchObject({ status: 'DIFFERENT', updated: before.f, inserted: 0, deleted: 0 });
    // A few of them named, with the column that differs and both values
    expect(cmp.examples).toHaveLength(5);
    for (const ex of cmp.examples!) {
      expect(ex.kind).toBe('CHANGED');
      expect(ex.key).toMatch(/^id=\d+$/);
      expect(ex.columns).toHaveLength(1);
      expect(ex.columns![0].name).toBe('f');
      expect(ex.columns![0].source).not.toBe(ex.columns![0].target);
    }

    const [sync] = await mysqlDataSync(cfg(src), cfg(dst), { apply: true });
    expect(sync).toMatchObject({ status: 'SYNCED', updated: before.f });
    expect(await unequal()).toEqual({ n: N, f: 0, d: 0 });
  }, 120_000);

  it('writes numbers inside JSON exactly, and sees a JSON number off in the last bit', async () => {
    const isMaria = await myAdmin(async (c) => /mariadb/i.test(String((await c.query<mysql2.RowDataPacket[]>('SELECT VERSION() v'))[0][0].v)));
    if (isMaria) return; // MariaDB keeps JSON as text, exactly as written
    await myAdmin(async (c) => {
      await c.query(`CREATE TABLE \`${src}\`.j (id INT PRIMARY KEY, meta JSON)`);
      await c.query(`INSERT INTO \`${src}\`.j VALUES
        (1, JSON_OBJECT('a', CAST('5.684341886080802e-14' AS DOUBLE), 'n', 12345678901234567890, 'list', JSON_ARRAY(0.1, 2, JSON_OBJECT('k"q', CAST('1.0000000000000002' AS DOUBLE))))),
        (2, '{"plain": "text", "i": 7}'), (3, NULL)`);
    });
    const [first] = (await mysqlDataSync(cfg(src), cfg(dst), { apply: true, tables: ['j'] }));
    expect(first).toMatchObject({ inserted: 3 }); // the schema step creates the table first
    const exactSame = () => myAdmin(async (c) => Number((await c.query<mysql2.RowDataPacket[]>(
      `SELECT COUNT(*) n FROM \`${src}\`.j a JOIN \`${dst}\`.j b USING (id)
        WHERE JSON_EXTRACT(a.meta, '$.a') <=> JSON_EXTRACT(b.meta, '$.a') AND a.meta <=> b.meta`))[0][0].n));
    expect(await exactSame()).toBe(3);

    // What a server whose JSON parser rounds wrong leaves behind: the last bit off
    await myAdmin((c) => c.query(`UPDATE \`${dst}\`.j SET meta = JSON_SET(meta, '$.a', CAST('5.684341886080803e-14' AS DOUBLE)) WHERE id = 1`));
    const [cmp] = await mysqlDataSync(cfg(src), cfg(dst), { apply: false, tables: ['j'] });
    expect(cmp).toMatchObject({ status: 'DIFFERENT', updated: 1 });
    expect(cmp.examples?.[0]).toMatchObject({ key: 'id=1', kind: 'CHANGED', columns: [{ name: 'meta' }] });

    const [sync] = await mysqlDataSync(cfg(src), cfg(dst), { apply: true, tables: ['j'] });
    expect(sync).toMatchObject({ status: 'SYNCED', updated: 1 });
    expect(await exactSame()).toBe(3);
    const [again] = await mysqlDataSync(cfg(src), cfg(dst), { apply: false, tables: ['j'] });
    expect(again.status).toBe('SAME');
  }, 120_000);
});
