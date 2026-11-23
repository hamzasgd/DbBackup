import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { Duplex } from 'stream';
import {
  CLIENT, COM, GATEWAY_CAPS, MAX_PAYLOAD, Packet, PacketSplitter, Reader, buildErr, buildGreeting, buildOk,
  encodePacket, lenencBytes, nativeToken, newScramble, passwordHashes,
} from './protocol';
import { BackendTarget, GatewayAccount, GatewayOptions, GatewayServer, QueryKind, failureKey } from './server';

/** A stand-in database: enough of MySQL for the gateway to log in, and a note of what it was asked */
interface StandIn {
  start(): Promise<number>;
  stop(): Promise<void>;
  readonly commands: { seq: number; cmd: number; sql: string }[];
  readonly authReplies: string[];
}

/** A one-day self-signed certificate for TLS tests */
function selfSigned(): tls.SecureContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbk-gateway-test-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const context = tls.createSecureContext({
    cert: fs.readFileSync(path.join(dir, 'cert.pem')), key: fs.readFileSync(path.join(dir, 'key.pem')),
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return context;
}

/** The socket with bytes already read from it put back in front (TLS may start in the same read as the request for it) */
function withLeftover(socket: net.Socket, left: Buffer): Duplex {
  const joined = new Duplex({
    read() { socket.resume(); },
    write(chunk, _enc, cb) { socket.write(chunk, cb); },
    final(cb) { socket.end(); cb(); },
    destroy(err, cb) { socket.destroy(err ?? undefined); cb(err); },
  });
  joined.push(left);
  socket.on('data', (d: Buffer) => { if (!joined.push(d)) socket.pause(); });
  socket.on('end', () => joined.push(null));
  socket.on('error', (e) => joined.destroy(e));
  socket.on('close', () => joined.destroy());
  return joined;
}

/**
 * The gateway in front of a stand-in database, over real sockets. The stand-in
 * knows just enough of MySQL's protocol for the gateway to log in to it; it
 * notes every command it takes as the start of one, and like MySQL it answers
 * a packet with the wrong number with "Packets out of order".
 */
class StandInDatabase implements StandIn {
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
            // The request for the key is the single byte 0x02 (an encrypted password may start with 0x02 too)
            const askedForTheKey = p.payload.length === 1 && p.payload[0] === 0x02;
            this.authReplies.push(askedForTheKey ? 'asked for the public key'
              : p.payload.length === 256 ? 'the password RSA-encrypted' : 'the password as it is');
            if (askedForTheKey) {
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

/**
 * MySQL 8 as the gateway reaches it over TLS: TLS is offered, and after the
 * login packet the password itself is asked for. It notes what was answered.
 */
class TlsFullAuthDatabase implements StandIn {
  private readonly server = net.createServer();
  private readonly sockets = new Set<net.Socket>();
  readonly commands: { seq: number; cmd: number; sql: string }[] = [];
  readonly authReplies: string[] = [];

  constructor(private readonly secureContext: tls.SecureContext) {}

  start(): Promise<number> {
    this.server.on('connection', (sock) => {
      this.sockets.add(sock);
      sock.on('error', () => {});
      const splitter = new PacketSplitter();
      // 0: waiting for the request for TLS, 1: for the login, 2: for the password itself, 3: done
      let step = 0;
      let stream: Duplex = sock;
      const onData = (d: Buffer) => {
        for (const p of splitter.push(d)) {
          if (step === 0 && p.seq === 1 && p.payload.length === 32) {
            const left = splitter.rest();
            stream.off('data', onData);
            const secure = new tls.TLSSocket(left.length ? withLeftover(sock, left) : sock, { isServer: true, secureContext: this.secureContext });
            this.sockets.add(secure);
            secure.on('error', () => {});
            stream = secure;
            secure.on('data', onData);
            step = 1;
          } else if (step === 1) {
            step = 2;
            stream.write(encodePacket(p.seq + 1, Buffer.from([0x01, 0x04])));
          } else if (step === 2) {
            this.authReplies.push(p.payload.length === 1 && p.payload[0] === 0x02 ? 'asked for the public key' : 'the password as it is');
            step = 3;
            stream.write(encodePacket(p.seq + 1, buildOk()));
          }
        }
      };
      stream.on('data', onData);
      sock.write(encodePacket(0, buildGreeting({
        serverVersion: '8.0.40-stand-in', connectionId: 7, scramble: newScramble(), caps: GATEWAY_CAPS | CLIENT.SSL,
        charset: 45, status: 0x0002, authPlugin: 'caching_sha2_password',
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
  /** Where packets are written: the socket, or the TLS connection over it */
  private stream: net.Socket;
  readonly closed: Promise<void>;

  private constructor(readonly socket: net.Socket) {
    this.closed = new Promise((resolve) => socket.once('close', () => {
      this.gone = true;
      resolve();
      this.hand();
    }));
    socket.on('error', () => {});
    socket.on('data', this.onData);
    this.stream = socket;
  }

  private readonly onData = (d: Buffer) => {
    for (const p of this.splitter.push(d)) this.queue.push(p);
    this.hand();
  };

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
    this.stream.write(encodePacket(seq, payload));
  }

  /**
   * TLS on the connection, as MySQL clients ask for it right after the greeting. The request for it
   * is packet number `seq`; the TLS start follows it at once, in the next write.
   */
  private async startTls(seq: number): Promise<void> {
    const request = Buffer.alloc(32);
    request.writeUInt32LE((CLIENT.SSL | CLIENT.LONG_PASSWORD | CLIENT.PROTOCOL_41 | CLIENT.TRANSACTIONS) >>> 0, 0);
    this.send(seq, request);
    const secure = tls.connect({ socket: this.socket, rejectUnauthorized: false });
    this.socket.off('data', this.onData);
    secure.on('error', () => {});
    secure.on('data', this.onData);
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    });
    this.stream = secure;
  }

  /** The gateway's greeting: its number and its scramble, so the login can be answered */
  private async takeGreeting(): Promise<{ seq: number; scramble: Buffer } | Packet> {
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
    return { seq: greeting.seq, scramble: Buffer.concat([first, r.bytes(12)]) };
  }

  /** The login packet number `seq`, for `user` (the native login method, so nothing has to be switched), `database` and `charset` if given */
  private answer(seq: number, user: string, password: string, scramble: Buffer, database: string | undefined, charset: number): void {
    const head = Buffer.alloc(32);
    head.writeUInt32LE(
      (CLIENT.LONG_PASSWORD | CLIENT.PROTOCOL_41 | CLIENT.SECURE_CONNECTION | CLIENT.PLUGIN_AUTH | CLIENT.PLUGIN_AUTH_LENENC
        | (database ? CLIENT.CONNECT_WITH_DB : 0)) >>> 0, 0);
    head.writeUInt32LE(1 << 24, 4);
    head[8] = charset;
    this.send(seq, Buffer.concat([
      head, Buffer.from(`${user}\0`), lenencBytes(nativeToken(password, scramble)),
      ...(database ? [Buffer.from(`${database}\0`)] : []), Buffer.from('mysql_native_password\0'),
    ]));
  }

  /** Answers the greeting with a login for `user` (the native login method, so nothing has to be switched), `database` and `charset` if given */
  async login(user: string, password: string, database?: string, charset = 45): Promise<Packet> {
    const greeting = await this.takeGreeting();
    if ('payload' in greeting) return greeting;
    this.answer(greeting.seq + 1, user, password, greeting.scramble, database, charset);
    return (await this.next())!;
  }

  /** The same over TLS: it is asked for with number 1, so the login is number 2 */
  async loginOverTls(user: string, password: string, database?: string, charset = 45): Promise<Packet> {
    const greeting = await this.takeGreeting();
    if ('payload' in greeting) return greeting;
    await this.startTls(greeting.seq + 1);
    this.answer(greeting.seq + 2, user, password, greeting.scramble, database, charset);
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
/** COM.QUERY with text that is already in the session's character set */
const queryBytes = (text: Buffer) => Buffer.concat([Buffer.from([COM.QUERY]), text]);
const anAccount = (id: string, maxConnections = 5): GatewayAccount => {
  const { native, sha2 } = passwordHashes(PASSWORD);
  return { id, username: 'ali', hashNative: native, hashSha2: sha2, enabled: true, expiresAt: null, maxConnections, database: 'shop' };
};

async function startGateway(over: Partial<GatewayOptions> & {
  account?: GatewayAccount; beforeOpen?: () => Promise<void>; target?: Partial<BackendTarget>;
  db?: StandIn; onQuery?: (sql: string) => void;
} = {}) {
  const db = over.db ?? new StandInDatabase();
  const dbPort = await db.start();
  const account = over.account ?? anAccount('acc-1');
  const log: { kind: QueryKind; sql: string }[] = [];
  const ended: string[] = [];
  /** What the gateway put in the operator's log */
  const errors: { what: string; error: unknown }[] = [];
  /** Wrong passwords that were actually checked (a login refused before that does not count) */
  const guesses: string[] = [];
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
      loginFailed: (_username, _ip, reason) => { if (reason === 'wrong password') guesses.push(reason); },
      internalError: (what, error) => { errors.push({ what, error }); },
    },
  });
  await gw.start();
  return {
    gw, db, log, ended, errors, guesses, account, port: gw.port,
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
    const secureContext = selfSigned();
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

  it('takes a login over TLS from a real client, whose TLS start follows the request for it back to back', async () => {
    const secureContext = selfSigned();
    const h = await startGateway({ requireTls: true, secureContext: () => secureContext });
    const wrong = await Client.connect(h.port);
    expect((await wrong.loginOverTls('ali', 'wrong')).payload[0]).toBe(0xff);
    wrong.destroy();
    const c = await Client.connect(h.port);
    expect((await c.loginOverTls('ali', PASSWORD)).payload[0]).toBe(0x00);
    c.send(0, query('SELECT 1'));
    expect((await c.next())?.payload[0]).toBe(0x00);
    expect(h.db.commands.map((x) => x.sql)).toEqual(['SELECT 1']);
    c.destroy();
    await h.close();
  });

  it('does not ask an unprotected database for its public key, unless the network is trusted or the way is a tunnel', async () => {
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
    for (const target of [{ trustNetwork: true }, { protected: true }]) {
      const allowed = await loginThrough(target);
      expect(allowed.reply?.payload[0]).toBe(0x00);
      expect(allowed.answers).toEqual(['asked for the public key', 'the password RSA-encrypted']);
    }
  });

  it('gives the password inside TLS only to a database whose certificate was checked, or on a network the operator trusts', async () => {
    const secureContext = selfSigned();
    const loginThrough = async (target: Partial<BackendTarget>) => {
      const h = await startGateway({ db: new TlsFullAuthDatabase(secureContext), target });
      const c = await Client.connect(h.port);
      const reply = await c.login('ali', PASSWORD);
      const out = { reply, answers: [...h.db.authReplies], errors: [...h.errors] };
      c.destroy();
      await h.close();
      return out;
    };
    // Encrypted, but nobody checked who is at the other end: a machine on the way ends the TLS and reads it
    const unverified = { tls: { rejectUnauthorized: false } };
    const refused = await loginThrough(unverified);
    expect(refused.answers).toEqual([]);
    expect(refused.reply?.payload[0]).toBe(0xff);
    expect(String((refused.errors[0]?.error as Error)?.message)).toMatch(/inside TLS whose certificate is not checked/);
    // With the certificate checked against a CA, or inside an SSH tunnel; or on a network the operator called private
    for (const target of [{ ...unverified, protected: true }, { ...unverified, trustNetwork: true }]) {
      const allowed = await loginThrough(target);
      expect(allowed.reply?.payload[0]).toBe(0x00);
      expect(allowed.answers).toEqual(['the password as it is']);
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

  it('greets every client with a version of its own, never with the database\'s', async () => {
    // Clients get the greeting before they log in: the database's version is not for them
    const set = await startGateway({ advertisedVersion: '8.0.40' });
    (await loggedIn(set.port)).destroy();
    const greeted = await Client.connect(set.port);
    expect((await greeted.next())?.payload.includes('8.0.40\0')).toBe(true);
    greeted.destroy();
    await set.close();
    const own = await startGateway();
    (await loggedIn(own.port)).destroy();
    const again = await Client.connect(own.port);
    const greeting = (await again.next())?.payload.toString('latin1') ?? '';
    expect(greeting.includes('stand-in')).toBe(false);
    expect(greeting.includes('8.0.40\0')).toBe(true);
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

  it('logs what a session sends in the character set it uses, and follows a change of it', async () => {
    const h = await startGateway();
    const c = await Client.connect(h.port);
    // 8 is latin1
    expect((await c.login('ali', PASSWORD, undefined, 8)).payload[0]).toBe(0x00);
    // SELECT 'caf<e9>': "café" in latin1
    c.send(0, queryBytes(Buffer.from("SELECT 'caf\xe9'", 'latin1')));
    expect((await c.next())?.payload[0]).toBe(0x00);
    c.send(0, query('SET NAMES gbk'));
    expect((await c.next())?.payload[0]).toBe(0x00);
    // SELECT '<d6 d0>': "中" in gbk
    c.send(0, queryBytes(Buffer.from("SELECT '\xd6\xd0'", 'latin1')));
    expect((await c.next())?.payload[0]).toBe(0x00);
    expect(h.log.map((l) => l.sql)).toEqual(["SELECT 'café'", 'SET NAMES gbk', "SELECT '中'"]);
    c.destroy();
    await h.close();
  });

  it('counts failed logins per IPv6 block, and per address for IPv4', () => {
    expect(failureKey('203.0.113.7')).toBe('203.0.113.7');
    expect(failureKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2');
    expect(failureKey('2001:DB8:1:2::7')).toBe(failureKey('2001:db8:1:2:ffff::1'));
  });

  it('does not let parallel attempts get more guesses into a window than the address is allowed', async () => {
    const h = await startGateway();
    for (let i = 0; i < 5; i++) {
      const c = await Client.connect(h.port);
      await c.login('ali', 'wrong');
      c.destroy();
    }
    expect(h.guesses).toHaveLength(5);
    // 30 at once. The limit is 10 failures per 15 minutes, and logins in progress count towards it, so at most
    // 15 more are checked (before: all 20 that the address may have open went through, 25 in all)
    const clients = await Promise.all(Array.from({ length: 30 }, () => Client.connect(h.port)));
    await Promise.all(clients.map((c) => c.login('ali', 'wrong')));
    clients.forEach((c) => c.destroy());
    expect(h.guesses.length).toBeLessThanOrEqual(20);
    await h.close();
  });

  it('logs the database a login picks, and the commands that change a session', async () => {
    const h = await startGateway();
    const c = await Client.connect(h.port);
    expect((await c.login('ali', PASSWORD, 'reports')).payload[0]).toBe(0x00);
    // The access's own database is "shop": another one is a change of session, like USE
    expect(h.log).toEqual([{ kind: 'USE', sql: 'USE reports' }]);
    const commands: { payload: Buffer; text: string; answered?: boolean }[] = [
      { payload: Buffer.from([COM.RESET_CONNECTION]), text: 'RESET CONNECTION' },
      { payload: Buffer.from([COM.SET_OPTION, 1, 0]), text: 'SET OPTION multi statements on' },
      { payload: Buffer.from([COM.PROCESS_KILL, 7, 0, 0, 0]), text: 'KILL CONNECTION 7' },
      // The database does not answer this one
      { payload: Buffer.concat([Buffer.from([COM.STMT_SEND_LONG_DATA, 1, 0, 0, 0, 0, 0]), Buffer.from('data')]), text: 'SEND LONG DATA (4 bytes)', answered: false },
    ];
    for (const { payload, answered = true } of commands) {
      c.send(0, payload);
      if (answered) expect((await c.next())?.payload[0]).toBe(0x00);
    }
    await until(() => h.log.length >= 5);
    expect(h.log.slice(1)).toEqual(commands.map(({ text }) => ({ kind: 'COMMAND', sql: text })));
    c.destroy();
    await h.close();
  });

  it('ends a session that keeps sending what is not allowed', async () => {
    const h = await startGateway();
    const a = await loggedIn(h.port);
    // A hundred at once: the database never sees them, so nothing slows them down but the gateway
    a.socket.write(Buffer.concat(Array.from({ length: 100 }, (_, i) => encodePacket(0, Buffer.from([COM.CHANGE_USER, i])))));
    a.socket.end();
    await a.closed;
    expect(h.log.filter((l) => l.kind === 'BLOCKED')).toHaveLength(100);
    expect(h.log.every((l) => l.kind === 'BLOCKED')).toBe(true);
    expect(h.ended).toEqual(['session-1']);
    expect(h.db.commands).toEqual([]);
    await h.close();
  });

  it('counts the commands the database does not answer past two thousand, instead of logging each', async () => {
    const h = await startGateway();
    const a = await loggedIn(h.port);
    const data = Buffer.concat([Buffer.from([COM.STMT_SEND_LONG_DATA, 1, 0, 0, 0, 0, 0]), Buffer.from('x')]);
    const packets = Array.from({ length: 2100 }, (_, n) => encodePacket(n % 256, data));
    for (let i = 0; i < packets.length; i += 100) a.socket.write(Buffer.concat(packets.slice(i, i + 100)));
    // Every one of them has passed the gateway once the database has them all
    await until(() => h.db.commands.length >= 2100);
    expect(h.log).toHaveLength(2000);
    // What was counted and not logged is said once, when the session ends
    a.destroy();
    await until(() => h.ended.length === 1);
    expect(h.log.slice(0, 2000).every((l) => l.kind === 'COMMAND')).toBe(true);
    expect(h.log[2000]).toEqual({ kind: 'COMMAND', sql: '(100 more commands of this kind, not logged one by one)' });
    await h.close();
  });
});
