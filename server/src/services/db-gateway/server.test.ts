import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import {
  CLIENT, COM, GATEWAY_CAPS, MAX_PAYLOAD, Packet, PacketSplitter, Reader, buildErr, buildGreeting, buildOk,
  encodePacket, lenencBytes, nativeToken, newScramble, passwordHashes,
} from './protocol';
import { BackendTarget, GatewayAccount, GatewayOptions, GatewayServer, QueryKind, failureKey } from './server';

/**
 * The gateway in front of a stand-in database, over real sockets. The stand-in
 * knows just enough of MySQL's protocol for the gateway to log in to it; it
 * notes every command it takes as the start of one, and like MySQL it answers
 * a packet with the wrong number with "Packets out of order".
 */
class StandInDatabase {
  private readonly server = net.createServer();
  private readonly sockets = new Set<net.Socket>();
  private nextThread = 100;
  /** Every packet it took as the start of a command */
  readonly commands: { seq: number; cmd: number; sql: string }[] = [];
  /** With `fullAuth`, what the gateway answered when the password itself was asked for (MySQL 8's caching_sha2_password) */
  readonly authReplies: string[] = [];
  private readonly publicKey: Buffer;

  /** `fullAuth`: the first answer is not enough, as for a user MySQL 8 has not seen before */
  constructor(readonly fullAuth = false) {
    this.publicKey = fullAuth
      ? Buffer.from(crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string)
      : Buffer.alloc(0);
  }

  async start(): Promise<number> {
    this.server.on('connection', (sock) => {
      this.sockets.add(sock);
      sock.once('close', () => this.sockets.delete(sock));
      sock.on('error', () => {});
      const splitter = new PacketSplitter();
      let loggedIn = false;
      // The number the next packet must have, and whether it is the rest of a 16 MiB command
      let expected = 1;
      let rest = false;
      sock.on('data', (d: Buffer) => {
        for (const p of splitter.push(d)) {
          if (!loggedIn) {
            if (!this.fullAuth) {
              // The gateway's login (number 1): whoever it says it is
              if (p.seq === 1) {
                loggedIn = true;
                expected = 0;
                sock.write(encodePacket(2, buildOk()));
              }
              continue;
            }
            if (p.seq === 1) {
              sock.write(encodePacket(2, Buffer.from([0x01, 0x04])));
              continue;
            }
            const answer = p.payload[0] === 0x02 ? 'asked for the public key'
              : p.payload.length === 256 ? 'the password RSA-encrypted' : 'the password as it is';
            this.authReplies.push(answer);
            if (p.payload[0] === 0x02) {
              sock.write(encodePacket(p.seq + 1, Buffer.concat([Buffer.from([0x01]), this.publicKey])));
              continue;
            }
            loggedIn = true;
            expected = 0;
            sock.write(encodePacket(p.seq + 1, buildOk()));
            continue;
          }
          if (p.seq !== expected) {
            sock.write(encodePacket(1, buildErr(1835, '70X00', 'Packets out of order')));
            expected = 0;
            rest = false;
            continue;
          }
          if (rest) {
            if (p.payload.length < MAX_PAYLOAD) {
              rest = false;
              expected = 0;
              sock.write(encodePacket(p.seq + 1, buildOk()));
            } else {
              expected = (p.seq + 1) & 0xff;
            }
            continue;
          }
          const cmd = p.payload[0];
          this.commands.push({ seq: p.seq, cmd, sql: cmd === COM.QUERY ? p.payload.subarray(1).toString('utf8') : '' });
          if (cmd === COM.QUIT) {
            sock.end();
            return;
          }
          if (p.payload.length === MAX_PAYLOAD) {
            rest = true;
            expected = (p.seq + 1) & 0xff;
          } else if (cmd === COM.STMT_SEND_LONG_DATA) {
            // Long data gets no answer, so the next packet does not start at 0
            expected = (p.seq + 1) & 0xff;
          } else {
            expected = 0;
            sock.write(encodePacket(p.seq + 1, buildOk()));
          }
        }
      });
      sock.write(encodePacket(0, buildGreeting({
        serverVersion: '8.0.40-stand-in', connectionId: this.nextThread++, scramble: newScramble(), caps: GATEWAY_CAPS,
        charset: 45, status: 0x0002, authPlugin: this.fullAuth ? 'caching_sha2_password' : 'mysql_native_password',
      })));
    });
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      resolve((this.server.address() as net.AddressInfo).port);
    }));
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** A client that speaks just enough MySQL: one login, then the packets a test sends */
class Client {
  private readonly splitter = new PacketSplitter();
  private queue: Packet[] = [];
  private waiter: ((p: Packet | null) => void) | null = null;
  private gone = false;
  readonly closed: Promise<void>;

  private constructor(readonly socket: net.Socket) {
    this.closed = new Promise((resolve) => socket.once('close', () => {
      this.gone = true;
      resolve();
      this.hand();
    }));
    socket.on('error', () => {});
    socket.on('data', (d: Buffer) => {
      for (const p of this.splitter.push(d)) this.queue.push(p);
      this.hand();
    });
  }

  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(new Client(socket)));
      socket.once('error', reject);
    });
  }

  private hand(): void {
    const w = this.waiter;
    if (!w || (!this.queue.length && !this.gone)) return;
    this.waiter = null;
    w(this.queue.shift() ?? null);
  }

  /** The next packet from the gateway, or null once the connection is closed */
  next(): Promise<Packet | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.gone) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  send(seq: number, payload: Buffer): void {
    this.socket.write(encodePacket(seq, payload));
  }

  /** Answers the greeting with a login for `user`, with the native login method (so nothing has to be switched) */
  async login(user: string, password: string): Promise<Packet> {
    const greeting = await this.next();
    if (!greeting) throw new Error('the gateway closed the connection before greeting');
    // Refused at the door: an error where the greeting would be
    if (greeting.payload[0] === 0xff) return greeting;
    const r = new Reader(greeting.payload);
    r.u8();
    r.nulBytes();
    r.u32();
    const first = r.bytes(8);
    // Filler, capabilities, charset, status, capabilities, length of the login data, reserved
    r.bytes(19);
    const scramble = Buffer.concat([first, r.bytes(12)]);
    const head = Buffer.alloc(32);
    head.writeUInt32LE(
      (CLIENT.LONG_PASSWORD | CLIENT.PROTOCOL_41 | CLIENT.SECURE_CONNECTION | CLIENT.PLUGIN_AUTH | CLIENT.PLUGIN_AUTH_LENENC) >>> 0, 0);
    head.writeUInt32LE(1 << 24, 4);
    head[8] = 45;
    this.send(greeting.seq + 1, Buffer.concat([
      head, Buffer.from(`${user}\0`), lenencBytes(nativeToken(password, scramble)), Buffer.from('mysql_native_password\0'),
    ]));
    return (await this.next())!;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting for it');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PASSWORD = 'gateway-password';
const query = (sql: string) => Buffer.concat([Buffer.from([COM.QUERY]), Buffer.from(sql)]);
const anAccount = (id: string, maxConnections = 5): GatewayAccount => {
  const { native, sha2 } = passwordHashes(PASSWORD);
  return { id, username: 'ali', hashNative: native, hashSha2: sha2, enabled: true, expiresAt: null, maxConnections, database: 'shop' };
};

async function startGateway(over: Partial<GatewayOptions> & {
  account?: GatewayAccount; beforeOpen?: () => Promise<void>; target?: Partial<BackendTarget>;
  db?: StandInDatabase; onQuery?: (sql: string) => void;
} = {}) {
  const db = over.db ?? new StandInDatabase();
  const dbPort = await db.start();
  const account = over.account ?? anAccount('acc-1');
  const log: { kind: QueryKind; sql: string }[] = [];
  const ended: string[] = [];
  /** What the gateway put in the operator's log */
  const errors: { what: string; error: unknown }[] = [];
  let sessions = 0;
  const gw = new GatewayServer({
    port: 0, host: '127.0.0.1', requireTls: false, secureContext: () => null, ...over,
    hooks: {
      findAccount: async (u) => (u === account.username ? account : null),
      openBackend: async () => {
        await over.beforeOpen?.();
        const socket = net.connect(dbPort, '127.0.0.1');
        await new Promise<void>((resolve, reject) => {
          socket.once('connect', () => resolve());
          socket.once('error', reject);
        });
        return { socket, user: 'dbb_stand_in', password: 'backend-password', release: () => {}, ...over.target };
      },
      sessionStarted: async () => `session-${++sessions}`,
      query: (_s, _a, kind, sql) => {
        over.onQuery?.(sql);
        log.push({ kind, sql });
      },
      sessionEnded: (id) => { ended.push(id); },
      internalError: (what, error) => { errors.push({ what, error }); },
    },
  });
  await gw.start();
  return {
    gw, db, log, ended, errors, account, port: gw.port,
    close: async () => { await gw.stop(); await db.stop(); },
  };
}

async function loggedIn(port: number) {
  const c = await Client.connect(port);
  const reply = await c.login('ali', PASSWORD);
  expect(reply?.payload[0]).toBe(0x00);
  return c;
}

describe('the gateway in front of a database', () => {
  it('logs in, passes commands on and logs them', async () => {
    const h = await startGateway();
    const c = await loggedIn(h.port);
    c.send(0, query('SELECT 1'));
    expect((await c.next())?.payload[0]).toBe(0x00);
    expect(h.db.commands).toEqual([{ seq: 0, cmd: COM.QUERY, sql: 'SELECT 1' }]);
    expect(h.log).toEqual([{ kind: 'QUERY', sql: 'SELECT 1' }]);
    c.destroy();
    await h.close();
  });

  it('does not let a refused command carry a second one past the checks', async () => {
    const h = await startGateway();
    const c = await loggedIn(h.port);
    // A 16 MiB packet that starts with a refused command, and at once another refused command
    const full = Buffer.alloc(MAX_PAYLOAD);
    full[0] = COM.CHANGE_USER;
    c.socket.write(Buffer.concat([encodePacket(0, full), encodePacket(0, Buffer.from([COM.CHANGE_USER, 1, 2, 3]))]));
    await until(() => h.log.filter((l) => l.kind === 'BLOCKED').length >= 2);
    expect(h.db.commands).toEqual([]);
    c.destroy();
    await h.close();
  });

  it('does not let a refused command carry a query past the log', async () => {
    const h = await startGateway();
    const c = await loggedIn(h.port);
    const full = Buffer.alloc(MAX_PAYLOAD);
    full[0] = COM.SHUTDOWN;
    c.socket.write(Buffer.concat([encodePacket(0, full), encodePacket(0, query('DELETE FROM orders'))]));
    // (Wait for the database to have it, not only for the log: the two are a socket apart)
    await until(() => h.db.commands.length >= 1);
    expect(h.db.commands.map((x) => x.sql)).toEqual(['DELETE FROM orders']);
    expect(h.log).toEqual([
      { kind: 'BLOCKED', sql: '(protocol command 0x8)' },
      { kind: 'QUERY', sql: 'DELETE FROM orders' },
    ]);
    c.destroy();
    await h.close();
  });

  it('passes on the rest of a 16 MiB command, and checks what comes after it', async () => {
    const h = await startGateway();
    const c = await loggedIn(h.port);
    c.send(0, Buffer.concat([Buffer.from([COM.QUERY]), Buffer.alloc(MAX_PAYLOAD - 1, 0x20)]));
    // The rest starts with the number of a refused command, which here is only text
    c.send(1, Buffer.concat([Buffer.from([COM.CHANGE_USER]), Buffer.from(' SELECT 1')]));
    expect((await c.next())?.payload[0]).toBe(0x00);
    expect(h.db.commands).toHaveLength(1);
    expect(h.log.map((l) => l.kind)).toEqual(['QUERY']);
    // The next command starts at 0 again. One with another number that is not a continuation gets the checks
    c.send(1, Buffer.from([COM.CHANGE_USER]));
    expect((await c.next())?.payload[0]).toBe(0xff);
    c.send(0, query('SELECT 2'));
    expect((await c.next())?.payload[0]).toBe(0x00);
    expect(h.db.commands).toHaveLength(2);
    expect(h.log.slice(1)).toEqual([{ kind: 'BLOCKED', sql: '(protocol command 0x11)' }, { kind: 'QUERY', sql: 'SELECT 2' }]);
    c.destroy();
    await h.close();
  });

  it('refuses a login that was still in progress when its access was turned off', async () => {
    let release!: () => void;
    const h = await startGateway({ beforeOpen: () => new Promise<void>((r) => { release = r; }) });
    const c = await Client.connect(h.port);
    const login = c.login('ali', PASSWORD);
    await until(() => !!release);
    expect(h.gw.closeAccount(h.account.id, 'The access was turned off')).toBe(0);
    release();
    const reply = await login;
    expect(reply?.payload[0]).toBe(0xff);
    expect(reply?.payload.subarray(9).toString()).toBe('The access was turned off: connect again');
    expect(h.gw.activeSessions()).toBe(0);
    c.destroy();
    await h.close();
  });

  it('keeps parallel logins to the connection limit', async () => {
    const releases: (() => void)[] = [];
    const h = await startGateway({
      account: anAccount('acc-2', 2),
      beforeOpen: () => new Promise<void>((r) => releases.push(r)),
    });
    const clients = await Promise.all([0, 1, 2, 3].map(() => Client.connect(h.port)));
    let settled = 0;
    const logins = clients.map((c) => c.login('ali', PASSWORD).then((p) => { settled++; return p; }));
    // Two are kept at the database, two have their answer already
    await until(() => releases.length + settled >= clients.length);
    for (const r of releases) r();
    const replies = await Promise.all(logins);
    expect(replies.filter((p) => p!.payload[0] === 0x00)).toHaveLength(2);
    expect(replies.filter((p) => p!.payload[0] === 0xff).map((p) => p!.payload.readUInt16LE(1))).toEqual([1040, 1040]);
    expect(h.gw.activeSessions()).toBe(2);
    clients.forEach((c) => c.destroy());
    await h.close();
  });

  it('answers the 21st simultaneous login from one address with "too many connections"', async () => {
    const releases: (() => void)[] = [];
    const h = await startGateway({
      account: anAccount('acc-3', 50),
      beforeOpen: () => new Promise<void>((r) => releases.push(r)),
    });
    const clients = await Promise.all(Array.from({ length: 24 }, () => Client.connect(h.port)));
    let settled = 0;
    const logins = clients.map((c) => c.login('ali', PASSWORD).then((p) => { settled++; return p; }));
    await until(() => releases.length + settled >= clients.length);
    for (const r of releases) r();
    const replies = (await Promise.all(logins)).map((p) => p!);
    expect(replies.filter((p) => p.payload[0] === 0x00)).toHaveLength(20);
    // Refused before any greeting, with the number MySQL uses for a full server
    const refused = replies.filter((p) => p.payload[0] === 0xff);
    expect(refused).toHaveLength(4);
    expect(refused[0].seq).toBe(0);
    expect(refused[0].payload.readUInt16LE(1)).toBe(1040);
    clients.forEach((c) => c.destroy());
    await h.close();
  });

  it('closes connections beyond the limit at once', async () => {
    const h = await startGateway({ maxConnections: 2 });
    const kept = [await Client.connect(h.port), await Client.connect(h.port)];
    await Promise.all(kept.map((c) => c.next()));
    const oneTooMany = await Client.connect(h.port);
    expect(await oneTooMany.next()).toBeNull();
    kept.forEach((c) => c.destroy());
    await h.close();
  });

  it('does not wait at stop for a connection that is still logging in', async () => {
    const h = await startGateway();
    // Connected, greeted, and then silent
    const silent = await Client.connect(h.port);
    await silent.next();
    const started = Date.now();
    await h.close();
    expect(Date.now() - started).toBeLessThan(3000);
    await silent.closed;
  });

  it('gives up on a TLS handshake that never finishes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbk-gateway-test-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const secureContext = tls.createSecureContext({
      cert: fs.readFileSync(path.join(dir, 'cert.pem')), key: fs.readFileSync(path.join(dir, 'key.pem')),
    });
    fs.rmSync(dir, { recursive: true, force: true });
    const h = await startGateway({ requireTls: true, secureContext: () => secureContext, tlsHandshakeTimeoutMs: 200 });
    const c = await Client.connect(h.port);
    const greeting = await c.next();
    // TLS is asked for, and then the client says nothing more
    const sslRequest = Buffer.alloc(32);
    sslRequest.writeUInt32LE((CLIENT.SSL | CLIENT.LONG_PASSWORD | CLIENT.PROTOCOL_41 | CLIENT.TRANSACTIONS) >>> 0, 0);
    c.send(greeting!.seq + 1, sslRequest);
    const started = Date.now();
    await c.closed;
    expect(Date.now() - started).toBeLessThan(3000);
    await h.close();
  });

  it('does not ask an unprotected database for its public key, unless the operator allowed it or the way is a tunnel', async () => {
    const loginThrough = async (target: Partial<BackendTarget>) => {
      const h = await startGateway({ db: new StandInDatabase(true), target });
      const c = await Client.connect(h.port);
      const reply = await c.login('ali', PASSWORD);
      const out = { reply, answers: [...h.db.authReplies], errors: [...h.errors] };
      c.destroy();
      await h.close();
      return out;
    };
    // Over a plain connection nothing is asked of the database: whatever key came back could be anybody's
    const refused = await loginThrough({});
    expect(refused.answers).toEqual([]);
    expect(refused.reply?.payload[0]).toBe(0xff);
    expect(refused.reply?.payload.subarray(9).toString()).toMatch(/^The gateway could not log in to the database \(reference [0-9a-f]{6}\)\./);
    expect(String((refused.errors[0]?.error as Error)?.message)).toMatch(/full password check over an unencrypted connection/);
    // On a network the operator called private, or inside an SSH tunnel
    for (const target of [{ allowServerPublicKey: true }, { tunnelled: true }]) {
      const allowed = await loginThrough(target);
      expect(allowed.reply?.payload[0]).toBe(0x00);
      expect(allowed.answers).toEqual(['asked for the public key', 'the password RSA-encrypted']);
    }
  });

  it('keeps the database out of its answers: the operator gets the reason in the log, the person a reference', async () => {
    const h = await startGateway({ beforeOpen: async () => { throw new Error('connect ECONNREFUSED 10.0.0.5:3306'); } });
    const c = await Client.connect(h.port);
    const reply = await c.login('ali', PASSWORD);
    const message = reply?.payload.subarray(9).toString() ?? '';
    expect(reply?.payload[0]).toBe(0xff);
    expect(message).toMatch(/^The gateway could not reach the database \(reference [0-9a-f]{6}\)\./);
    expect(message).not.toContain('10.0.0.5');
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0].what).toMatch(/^Could not reach the database \(reference [0-9a-f]{6}\)$/);
    expect(String((h.errors[0].error as Error).message)).toContain('10.0.0.5:3306');
    c.destroy();
    await h.close();
  });

  it('ends only the session whose packet it could not handle', async () => {
    const h = await startGateway({ onQuery: (sql) => { if (sql === 'BOOM') throw new Error('the log is full'); } });
    const a = await loggedIn(h.port);
    const b = await loggedIn(h.port);
    a.send(0, query('BOOM'));
    const answer = await a.next();
    expect(answer?.payload[0]).toBe(0xff);
    expect(answer?.payload.subarray(9).toString()).toMatch(/^The gateway could not handle a packet \(reference [0-9a-f]{6}\)/);
    await until(() => h.ended.length === 1);
    expect(h.errors.map((e) => e.what)).toEqual([expect.stringMatching(/^Packet from the client \(reference [0-9a-f]{6}\)$/)]);
    b.send(0, query('SELECT 1'));
    expect((await b.next())?.payload[0]).toBe(0x00);
    a.destroy();
    b.destroy();
    await h.close();
  });

  it("puts a failing listener in the log instead of the event loop's", async () => {
    const h = await startGateway();
    (h.gw as unknown as { server: net.Server }).server.emit('error', new Error('accept EMFILE'));
    expect(h.errors.map((e) => e.what)).toEqual(['Listener error']);
    await h.close();
  });

  it('greets every client with the version it was given, not with the database\'s', async () => {
    const fixed = await startGateway({ advertisedVersion: '8.0.40' });
    (await loggedIn(fixed.port)).destroy();
    const greeted = await Client.connect(fixed.port);
    expect((await greeted.next())?.payload.includes('stand-in')).toBe(false);
    greeted.destroy();
    await fixed.close();
    // Without the setting, as before: the version the last database reported
    const own = await startGateway();
    (await loggedIn(own.port)).destroy();
    const again = await Client.connect(own.port);
    expect((await again.next())?.payload.includes('stand-in')).toBe(true);
    again.destroy();
    await own.close();
  });

  it('does not let a person change the password of the database user behind their access', async () => {
    const h = await startGateway();
    const c = await loggedIn(h.port);
    for (const sql of ["SET PASSWORD = 'x'", 'ALTER USER USER() IDENTIFIED BY \'x\'', 'rename user CURRENT_USER to \'a\'@\'%\'']) {
      c.send(0, query(sql));
      expect((await c.next())?.payload[0]).toBe(0xff);
    }
    expect(h.db.commands).toEqual([]);
    expect(h.log.map((l) => l.kind)).toEqual(['BLOCKED', 'BLOCKED', 'BLOCKED']);
    // A statement that only talks about it goes through
    c.send(0, query("SELECT 'SET PASSWORD' AS s"));
    expect((await c.next())?.payload[0]).toBe(0x00);
    c.destroy();
    await h.close();
  });

  it('logs the values sent with a prepared statement', async () => {
    const h = await startGateway();
    const c = await loggedIn(h.port);
    // COM_STMT_EXECUTE for statement 5, with three bytes of parameters
    c.send(0, Buffer.concat([Buffer.from([COM.STMT_EXECUTE, 5, 0, 0, 0, 0, 1, 0, 0, 0]), Buffer.from('abc')]));
    expect((await c.next())?.payload[0]).toBe(0x00);
    expect(h.log).toEqual([{ kind: 'EXECUTE', sql: 'EXECUTE #5, 3 bytes of parameters: 616263' }]);
    c.destroy();
    await h.close();
  });

  it('counts failed logins per IPv6 block, and per address for IPv4', () => {
    expect(failureKey('203.0.113.7')).toBe('203.0.113.7');
    expect(failureKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2');
    expect(failureKey('2001:DB8:1:2::7')).toBe(failureKey('2001:db8:1:2:ffff::1'));
  });
});
