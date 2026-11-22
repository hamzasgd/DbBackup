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
});
