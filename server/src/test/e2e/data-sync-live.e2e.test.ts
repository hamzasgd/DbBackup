import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type mysql2 from 'mysql2/promise';
import {
  startLiveStream, checkLiveSource, binlogHead, LiveSyncError,
  type BinlogPosition, type LiveStream,
} from '../../services/data-sync/mysql-live';
import { MARIADB, uniq, engineConfig, myAdmin } from './helpers';

/**
 * Live sync: follow the source's binary log and apply each change to the
 * target (E2E_MARIADB_URL, with binary logging on).
 */
describe.skipIf(!MARIADB)('MySQL live sync (binary log)', () => {
  const src = uniq('e2e_live_src');
  const dst = uniq('e2e_live_dst');
  const odd = uniq('e2e_live_odd');
  const cfg = (db: string) => engineConfig('MYSQL', MARIADB!, db);
  const TABLES = ['AppSettings', 'types', 'pairs', 'moves', 'nokey', 'wiped'];
  let binlogOn = false;
  let start: BinlogPosition;
  let rowMetadata: string | null = null;
  const setRowMetadata = (v: string) => myAdmin((c) => c.query(`SET GLOBAL binlog_row_metadata = '${v}'`));

  const checksum = (db: string, t: string) =>
    myAdmin(async (c) => String((await c.query<mysql2.RowDataPacket[]>(`CHECKSUM TABLE \`${db}\`.\`${t}\` EXTENDED`))[0][0].Checksum));
  const count = (db: string, t: string) =>
    myAdmin(async (c) => Number((await c.query<mysql2.RowDataPacket[]>(`SELECT COUNT(*) n FROM \`${db}\`.\`${t}\``))[0][0].n));

  /** Follow from `from` until everything up to the log's end now is applied */
  async function follow(from: BinlogPosition, serverId: number, notes: string[] = []) {
    let at = from;
    const stats = { inserted: 0, updated: 0, deleted: 0, transactions: 0 };
    const stream: LiveStream = await startLiveStream(cfg(src), cfg(dst), {
      serverId,
      start: from,
      onProgress: (p) => {
        at = p.position;
        stats.inserted += p.inserted; stats.updated += p.updated; stats.deleted += p.deleted; stats.transactions += p.transactions;
      },
      onNote: (n) => notes.push(n),
    });
    let failed: unknown = null;
    stream.done.catch((e) => { failed = e; });
    const head = await myAdmin(binlogHead);
    const deadline = Date.now() + 30_000;
    while (!failed && (at.file < head.file || (at.file === head.file && at.pos < head.pos) || stream.pending() > 0)) {
      if (Date.now() > deadline) throw new Error(`not caught up: at ${at.file}:${at.pos}, head ${head.file}:${head.pos}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    await stream.stop();
    if (failed) throw failed;
    return { at, stats };
  }

  beforeAll(async () => {
    binlogOn = await myAdmin(async (c) => {
      const [r] = await c.query<mysql2.RowDataPacket[]>("SHOW GLOBAL VARIABLES LIKE 'log_bin'");
      return /^(ON|1)$/i.test(String(r[0]?.Value));
    });
    if (!binlogOn) return;
    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${src}\` CHARACTER SET utf8mb4; CREATE DATABASE \`${dst}\` CHARACTER SET utf8mb4; CREATE DATABASE \`${odd}\``);
      await c.query(`
        CREATE TABLE \`${src}\`.AppSettings (id INT PRIMARY KEY, k VARCHAR(40) NOT NULL UNIQUE, v TEXT);
        CREATE TABLE \`${src}\`.types (
          id BIGINT UNSIGNED PRIMARY KEY, d DECIMAL(20,6), dt DATETIME(6), ts TIMESTAMP(3) NULL, dd DATE, tm TIME(3),
          j JSON, b BLOB, bi BIT(10), e ENUM('a','b','x'), s SET('p','q','r'), f FLOAT, db DOUBLE, y YEAR,
          vc VARCHAR(20) CHARACTER SET latin1, u VARCHAR(40), g INT AS (CHAR_LENGTH(u)) VIRTUAL,
          created DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3));
        CREATE TABLE \`${src}\`.pairs (a INT NOT NULL, b VARCHAR(10) NOT NULL, v TEXT, PRIMARY KEY (a, b));
        CREATE TABLE \`${src}\`.moves (id INT PRIMARY KEY, v VARCHAR(10));
        CREATE TABLE \`${src}\`.nokey (x INT, v VARCHAR(10));
        CREATE TABLE \`${src}\`.wiped (id INT PRIMARY KEY);
      `);
      await c.query(`INSERT INTO \`${src}\`.AppSettings VALUES (1, 'a', 'one'), (2, 'b', 'two'), (3, 'c', 'three')`);
      await c.query(`INSERT INTO \`${src}\`.pairs VALUES ?`, [Array.from({ length: 100 }, (_, i) => [i % 10, `k${Math.floor(i / 10)}`, `p${i}`])]);
      await c.query(`INSERT INTO \`${src}\`.moves VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d')`);
      await c.query(`INSERT INTO \`${src}\`.wiped VALUES (1),(2),(3)`);
      for (const t of TABLES) {
        // The target keeps table names in lowercase for this one, like lower_case_table_names=1
        const name = t === 'AppSettings' ? 'appsettings' : t;
        await c.query(`CREATE TABLE \`${dst}\`.\`${name}\` LIKE \`${src}\`.\`${t}\``);
        // types has a generated column, which can't be written
        const cols = t === 'types' ? '(id,d,dt,ts,dd,tm,j,b,bi,e,s,f,db,y,vc,u,created)' : '';
        await c.query(`INSERT INTO \`${dst}\`.\`${name}\` ${cols} SELECT ${cols ? cols.slice(1, -1) : '*'} FROM \`${src}\`.\`${t}\``);
      }
      await c.query(`CREATE TABLE \`${odd}\`.t (id INT PRIMARY KEY, e ENUM('a','b,c'))`);
    });
    // Column names in the log itself, as recommended (RDS: parameter group), so a column added
    // while Live sync is behind is read right
    rowMetadata = await myAdmin(async (c) => {
      const [r] = await c.query<mysql2.RowDataPacket[]>("SHOW GLOBAL VARIABLES LIKE 'binlog_row_metadata'");
      return r[0] ? String(r[0].Value) : null;
    });
    if (rowMetadata) await setRowMetadata('FULL');
    start = await myAdmin(binlogHead);
    // Changes on the source after the target was copied
    await myAdmin(async (c) => {
      await c.query(`SET time_zone = '+05:00'; SET sql_mode = '';
        INSERT INTO \`${src}\`.types (id,d,dt,ts,dd,tm,j,b,bi,e,s,f,db,y,vc,u) VALUES
          (18446744073709551615, -12345678901234.123456, '2026-11-21 09:00:00.123456', '2026-11-21 14:00:00.123', '2026-02-03', '-12:34:56.789',
           '{"a":[1,2,{"b":null}],"big":12345678901234567890,"f":5.684341886080802e-14,"g":[0.1,{"h":1.0000000000000002}]}', X'00FF10', b'1010101010', 'b', 'p,r', 1.1, 3.141592653589793, 2026, 'café', 'ç日本🙂'),
          (2, NULL, '0000-00-00 00:00:00', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '', NULL, NULL, NULL, '', '');
        UPDATE \`${src}\`.types SET u = 'changed' WHERE id = 2;
        UPDATE \`${src}\`.AppSettings SET v = 'uno' WHERE id = 1;
        INSERT INTO \`${src}\`.AppSettings VALUES (4, 'd', 'four');
        DELETE FROM \`${src}\`.AppSettings WHERE id = 3;
        -- a unique value moves from one row to another
        UPDATE \`${src}\`.AppSettings SET k = 'z' WHERE id = 2;
        INSERT INTO \`${src}\`.AppSettings VALUES (5, 'b', 'took b');
        UPDATE \`${src}\`.pairs SET v = 'changed' WHERE a = 1;
        DELETE FROM \`${src}\`.pairs WHERE a = 2 AND b IN ('k3', 'k4');
        -- keys shifted in place: each row's new key is the next row's old key
        UPDATE \`${src}\`.moves SET id = id + 1 ORDER BY id DESC;
        UPDATE \`${src}\`.moves SET id = id + 100 WHERE id = 3;
        INSERT INTO \`${src}\`.nokey VALUES (1, 'x');
        TRUNCATE TABLE \`${src}\`.wiped;
        INSERT INTO \`${src}\`.wiped VALUES (9);
      `);
      // A transaction rolled back never reaches the log; one committed arrives whole
      await c.query(`START TRANSACTION; INSERT INTO \`${src}\`.moves VALUES (500, 'rolled'); ROLLBACK`);
      await c.query(`START TRANSACTION; INSERT INTO \`${src}\`.moves VALUES (600, 'kept'); UPDATE \`${src}\`.pairs SET v = 'tx' WHERE a = 9; COMMIT`);
      // Schema changes: a new column, then a new table, both used right away
      await c.query(`ALTER TABLE \`${src}\`.AppSettings ADD COLUMN note VARCHAR(20) NULL; UPDATE \`${src}\`.AppSettings SET note = 'n' WHERE id = 1`);
      await c.query(`CREATE TABLE \`${src}\`.fresh (id INT PRIMARY KEY, v TEXT); INSERT INTO \`${src}\`.fresh VALUES (1, 'new table')`);
    });
  }, 60_000);

  afterAll(async () => {
    if (rowMetadata) await setRowMetadata(rowMetadata);
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${src}\`; DROP DATABASE IF EXISTS \`${dst}\`; DROP DATABASE IF EXISTS \`${odd}\``));
  });

  it('checks the source: settings, privileges, and what it cannot copy', async () => {
    if (!binlogOn) return;
    const check = await checkLiveSource(cfg(src));
    expect(check.problems).toEqual([]);
    expect(check.position.file).toBeTruthy();
    expect(check.warnings.join(' ')).toContain('no primary key');
    expect(check.warnings.join(' ')).toContain('nokey');

    const bad = await checkLiveSource(cfg(odd));
    expect(bad.problems.join(' ')).toContain('t.e');
  });

  it('applies every change in order, so the target ends up the same as the source', async () => {
    if (!binlogOn) return;
    const notes: string[] = [];
    const { stats } = await follow(start, 7_700_001, notes);
    expect(stats.transactions).toBeGreaterThan(10);

    for (const t of ['types', 'pairs', 'moves', 'wiped', 'fresh']) {
      expect(await checksum(dst, t), t).toBe(await checksum(src, t));
    }
    // Case: the source's AppSettings is the target's appsettings; its new column came along
    expect(await checksum(dst, 'appsettings')).toBe(await checksum(src, 'AppSettings'));
    expect(await count(dst, 'moves')).toBe(5);
    expect(await count(dst, 'wiped')).toBe(1);
    // No primary key: not copied, and said so
    expect(await count(dst, 'nokey')).toBe(0);
    expect(notes.join(' ')).toContain('nokey');

    // Values exactly as on the source (dates in UTC, unsigned 64-bit, JSON, bits)
    const row = await myAdmin(async (c) => (await c.query<mysql2.RowDataPacket[]>(
      `SELECT CAST(id AS CHAR) id, CAST(ts AS CHAR) ts, CAST(dt AS CHAR) dt, CAST(JSON_EXTRACT(j, '$.big') AS CHAR) big, HEX(bi) bi, u, g
         FROM \`${dst}\`.types t WHERE t.id > 100`))[0][0]);
    expect(row).toMatchObject({ id: '18446744073709551615', ts: '2026-11-21 09:00:00.123', dt: '2026-11-21 09:00:00.123456', bi: '2AA', u: 'ç日本🙂', g: 4 });
    expect(String(row.big)).toBe('12345678901234567890');
  }, 60_000);

  it('can apply the same changes again (after a restart) without changing the result', async () => {
    if (!binlogOn) return;
    await follow(start, 7_700_002);
    for (const t of ['types', 'pairs', 'moves', 'wiped', 'fresh']) {
      expect(await checksum(dst, t), t).toBe(await checksum(src, t));
    }
    expect(await checksum(dst, 'appsettings')).toBe(await checksum(src, 'AppSettings'));
  }, 60_000);

  it('says so when the saved position is gone from the source', async () => {
    if (!binlogOn) return;
    const stream = await startLiveStream(cfg(src), cfg(dst), { serverId: 7_700_003, start: { file: 'no-such-binlog.000001', pos: 4 }, onProgress: () => undefined });
    const err = await Promise.race([stream.done.then(() => 'still running'), new Promise((r) => setTimeout(() => r('timeout'), 10_000))]).catch((e) => e);
    await stream.stop();
    expect(err).toBeInstanceOf(LiveSyncError);
    expect((err as LiveSyncError).kind).toBe('RESYNC');
  }, 30_000);

  it('without column names in the log, stops for a catch-up instead of misreading changes made before a column was added', async () => {
    if (!binlogOn || !rowMetadata) return;
    await setRowMetadata('MINIMAL');
    try {
      await myAdmin((c) => c.query(`CREATE TABLE \`${src}\`.later (id INT PRIMARY KEY, v TEXT); CREATE TABLE \`${dst}\`.later LIKE \`${src}\`.later`));
      const from = await myAdmin(binlogHead);
      await myAdmin((c) => c.query(`INSERT INTO \`${src}\`.later VALUES (1, 'before'); ALTER TABLE \`${src}\`.later ADD COLUMN extra INT`));
      const err = await follow(from, 7_700_004).catch((e) => e);
      expect(err).toBeInstanceOf(LiveSyncError);
      expect((err as LiveSyncError).kind).toBe('RESYNC');
    } finally {
      await setRowMetadata('FULL');
    }
  }, 30_000);
});
