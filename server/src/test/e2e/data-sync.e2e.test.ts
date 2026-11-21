import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type mysql2 from 'mysql2/promise';
import { mysqlDataSync, type TableReport } from '../../services/data-sync/mysql-data-sync';
import { MARIADB, uniq, engineConfig, myAdmin } from './helpers';

/** Compare-and-copy-differences between two MySQL/MariaDB databases (E2E_MARIADB_URL). */
describe.skipIf(!MARIADB)('MySQL data sync (compare and copy differences)', () => {
  const src = uniq('e2e_dsync_src');
  const dst = uniq('e2e_dsync_dst');
  const cfg = (db: string) => engineConfig('MYSQL', MARIADB!, db);
  const byTable = (r: TableReport[]) => Object.fromEntries(r.map((x) => [x.table, x]));

  async function checksums(db: string, tables: string[]): Promise<Record<string, string>> {
    return myAdmin(async (c) => {
      const out: Record<string, string> = {};
      for (const t of tables) {
        const [[row]] = await c.query<mysql2.RowDataPacket[]>(`CHECKSUM TABLE \`${db}\`.\`${t}\` EXTENDED`);
        out[t] = String(row.Checksum);
      }
      return out;
    });
  }

  beforeAll(async () => {
    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${src}\`; CREATE DATABASE \`${dst}\``);
      await c.query(`
        CREATE TABLE \`${src}\`.members (
          id INT PRIMARY KEY AUTO_INCREMENT, email VARCHAR(80) NOT NULL UNIQUE, note TEXT NULL, raw VARBINARY(16) NULL,
          amount DECIMAL(30,10) NOT NULL, big BIGINT UNSIGNED NOT NULL, created DATETIME(6) NOT NULL, seen TIMESTAMP NULL,
          doc JSON NULL, flag BIT(1) NOT NULL, ratio DOUBLE NULL, shout VARCHAR(90) AS (UPPER(email)) STORED,
          added DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), touched TIMESTAMP(3) NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP(3));
        CREATE TABLE \`${src}\`.pairs (a INT NOT NULL, b VARCHAR(20) NOT NULL, v TEXT, PRIMARY KEY (a, b));
        CREATE TABLE \`${src}\`.nopk (x INT, y TEXT);
        CREATE TABLE \`${src}\`.shape (id INT PRIMARY KEY, v TEXT);
        CREATE TABLE \`${src}\`.only_src (id INT PRIMARY KEY, v TEXT);
        CREATE TABLE \`${src}\`.AppSettings (id INT PRIMARY KEY, shopId INT NOT NULL, general JSON);
        INSERT INTO \`${src}\`.AppSettings VALUES (1, 10, '{"a": 1}'), (2, 20, '{"b": 2}'), (3, 30, NULL);
        INSERT INTO \`${src}\`.only_src VALUES (1, 'a'), (2, 'b');
        INSERT INTO \`${src}\`.nopk VALUES (1, 'x');
        INSERT INTO \`${src}\`.shape VALUES (1, 'x');
      `);
      const members = Array.from({ length: 12_000 }, (_, i) => [
        `m${i}@example.com`, i % 7 === 0 ? null : `note ${i} it's "q" \\ ${'z'.repeat(i % 30)}`,
        i % 5 === 0 ? null : Buffer.from([i % 256, 0, 255, 39, 34, 92]),
        `${i}.0123456789`, `${BigInt('18446744073709551000') - BigInt(i)}`, `2024-01-0${(i % 9) + 1} 10:20:30.${String(i).padStart(6, '0').slice(-6)}`,
        i % 3 === 0 ? null : '2024-05-05 05:05:05', i % 4 === 0 ? null : JSON.stringify({ i, tags: ['a', 'b'] }), i % 2, i / 7,
      ]);
      for (let i = 0; i < members.length; i += 2000) {
        await c.query(`INSERT INTO \`${src}\`.members (email, note, raw, amount, big, created, seen, doc, flag, ratio) VALUES ?`, [members.slice(i, i + 2000)]);
      }
      await c.query(`INSERT INTO \`${src}\`.pairs VALUES ?`, [Array.from({ length: 900 }, (_, i) => [i % 30, `k${Math.floor(i / 30)}`, `v${i}`])]);
      // Changes spread over the whole table: every chunk of 100 rows differs
      await c.query(`CREATE TABLE \`${src}\`.busy (id INT PRIMARY KEY, v VARCHAR(20) NOT NULL)`);
      await c.query(`INSERT INTO \`${src}\`.busy VALUES ?`, [Array.from({ length: 3000 }, (_, i) => [i + 1, `v${i + 1}`])]);
      await c.query(`CREATE TABLE \`${dst}\`.busy LIKE \`${src}\`.busy`);
      await c.query(`INSERT INTO \`${dst}\`.busy SELECT * FROM \`${src}\`.busy`);
      await c.query(`UPDATE \`${dst}\`.busy SET v = 'old' WHERE id % 40 = 0`);
      await c.query(`DELETE FROM \`${dst}\`.busy WHERE id % 97 = 0`);

      // Target: a copy, then drift
      for (const t of ['members', 'pairs', 'nopk']) {
        await c.query(`CREATE TABLE \`${dst}\`.\`${t}\` LIKE \`${src}\`.\`${t}\``);
        const cols = t === 'members' ? 'id, email, note, raw, amount, big, created, seen, doc, flag, ratio, added, touched' : '*';
        await c.query(`INSERT INTO \`${dst}\`.\`${t}\` ${cols === '*' ? '' : `(${cols})`} SELECT ${cols} FROM \`${src}\`.\`${t}\``);
      }
      await c.query(`
        CREATE TABLE \`${dst}\`.shape (id INT PRIMARY KEY, v TEXT, extra INT);
        CREATE TABLE \`${dst}\`.only_dst (id INT PRIMARY KEY);
        CREATE TABLE \`${dst}\`.appsettings (id INT PRIMARY KEY, shopId INT NOT NULL, general JSON);
        INSERT INTO \`${dst}\`.appsettings VALUES (1, 10, '{"a": 1}'), (2, 99, '{"b": 2}');
        INSERT INTO \`${dst}\`.only_dst VALUES (1);
        DELETE FROM \`${dst}\`.members WHERE id IN (10, 5000, 11999);
        UPDATE \`${dst}\`.members SET note = '' WHERE id = 7;
        UPDATE \`${dst}\`.members SET raw = UNHEX('00') WHERE id = 8;
        UPDATE \`${dst}\`.members SET amount = amount + 0.0000000001 WHERE id = 9;
        UPDATE \`${dst}\`.members SET doc = JSON_OBJECT('i', -1) WHERE id = 11;
        INSERT INTO \`${dst}\`.members (id, email, amount, big, created, flag) VALUES (20001, 'extra@example.com', 1, 1, NOW(), 0);
        DELETE FROM \`${dst}\`.pairs WHERE a = 3 AND b = 'k2';
        UPDATE \`${dst}\`.pairs SET v = 'changed' WHERE a = 4 AND b = 'k5';
      `);
      // Unique values that swapped places in the source after the copy (row 5 in an early chunk, 9000 in a late one)
      await c.query(`
        UPDATE \`${src}\`.members SET email = 'tmp@x' WHERE id = 5;
        UPDATE \`${src}\`.members SET email = 'm4@example.com' WHERE id = 9001;
        UPDATE \`${src}\`.members SET email = 'm9000@example.com' WHERE id = 5;
      `);
    });
  });

  afterAll(async () => {
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${src}\`; DROP DATABASE IF EXISTS \`${dst}\``));
  });

  it('compare reports exactly what differs and writes nothing', async () => {
    const before = await checksums(dst, ['members', 'pairs']);
    const r = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: false, chunkSize: 1000 }));
    expect(r.members).toMatchObject({ status: 'DIFFERENT', rows: 12_000, inserted: 3, updated: 6, deleted: 1 });
    expect(r.members.chunks).toBeGreaterThanOrEqual(12);
    expect(r.pairs).toMatchObject({ status: 'DIFFERENT', inserted: 1, updated: 1, deleted: 0 });
    expect(r.nopk).toMatchObject({ status: 'SKIPPED' });
    expect(r.nopk.reason).toMatch(/no primary key/);
    expect(r.shape).toMatchObject({ status: 'SKIPPED' });
    expect(r.shape.reason).toMatch(/columns differ.*extra/);
    expect(r.only_src).toMatchObject({ status: 'ONLY_IN_SOURCE' });
    expect(r.only_dst).toMatchObject({ status: 'ONLY_IN_TARGET' });
    // Same table, name stored in lowercase on the target: matched, not "missing"
    expect(r.AppSettings).toMatchObject({ status: 'DIFFERENT', targetTable: 'appsettings', inserted: 1, updated: 1, deleted: 0 });
    expect(r.appsettings).toBeUndefined();
    expect(await checksums(dst, ['members', 'pairs'])).toEqual(before);
  });

  it('gives the same answer one chunk at a time and many at once, with multi-column keys split into chunks', async () => {
    const one = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: false, chunkSize: 100, parallel: 1, tables: ['members', 'pairs'] }));
    const many = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: false, chunkSize: 100, parallel: 8, tables: ['members', 'pairs'] }));
    for (const r of [one, many]) {
      expect(r.members).toMatchObject({ status: 'DIFFERENT', rows: 12_000, inserted: 3, updated: 6, deleted: 1 });
      // 900 rows keyed by (a, b): every row lands in exactly one chunk
      expect(r.pairs).toMatchObject({ status: 'DIFFERENT', rows: 900, inserted: 1, updated: 1, deleted: 0 });
      expect(r.pairs.chunks).toBeGreaterThanOrEqual(9);
    }
    expect(many.members.chunks).toBe(one.members.chunks);
  });

  it('finds every difference when changes are spread over every chunk', async () => {
    // 75 rows changed (every 40th) and 30 missing (every 97th), in all 30 chunks
    for (const parallel of [1, 8]) {
      const r = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: false, chunkSize: 100, parallel, tables: ['busy'] }));
      expect(r.busy).toMatchObject({ status: 'DIFFERENT', rows: 3000, inserted: 30, updated: 75, deleted: 0 });
      expect(r.busy.chunksDifferent).toBe(30);
    }
  });

  it('apply copies only the differences and leaves the tables identical', async () => {
    const progress: number[] = [];
    const r = byTable(await mysqlDataSync(cfg(src), cfg(dst), {
      apply: true, chunkSize: 1000, onProgress: (p) => progress.push(p.rowsChecked),
    }));
    expect(r.members.reason).toBeUndefined();
    expect(r.members).toMatchObject({ status: 'SYNCED', inserted: 3, updated: 6, deleted: 1 });
    expect(r.pairs).toMatchObject({ status: 'SYNCED' });
    // The schema step creates the missing table first; then its rows are copied
    expect(r.only_src).toMatchObject({ status: 'SYNCED', inserted: 2 });
    expect(r.AppSettings).toMatchObject({ status: 'SYNCED', targetTable: 'appsettings' });
    const [srcApp, dstApp] = await Promise.all([
      myAdmin(async (c) => (await c.query<mysql2.RowDataPacket[]>(`CHECKSUM TABLE \`${src}\`.AppSettings EXTENDED`))[0][0].Checksum),
      myAdmin(async (c) => (await c.query<mysql2.RowDataPacket[]>(`CHECKSUM TABLE \`${dst}\`.appsettings EXTENDED`))[0][0].Checksum),
    ]);
    expect(String(dstApp)).toBe(String(srcApp));
    expect(r.shape.status).toBe('SKIPPED');
    expect(progress.at(-1)).toBeGreaterThanOrEqual(12_000);

    expect(r.busy).toMatchObject({ status: 'SYNCED', inserted: 30, updated: 75, deleted: 0 });
    const tables = ['members', 'pairs', 'only_src', 'busy'];
    expect(await checksums(dst, tables)).toEqual(await checksums(src, tables));

    // A second run finds nothing left to do
    const again = byTable(await mysqlDataSync(cfg(src), cfg(dst), { apply: false, chunkSize: 1000 }));
    for (const t of tables) expect(again[t].status, t).toBe('SAME');
  });
});
