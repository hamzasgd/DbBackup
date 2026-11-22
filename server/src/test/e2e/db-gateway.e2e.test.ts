import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import net from 'net';
import path from 'path';
import tls from 'tls';
import mysql2 from 'mysql2/promise';
import { GatewayServer, GatewayAccount, QueryKind } from '../../services/db-gateway/server';
import { passwordHashes, randomPassword } from '../../services/db-gateway/protocol';
import { createBackendUser, dropBackendUser, updateBackendUser } from '../../services/db-gateway/provision';
import { MARIADB, uniq, tmpDir, myAdmin, engineConfig } from './helpers';

/**
 * The database gateway (E2E_MARIADB_URL): clients log in to it with their own
 * user and password, over TLS, and it passes their session through to the
 * database as a user with only the rights they were given.
 */
describe.skipIf(!MARIADB)('Database gateway (MySQL protocol)', () => {
  const db = uniq('e2e_gw');
  const backendUser = uniq('gw').slice(0, 30);
  const backendPassword = randomPassword();
  const password = randomPassword(24);
  const account: GatewayAccount = {
    id: 'acc-1', username: 'ali', ...(() => { const h = passwordHashes(password); return { hashNative: h.native, hashSha2: h.sha2 }; })(),
    enabled: true, expiresAt: null, maxConnections: 3, database: db,
  };
  const log: { kind: QueryKind; sql: string }[] = [];
  const ended: string[] = [];
  let gw: GatewayServer;
  let dir: string;

  const connect = (o: Partial<mysql2.ConnectionOptions> = {}) => mysql2.createConnection({
    host: '127.0.0.1', port: gw.port, user: 'ali', password, database: db,
    ssl: { rejectUnauthorized: false }, ...o,
  });

  beforeAll(async () => {
    dir = tmpDir('dbbk-gw-');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const secureContext = tls.createSecureContext({ cert: fs.readFileSync(path.join(dir, 'cert.pem')), key: fs.readFileSync(path.join(dir, 'key.pem')) });

    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${db}\``);
      await c.query(`CREATE TABLE \`${db}\`.t (id INT PRIMARY KEY, name VARCHAR(50), doc JSON)`);
      await c.query(`INSERT INTO \`${db}\`.t VALUES (1, 'one', '{"a": 1.5}'), (2, 'two', NULL)`);
      // Also @localhost: on servers with an anonymous ''@'localhost' user, that one would match first
      for (const host of ['%', 'localhost']) {
        await c.query(`CREATE USER '${backendUser}'@'${host}' IDENTIFIED BY '${backendPassword}'`);
        await c.query(`GRANT SELECT ON \`${db}\`.* TO '${backendUser}'@'${host}'`);
      }
    });

    gw = new GatewayServer({
      port: 0,
      host: '127.0.0.1',
      requireTls: true,
      secureContext: () => secureContext,
      hooks: {
        findAccount: async (u) => (u === account.username ? account : null),
        openBackend: async () => {
          const socket = net.connect(Number(MARIADB!.port), MARIADB!.hostname);
          await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); });
          return { socket, user: backendUser, password: backendPassword, release: () => {} };
        },
        sessionStarted: async () => uniq('s'),
        query: (_s, _a, kind, sql) => { log.push({ kind, sql }); },
        sessionEnded: (id) => { ended.push(id); },
      },
    });
    await gw.start();
  }, 60_000);

  afterAll(async () => {
    await gw?.stop();
    await myAdmin(async (c) => {
      await c.query(`DROP DATABASE IF EXISTS \`${db}\``);
      await c.query(`DROP USER IF EXISTS '${backendUser}'@'%', '${backendUser}'@'localhost'`);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets the person read, and logs what they ran', async () => {
    const c = await connect();
    const [rows] = await c.query<mysql2.RowDataPacket[]>('SELECT id, name FROM t ORDER BY id');
    expect(rows).toEqual([{ id: 1, name: 'one' }, { id: 2, name: 'two' }]);
    // Prepared statements, several statements at once, and a large result pass through too
    const [one] = await c.execute<mysql2.RowDataPacket[]>('SELECT name FROM t WHERE id = ?', [2]);
    expect(one[0].name).toBe('two');
    const [big] = await c.query<mysql2.RowDataPacket[]>(
      `WITH d AS (SELECT 0 n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
         UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)
       SELECT a.n + 10 * b.n + 100 * c.n + 1000 * e.n + 10000 * f.n i, REPEAT('x', 300) pad
         FROM d a, d b, d c, d e, d f LIMIT 50000`);
    expect(big).toHaveLength(50000);
    await c.end();
    expect(log.some((l) => l.kind === 'QUERY' && l.sql.includes('SELECT id, name FROM t'))).toBe(true);
    expect(log.some((l) => l.kind === 'PREPARE' && l.sql.includes('WHERE id = ?'))).toBe(true);
  }, 60_000);

  it('cannot write: the database refuses it for the user behind the gateway', async () => {
    const c = await connect();
    await expect(c.query("INSERT INTO t VALUES (3, 'three', NULL)")).rejects.toThrow(/denied/i);
    await expect(c.query('DROP TABLE t')).rejects.toThrow(/denied/i);
    // The session is still usable afterwards
    const [rows] = await c.query<mysql2.RowDataPacket[]>('SELECT COUNT(*) n FROM t');
    expect(Number(rows[0].n)).toBe(2);
    await c.end();
  });

  it('refuses a wrong password, an unknown user and a connection without TLS', async () => {
    await expect(connect({ password: 'wrong' })).rejects.toMatchObject({ errno: 1045 });
    await expect(connect({ user: 'nobody' })).rejects.toMatchObject({ errno: 1045 });
    await expect(connect({ ssl: undefined })).rejects.toMatchObject({ errno: 3159 });
  });

  it('refuses another login inside the session', async () => {
    const c = await connect();
    await expect(c.changeUser({ user: 'root' })).rejects.toThrow(/does not allow/);
    c.destroy();
  });

  it('works with the mysql command-line client, with either login method', async () => {
    // Not execFileSync: the gateway runs in this process and must keep answering
    const run = async (extra: string[]) => (await promisify(execFile)('mysql', [
      '-h127.0.0.1', `-P${gw.port}`, '-uali', `-p${password}`, '--ssl-mode=REQUIRED', ...extra, db, '-N', '-e', 'SELECT name FROM t WHERE id = 1',
    ], { encoding: 'utf8' })).stdout.trim();
    expect(await run([])).toBe('one');
    expect(await run(['--default-auth=mysql_native_password'])).toBe('one');
  });

  it('cancels a running query with KILL QUERY and the id the client was given', async () => {
    const a = await connect();
    const b = await connect();
    const id = a.threadId!;
    const slow = a.query('SELECT SLEEP(20) s');
    await new Promise((r) => setTimeout(r, 500));
    await b.query(`KILL QUERY ${id}`);
    const started = Date.now();
    // MySQL returns 1 from an interrupted SLEEP, MariaDB reports the interruption as an error
    const outcome = await slow.then(([rows]) => Number((rows as mysql2.RowDataPacket[])[0].s), (e: Error) => e.message);
    expect(Date.now() - started).toBeLessThan(5000);
    expect([1, 'Query execution was interrupted']).toContain(outcome);
    await a.end();
    await b.end();
  }, 30_000);

  it('keeps to the connection limit, and ends sessions when access is turned off', async () => {
    const open = [await connect(), await connect(), await connect()];
    await expect(connect()).rejects.toMatchObject({ errno: 1040 });
    const before = ended.length;
    expect(gw.closeAccount(account.id, 'Access was turned off')).toBe(3);
    await expect(open[0].query('SELECT 1')).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(ended.length - before).toBe(3);
    for (const c of open) c.destroy();

    account.enabled = false;
    await expect(connect()).rejects.toThrow(/turned off/);
    account.enabled = true;
    account.expiresAt = new Date(Date.now() - 1000);
    await expect(connect()).rejects.toThrow(/expired/);
    account.expiresAt = null;
  });
});

describe.skipIf(!MARIADB)('Database gateway: the database users behind accesses', () => {
  const db = uniq('e2e_gwp');
  const config = () => engineConfig('MYSQL', MARIADB!, db);
  const login = (user: string, password: string) => mysql2.createConnection({
    host: MARIADB!.hostname, port: Number(MARIADB!.port), user, password, database: db,
  });

  beforeAll(async () => {
    await myAdmin(async (c) => {
      await c.query(`CREATE DATABASE \`${db}\``);
      await c.query(`CREATE TABLE \`${db}\`.a (id INT PRIMARY KEY)`);
      await c.query(`CREATE TABLE \`${db}\`.b (id INT PRIMARY KEY)`);
      await c.query(`INSERT INTO \`${db}\`.a VALUES (1)`);
    });
  });

  afterAll(async () => {
    await myAdmin((c) => c.query(`DROP DATABASE IF EXISTS \`${db}\``));
  });

  it('creates a user with only the chosen rights, changes them, and drops it', async () => {
    const u = await createBackendUser(config(), { database: db, tables: ['a'], privileges: ['SELECT'], maxConnections: 2 });
    expect(u.user).toMatch(/^dbb_[0-9a-f]{12}$/);
    // Created for the address the database sees DbBackup at
    const c = await login(u.user, u.password);
    const [rows] = await c.query<mysql2.RowDataPacket[]>('SELECT id FROM a');
    expect(rows).toEqual([{ id: 1 }]);
    await expect(c.query('SELECT id FROM b')).rejects.toThrow(/denied/i);
    await expect(c.query('INSERT INTO a VALUES (2)')).rejects.toThrow(/denied/i);
    c.destroy();

    await updateBackendUser(config(), u.user, u.host, { database: db, tables: [], privileges: ['SELECT', 'INSERT'], maxConnections: 2 });
    const c2 = await login(u.user, u.password);
    await c2.query('INSERT INTO b VALUES (5)');
    const [b] = await c2.query<mysql2.RowDataPacket[]>('SELECT id FROM b');
    expect(b).toEqual([{ id: 5 }]);
    await expect(c2.query('DROP TABLE b')).rejects.toThrow(/denied/i);
    c2.destroy();

    await dropBackendUser(config(), u.user, u.host);
    await expect(login(u.user, u.password)).rejects.toMatchObject({ errno: 1045 });
  });
});
