import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type mysql2 from 'mysql2/promise';
import { mysqlDataSync, killQueries, DataSyncStopped } from '../../services/data-sync/mysql-data-sync';
import { MARIADB, uniq, engineConfig, myAdmin } from './helpers';

/** Stop cancels the run's running query instead of waiting for it (E2E_MARIADB_URL). */
describe.skipIf(!MARIADB)('MySQL data sync stop', () => {
  const src = uniq('e2e_stop_src');
  const dst = uniq('e2e_stop_dst');
  const cfg = (db: string) => engineConfig('MYSQL', MARIADB!, db);

  beforeAll(async () => {
    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${src}\`; CREATE DATABASE \`${dst}\``);
      await c.query(`CREATE TABLE \`${src}\`.big (id INT PRIMARY KEY, v TEXT NOT NULL)`);
      await c.query('SET SESSION cte_max_recursion_depth = 1000000');
      await c.query(`INSERT INTO \`${src}\`.big WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 400000) SELECT n, REPEAT('x', 400) FROM s`);
      await c.query(`CREATE TABLE \`${dst}\`.big LIKE \`${src}\`.big`);
      await c.query(`INSERT INTO \`${dst}\`.big SELECT * FROM \`${src}\`.big`);
    });
  }, 120_000);

  afterAll(async () => {
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${src}\`; DROP DATABASE IF EXISTS \`${dst}\``));
  });

  it('killQueries cancels only the given connection\'s statement', async () => {
    await myAdmin(async (busy) => {
      await myAdmin(async (other) => {
        const started = Date.now();
        const sleeping = busy.query('SELECT SLEEP(20)').then(() => 'finished', (e: { errno?: number }) => e.errno);
        const untouched = other.query('SELECT SLEEP(2) AS s');
        await new Promise((r) => setTimeout(r, 300));
        await killQueries(cfg(src), [busy.threadId]);
        // Cancelled: SLEEP returns early (MySQL reports it as a result of 1, MariaDB as error 1317)
        const r = await sleeping;
        expect(Date.now() - started).toBeLessThan(5000);
        expect(r === 'finished' || r === 1317).toBe(true);
        // The other connection ran its full 2 seconds
        const [[row]] = await untouched as unknown as [mysql2.RowDataPacket[]];
        expect(Number(row.s)).toBe(0);
        expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
      });
    });
  }, 30_000);

  it('Stop during one long query ends the run within seconds, and the target is unchanged', async () => {
    // One chunk of 400,000 rows: a single long checksum query on each side
    const t0 = Date.now();
    await mysqlDataSync(cfg(src), cfg(dst), { apply: false, chunkSize: 400_000, parallel: 1 });
    const whole = Date.now() - t0;

    const before = await myAdmin(async (c) => (await c.query<mysql2.RowDataPacket[]>(`CHECKSUM TABLE \`${dst}\`.big`))[0][0].Checksum);
    let stop = false;
    setTimeout(() => { stop = true; }, 150);
    const t1 = Date.now();
    await expect(mysqlDataSync(cfg(src), cfg(dst), { apply: true, chunkSize: 400_000, parallel: 1, shouldStop: () => stop }))
      .rejects.toBeInstanceOf(DataSyncStopped);
    const stopped = Date.now() - t1;
    const after = await myAdmin(async (c) => (await c.query<mysql2.RowDataPacket[]>(`CHECKSUM TABLE \`${dst}\`.big`))[0][0].Checksum);
    expect(String(after)).toBe(String(before));
    // Without killing it would take at least the whole query; allow for the 1s watcher
    console.log(`full compare ${whole} ms, stopped after ${stopped} ms`);
    expect(stopped).toBeLessThan(Math.max(whole, 1500));
  }, 120_000);
});
