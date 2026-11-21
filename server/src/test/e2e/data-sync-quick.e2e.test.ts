import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type mysql2 from 'mysql2/promise';
import { mysqlDataSync, type TableReport } from '../../services/data-sync/mysql-data-sync';
import { MARIADB, uniq, engineConfig, myAdmin } from './helpers';

/** Quick sync: only rows changed since the last sync (by updatedAt), plus new and deleted rows (E2E_MARIADB_URL). */
describe.skipIf(!MARIADB)('MySQL quick sync (updatedAt)', () => {
  const src = uniq('e2e_qsync_src');
  const dst = uniq('e2e_qsync_dst');
  const cfg = (db: string) => engineConfig('MYSQL', MARIADB!, db);
  const byTable = (r: TableReport[]) => Object.fromEntries(r.map((x) => [x.table, x]));
  const quick = { since: '2026-06-01 00:00:00', minRows: 0 };
  const checksum = (db: string, t: string) =>
    myAdmin(async (c) => String((await c.query<mysql2.RowDataPacket[]>(`CHECKSUM TABLE \`${db}\`.\`${t}\` EXTENDED`))[0][0].Checksum));

  beforeAll(async () => {
    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${src}\`; CREATE DATABASE \`${dst}\``);
      await c.query(`
        CREATE TABLE \`${src}\`.orders (id INT PRIMARY KEY AUTO_INCREMENT, shop INT NOT NULL, v VARCHAR(40) NOT NULL,
          updatedAt DATETIME(3) NOT NULL, INDEX (updatedAt), INDEX (shop));
        CREATE TABLE \`${src}\`.pairs (a INT NOT NULL, b VARCHAR(10) NOT NULL, v TEXT, updated_at TIMESTAMP(3) NULL, PRIMARY KEY (a, b), INDEX (updated_at));
        CREATE TABLE \`${src}\`.plain (id INT PRIMARY KEY, v TEXT);
      `);
      await c.query(`INSERT INTO \`${src}\`.orders (id, shop, v, updatedAt) VALUES ?`,
        [Array.from({ length: 3000 }, (_, i) => [i + 1, i % 7, `v${i + 1}`, '2026-01-01 00:00:00'])]);
      await c.query(`INSERT INTO \`${src}\`.pairs VALUES ?`, [Array.from({ length: 1000 }, (_, i) => [i % 50, `k${Math.floor(i / 50)}`, `p${i}`, '2026-01-01 00:00:00'])]);
      await c.query(`INSERT INTO \`${src}\`.plain VALUES ?`, [Array.from({ length: 500 }, (_, i) => [i + 1, `x${i}`])]);
      for (const t of ['orders', 'pairs', 'plain']) {
        await c.query(`CREATE TABLE \`${dst}\`.\`${t}\` LIKE \`${src}\`.\`${t}\``);
        await c.query(`INSERT INTO \`${dst}\`.\`${t}\` SELECT * FROM \`${src}\`.\`${t}\``);
      }
      // After the last sync, on the source:
      await c.query(`
        UPDATE \`${src}\`.orders SET v = CONCAT(v, '!'), updatedAt = '2026-07-01 10:00:00' WHERE id % 150 = 0;
        INSERT INTO \`${src}\`.orders (id, shop, v, updatedAt) SELECT 3000 + seq, 1, 'new', '2026-07-01 11:00:00'
          FROM (SELECT 1 seq UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) s;
        DELETE FROM \`${src}\`.orders WHERE id IN (3, 777, 1500, 2222, 2999);
        INSERT INTO \`${src}\`.orders (id, shop, v, updatedAt) VALUES (5000, 1, 'old timestamp', '2025-01-01 00:00:00');
        UPDATE \`${src}\`.orders SET v = 'sneaky' WHERE id = 5;
        UPDATE \`${src}\`.pairs SET v = 'changed', updated_at = '2026-07-01 00:00:00' WHERE a = 1 AND b IN ('k1', 'k2', 'k3');
        DELETE FROM \`${src}\`.pairs WHERE a = 2 AND b IN ('k4', 'k5');
        UPDATE \`${src}\`.plain SET v = 'changed' WHERE id = 42;
      `);
    });
  });

  afterAll(async () => {
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${src}\`; DROP DATABASE IF EXISTS \`${dst}\``));
  });

  it('quick compare finds changed, new and deleted rows from updatedAt and the keys', async () => {
    let sourceTime = '';
    const r = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: false, quick, onStart: (s) => { sourceTime = s.sourceTime; } }));
    expect(sourceTime).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
    // 19 changed (every 150th, but 1500 was deleted); 5 new + 1 new with an old timestamp; 5 deleted. The change that left updatedAt alone is not seen.
    expect(r.orders).toMatchObject({ method: 'QUICK', status: 'DIFFERENT', updated: 19, inserted: 6, deleted: 5 });
    expect(r.orders.rows).toBe(24); // rows with updatedAt after "since"
    // Multi-column key and the row counts differ: compared in full instead
    expect(r.pairs).toMatchObject({ method: 'FULL', status: 'DIFFERENT', updated: 3, inserted: 0, deleted: 2 });
    expect(r.pairs.note).toMatch(/row counts differed/);
    expect(r.plain).toMatchObject({ method: 'FULL', status: 'DIFFERENT', updated: 1 });
  });

  it('quick sync copies those differences; a full compare then finds only the change that skipped updatedAt', async () => {
    const r = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: true, quick, parallel: 2 }));
    expect(r.orders).toMatchObject({ method: 'QUICK', status: 'SYNCED', updated: 19, inserted: 6, deleted: 5 });
    expect(r.pairs).toMatchObject({ status: 'SYNCED' });
    expect(await checksum(dst, 'pairs')).toBe(await checksum(src, 'pairs'));
    expect(await checksum(dst, 'plain')).toBe(await checksum(src, 'plain'));

    const again = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: false, quick }));
    // Re-reads the 24 recently changed rows; all match now
    expect(again.orders).toMatchObject({ method: 'QUICK', status: 'SAME', rows: 24 });

    const full = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: true }));
    expect(full.orders).toMatchObject({ method: 'FULL', status: 'SYNCED', updated: 1, inserted: 0, deleted: 0 });
    expect(await checksum(dst, 'orders')).toBe(await checksum(src, 'orders'));
  });
});
