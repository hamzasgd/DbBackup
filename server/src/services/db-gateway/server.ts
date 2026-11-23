import net from 'net';
import tls from 'tls';
import type { Duplex } from 'stream';
import { PacketChannel } from './channel';
import { BackendError, loginBackend } from './backend';
import {
  BLOCKED_COMMANDS, CLIENT, COM, GATEWAY_CAPS, MAX_PAYLOAD, PacketSplitter, buildAuthSwitch, buildErr,
  buildGreeting, checkNative, checkSha2, encodePacket, newScramble, parseHandshakeResponse,
} from './protocol';

/** A person's access, as the gateway needs it to let them in */
export interface GatewayAccount {
  id: string;
  username: string;
  /** SHA1(SHA1(password)) and SHA256(SHA256(password)), hex */
  hashNative: string;
  hashSha2: string;
  enabled: boolean;
  expiresAt: Date | null;
  maxConnections: number;
  database: string;
}

/** A connection to the database, opened for one session */
export interface BackendTarget {
  socket: net.Socket;
  user: string;
  password: string;
  tls?: tls.ConnectionOptions;
  /** Called once the session ends (e.g. to give back an SSH tunnel) */
  release(): void;
}

export type QueryKind = 'QUERY' | 'PREPARE' | 'USE' | 'BLOCKED';

export interface SessionInfo {
  accountId: string;
  clientIp: string;
  clientProgram: string | null;
  serverVersion: string;
}

export interface GatewayHooks {
  findAccount(username: string): Promise<GatewayAccount | null>;
  openBackend(account: GatewayAccount): Promise<BackendTarget>;
  sessionStarted(info: SessionInfo): Promise<string>;
  query(sessionId: string, accountId: string, kind: QueryKind, sql: string): void;
  sessionEnded(sessionId: string, stats: { bytesIn: number; bytesOut: number; queries: number; error: string | null }): void;
  /** Login failures, so they can be shown and rate limited */
  loginFailed?(username: string, clientIp: string, reason: string): void;
}

export interface GatewayOptions {
  port: number;
  host?: string;
  /** TLS for clients; null while no certificate is set */
  secureContext: () => tls.SecureContext | null;
  requireTls: boolean;
  /** The most connections at once, logged in or not (default 500). The gateway shares its process with the rest of DbBackup */
  maxConnections?: number;
  /** How long a client may take over its TLS handshake (default 10 seconds) */
  tlsHandshakeTimeoutMs?: number;
  hooks: GatewayHooks;
}

interface Session {
  gatewayId: number;
  sessionId: string;
  accountId: string;
  backendThreadId: number;
  close(reason?: string): void;
}

const ER_ACCESS_DENIED = 1045;
const ER_CON_COUNT = 1040;
const ER_SECURE_TRANSPORT = 3159;
const ER_UNKNOWN = 1105;

/** Failed logins allowed per address before it is shut out for a while */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60_000;
/** Logins in progress at once from one address: a client opens a few connections, never dozens */
const MAX_LOGINS_PER_ADDRESS = 20;
/** The most connections at once unless set (DB_GATEWAY_MAX_CONNECTIONS) */
const DEFAULT_MAX_CONNECTIONS = 500;
const DEFAULT_TLS_HANDSHAKE_MS = 10_000;
/** Login names are at most 32 characters when made; a longer one is refused without a lookup */
const MAX_USERNAME = 64;

/**
 * Thrown by openBackend when the access stopped being usable since the login
 * check: it gets the "access denied" answer, not "could not reach the database".
 */
export class AccessUnavailable extends Error {}

/** "KILL [QUERY|CONNECTION] <id>", with the id the gateway gave the session */
const KILL_RE = /^\s*KILL\s+(QUERY\s+|CONNECTION\s+)?(\d+)\s*;?\s*$/i;

export class GatewayServer {
  private server: net.Server | null = null;
  private sessions = new Map<number, Session>();
  private nextId = 1000 + Math.floor(Math.random() * 1000);
  private failures = new Map<string, number[]>();
  /** The version clients are greeted with: the last one a database reported */
  private serverVersion = '8.0.40';
  /** Connections not logged in yet: they hold no session, so stop() ends them itself */
  private pending = new Set<net.Socket>();
  /** Logins in progress, per address */
  private logins = new Map<string, number>();
  /** Logins in progress, per access: they count towards its connection limit */
  private loggingIn = new Map<string, number>();
  /** Counts, per access, how often its sessions were closed. A login still in progress compares it */
  private epochs = new Map<string, number>();
  private closeReasons = new Map<string, string>();

  constructor(private readonly o: GatewayOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        this.handle(sock).catch(() => sock.destroy());
      });
      // Beyond this the connection is closed at once: enough are left for the rest of DbBackup
      server.maxConnections = this.o.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
      server.once('error', reject);
      server.listen(this.o.port, this.o.host, () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    });
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : this.o.port;
  }

  async stop(): Promise<void> {
    for (const s of this.sessions.values()) s.close('The gateway is shutting down');
    // Without this one silent client would keep the server from closing for good
    for (const sock of this.pending) sock.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  activeSessions(accountId?: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (!accountId || s.accountId === accountId) n++;
    return n;
  }

  /** The accesses that have open sessions, for a sweep */
  openAccounts(): string[] {
    return [...new Set([...this.sessions.values()].map((s) => s.accountId))];
  }

  /** End every session of an account (access turned off, changed or removed) */
  closeAccount(accountId: string, reason: string): number {
    // A login still in progress must not start a session after this
    this.epochs.set(accountId, (this.epochs.get(accountId) ?? 0) + 1);
    this.closeReasons.set(accountId, reason);
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === accountId) {
        s.close(reason);
        n++;
      }
    }
    return n;
  }

  /** Why the access can no longer be used, if its sessions were closed since `epoch` */
  private closedSince(accountId: string, epoch: number): string | null {
    return (this.epochs.get(accountId) ?? 0) === epoch ? null : (this.closeReasons.get(accountId) ?? 'The access was changed');
  }

  closeSession(sessionId: string, reason: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.sessionId === sessionId) {
        s.close(reason);
        return true;
      }
    }
    return false;
  }

  private shutOut(ip: string): boolean {
    const now = Date.now();
    const recent = (this.failures.get(ip) ?? []).filter((t) => now - t < FAILURE_WINDOW_MS);
    this.failures.set(ip, recent);
    return recent.length >= MAX_FAILURES;
  }

  private failed(ip: string): void {
    const list = this.failures.get(ip) ?? [];
    list.push(Date.now());
    this.failures.set(ip, list);
    if (this.failures.size > 10_000) this.failures.clear();
  }

  private async handle(sock: net.Socket): Promise<void> {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 60_000);
    const ip = (sock.remoteAddress ?? '').replace(/^::ffff:/, '');
    if ((this.logins.get(ip) ?? 0) >= MAX_LOGINS_PER_ADDRESS) {
      // Before any greeting, as a full database answers. Nobody reads this socket, so an error must not go uncaught
      sock.on('error', () => sock.destroy());
      sock.write(encodePacket(0, buildErr(ER_CON_COUNT, '08004',
        'Too many connections from this address are logging in to the DbBackup gateway at once. Try again in a moment.')), () => sock.end());
      // Whatever it sends now is dropped, not kept
      sock.resume();
      setTimeout(() => sock.destroy(), 1000).unref();
      return;
    }
    this.logins.set(ip, (this.logins.get(ip) ?? 0) + 1);
    this.pending.add(sock);
    sock.once('close', () => this.pending.delete(sock));
    try {
      await this.login(sock, ip);
    } finally {
      // Over once login() returns: the connection is a session now, or it is being closed
      const n = (this.logins.get(ip) ?? 1) - 1;
      if (n > 0) this.logins.set(ip, n);
      else this.logins.delete(ip);
    }
  }

  private async login(sock: net.Socket, ip: string): Promise<void> {
    const gatewayId = this.nextId++;
    const scramble = newScramble();
    const secureContext = this.o.secureContext();
    const ch = new PacketChannel(sock);
    let stream: Duplex = sock;
    let seq = 0;
    const send = (payload: Buffer) => ch.write(++seq, payload);
    const refuse = (code: number, state: string, message: string) => {
      send(buildErr(code, state, message));
      ch.detach();
      // The channel's error listener is gone with detach(): a reset in the second left must not go uncaught
      stream.on('error', () => stream.destroy());
      stream.end();
      setTimeout(() => stream.destroy(), 1000).unref();
    };

    try {
      ch.write(0, buildGreeting({
        serverVersion: this.serverVersion,
        connectionId: gatewayId,
        scramble,
        caps: GATEWAY_CAPS | (secureContext ? CLIENT.SSL : 0),
        charset: 45, // utf8mb4_general_ci: known to MySQL and MariaDB alike
        status: 0x0002,
        authPlugin: 'caching_sha2_password',
      }));

      let p = await ch.next();
      seq = p.seq;
      let hello = parseHandshakeResponse(p.payload);
      if (hello.sslRequest) {
        if (!secureContext) return refuse(ER_UNKNOWN, 'HY000', 'TLS is not set up on this gateway');
        const raw = ch.pauseForTls();
        const secure = new tls.TLSSocket(raw as net.Socket, { isServer: true, secureContext });
        stream = secure;
        await new Promise<void>((resolve, reject) => {
          // A client that starts TLS and then falls silent must not hold its connection open for good
          const timer = setTimeout(
            () => reject(new Error('the TLS handshake did not finish in time')),
            this.o.tlsHandshakeTimeoutMs ?? DEFAULT_TLS_HANDSHAKE_MS,
          );
          const up = () => {
            clearTimeout(timer);
            secure.off('close', down);
            resolve();
          };
          const down = () => {
            clearTimeout(timer);
            reject(new Error('the TLS connection was closed'));
          };
          secure.once('secure', up);
          secure.once('error', down);
          secure.once('close', down);
        });
        ch.use(secure);
        p = await ch.next();
        seq = p.seq;
        hello = parseHandshakeResponse(p.payload);
      } else if (this.o.requireTls) {
        return refuse(ER_SECURE_TRANSPORT, 'HY000', 'Connections to the DbBackup gateway must use SSL/TLS: turn on SSL (mode REQUIRED) in your client');
      }

      if (this.shutOut(ip)) {
        return refuse(ER_ACCESS_DENIED, '28000', 'Too many failed logins from your address. Try again in 15 minutes.');
      }

      // The password check. Clients that start with another method are asked to switch.
      // Login names are at most 32 characters: a longer one belongs to nobody, and is neither looked up nor logged in full
      if (hello.user.length > MAX_USERNAME) hello.user = `${hello.user.slice(0, MAX_USERNAME)}…`;
      const account = await this.o.hooks.findAccount(hello.user);
      let plugin = hello.authPlugin;
      let token = hello.authData;
      const usable = (plugin === 'caching_sha2_password' && token.length === 32) || (plugin === 'mysql_native_password' && token.length === 20);
      if (!usable) {
        send(buildAuthSwitch('caching_sha2_password', scramble));
        p = await ch.next();
        seq = p.seq;
        plugin = 'caching_sha2_password';
        token = p.payload;
      }
      // Checked against a dummy hash when the user doesn't exist, so the answer takes the same time
      const ok = plugin === 'mysql_native_password'
        ? checkNative(token, scramble, account?.hashNative ?? '00'.repeat(20))
        : checkSha2(token, scramble, account?.hashSha2 ?? '00'.repeat(32));
      if (!account || !ok) {
        this.failed(ip);
        this.o.hooks.loginFailed?.(hello.user, ip, account ? 'wrong password' : 'unknown user');
        await new Promise((r) => setTimeout(r, 300));
        return refuse(ER_ACCESS_DENIED, '28000', `Access denied for user '${hello.user}'`);
      }
      if (plugin === 'caching_sha2_password') send(Buffer.from([0x01, 0x03])); // fast login accepted

      if (!account.enabled) {
        this.o.hooks.loginFailed?.(hello.user, ip, 'turned off');
        return refuse(ER_ACCESS_DENIED, '28000', `Access for '${hello.user}' is turned off`);
      }
      if (account.expiresAt && account.expiresAt.getTime() <= Date.now()) {
        this.o.hooks.loginFailed?.(hello.user, ip, 'expired');
        return refuse(ER_ACCESS_DENIED, '28000', `Access for '${hello.user}' has expired`);
      }
      // Logins still in progress count too, so parallel logins cannot get over the limit
      if (this.activeSessions(account.id) + (this.loggingIn.get(account.id) ?? 0) >= account.maxConnections) {
        return refuse(ER_CON_COUNT, '08004', `'${hello.user}' already has ${account.maxConnections} open connection(s), the most allowed`);
      }
      this.loggingIn.set(account.id, (this.loggingIn.get(account.id) ?? 0) + 1);
      // Changes if the access is turned off, changed or removed while this login is still in progress
      const epoch = this.epochs.get(account.id) ?? 0;
      const ended = (): string | null => this.closedSince(account.id, epoch)
        ?? (account.expiresAt && account.expiresAt.getTime() <= Date.now() ? 'Access has expired' : null);
      try {
        // Log in to the database with the same session flags the client chose
        const clientCaps = hello.caps & (GATEWAY_CAPS | CLIENT.SSL);
        let target: BackendTarget;
        try {
          target = await this.o.hooks.openBackend(account);
        } catch (e) {
          if (e instanceof AccessUnavailable) return refuse(ER_ACCESS_DENIED, '28000', `${(e as Error).message}: connect again`);
          return refuse(2003, 'HY000', `The gateway could not reach the database: ${(e as Error).message}`);
        }
        const clientProgram = hello.attrs.program_name ?? hello.attrs._client_name ?? null;
        let backend;
        try {
          backend = await loginBackend(target.socket, {
            user: target.user,
            password: target.password,
            database: hello.database || account.database,
            clientCaps,
            charset: hello.charset,
            maxPacket: hello.maxPacket,
            tls: target.tls,
            attrs: {
              _client_name: 'DbBackup gateway',
              program_name: `dbbackup-gateway (${account.username})`,
              ...(clientProgram ? { gateway_client: clientProgram.slice(0, 64) } : {}),
            },
          });
        } catch (e) {
          target.release();
          const be = e as BackendError;
          return refuse(be.code ?? 2013, be.sqlState ?? 'HY000', be.message);
        }
        this.serverVersion = backend.serverVersion;

        // The access may have been turned off, changed or removed while the database was logging in: then there is no session
        let sessionId = '';
        let why = ended();
        if (!why) {
          sessionId = await this.o.hooks.sessionStarted({ accountId: account.id, clientIp: ip, clientProgram, serverVersion: backend.serverVersion });
          why = ended();
          if (why) this.o.hooks.sessionEnded(sessionId, { bytesIn: 0, bytesOut: 0, queries: 0, error: why });
        }
        if (why) {
          backend.stream.destroy();
          target.release();
          return refuse(ER_ACCESS_DENIED, '28000', `${why}: connect again`);
        }

        send(backend.ok);
        const clientLeft = ch.detach();
        // From here on the session ends this connection itself
        this.pending.delete(sock);
        this.relay({
          gatewayId, sessionId, account, client: stream, backend: backend.stream, backendThreadId: backend.threadId,
          clientLeft, backendLeft: backend.leftover, release: target.release,
        });
      } finally {
        const n = (this.loggingIn.get(account.id) ?? 1) - 1;
        if (n > 0) this.loggingIn.set(account.id, n);
        else this.loggingIn.delete(account.id);
      }
    } catch (e) {
      ch.detach();
      stream.destroy();
      sock.destroy();
    }
  }

  private relay(r: {
    gatewayId: number; sessionId: string; account: GatewayAccount; client: Duplex; backend: Duplex;
    backendThreadId: number; clientLeft: Buffer; backendLeft: Buffer; release(): void;
  }): void {
    const { client, backend, account, sessionId } = r;
    const stats = { bytesIn: 0, bytesOut: 0, queries: 0, error: null as string | null };
    let closed = false;
    const close = (reason?: string) => {
      if (closed) return;
      closed = true;
      this.sessions.delete(r.gatewayId);
      if (reason) {
        stats.error = reason;
        // Tell the client why, if it is waiting for an answer
        try {
          client.write(encodePacket(1, buildErr(1927, '70100', reason)));
        } catch { /* already gone */ }
      }
      client.end();
      backend.destroy();
      setTimeout(() => client.destroy(), 1000).unref();
      r.release();
      this.o.hooks.sessionEnded(sessionId, stats);
    };
    this.sessions.set(r.gatewayId, { gatewayId: r.gatewayId, sessionId, accountId: account.id, backendThreadId: r.backendThreadId, close });

    // Database → client: unchanged
    const toClient = (d: Buffer) => {
      stats.bytesOut += d.length;
      if (!client.write(d)) {
        backend.pause();
        client.once('drain', () => backend.resume());
      }
    };
    if (r.backendLeft.length) toClient(r.backendLeft);
    backend.on('data', toClient);

    // Client → database: packet by packet, so commands can be logged and some refused
    const splitter = new PacketSplitter();
    // The last packet passed on was a full 16 MiB part: the next packet with the next number continues it
    let continuing = false;
    let lastSeq = 0;
    const toBackend = (b: Buffer) => {
      if (!backend.write(b)) {
        client.pause();
        backend.once('drain', () => client.resume());
      }
    };
    const fromClient = (d: Buffer) => {
      stats.bytesIn += d.length;
      for (const p of splitter.push(d)) {
        // Only what follows a 16 MiB part that was passed on is "the rest of a packet". A refused command never
        // reaches the database, so there is nothing of it to continue: the next packet is checked like any other
        const rest = continuing && p.seq === ((lastSeq + 1) & 0xff);
        continuing = false;
        if (rest) {
          toBackend(encodePacket(p.seq, p.payload));
          continuing = p.payload.length === MAX_PAYLOAD;
          lastSeq = p.seq;
          continue;
        }
        if (p.payload.length === 0) {
          toBackend(encodePacket(p.seq, p.payload));
          continue;
        }
        // Every other packet may start a command at the database, whatever its number (after long data the
        // database answers nothing, so the next command does not start at 0): it gets the same checks
        const cmd = p.payload[0];
        if (BLOCKED_COMMANDS.has(cmd)) {
          this.o.hooks.query(sessionId, account.id, 'BLOCKED', `(protocol command 0x${cmd.toString(16)})`);
          client.write(encodePacket(1, buildErr(1227, '42000', 'The DbBackup gateway does not allow this command')));
          continue;
        }
        let payload = p.payload;
        if (cmd === COM.QUERY) {
          const sql = payload.subarray(1).toString('utf8');
          stats.queries++;
          const killed = this.rewriteKill(sql, account.id);
          if (killed) payload = Buffer.concat([Buffer.from([COM.QUERY]), Buffer.from(killed, 'utf8')]);
          this.o.hooks.query(sessionId, account.id, 'QUERY', sql);
        } else if (cmd === COM.STMT_PREPARE) {
          stats.queries++;
          this.o.hooks.query(sessionId, account.id, 'PREPARE', payload.subarray(1).toString('utf8'));
        } else if (cmd === COM.INIT_DB) {
          this.o.hooks.query(sessionId, account.id, 'USE', `USE ${payload.subarray(1).toString('utf8')}`);
        } else if (cmd === COM.PROCESS_KILL && payload.length >= 5) {
          const target = this.backendThread(payload.readUInt32LE(1), account.id);
          if (target !== null) {
            payload = Buffer.from(payload);
            payload.writeUInt32LE(target, 1);
          }
        }
        toBackend(encodePacket(p.seq, payload));
        continuing = p.payload.length === MAX_PAYLOAD;
        lastSeq = p.seq;
        if (cmd === COM.QUIT) close();
      }
    };
    if (r.clientLeft.length) fromClient(r.clientLeft);
    client.on('data', fromClient);

    const ended = () => close();
    client.on('end', ended);
    client.on('close', ended);
    client.on('error', ended);
    backend.on('end', ended);
    backend.on('close', ended);
    backend.on('error', ended);
  }

  /** The database thread behind one of this account's sessions, by the id the gateway gave it */
  private backendThread(gatewayId: number, accountId: string): number | null {
    const s = this.sessions.get(gatewayId);
    return s && s.accountId === accountId ? s.backendThreadId : null;
  }

  /** "KILL QUERY 1234" with the gateway's id, rewritten to the database's thread id */
  private rewriteKill(sql: string, accountId: string): string | null {
    const m = KILL_RE.exec(sql);
    if (!m) return null;
    const thread = this.backendThread(Number(m[2]), accountId);
    return thread === null ? null : `KILL ${m[1] ?? ''}${thread}`;
  }
}
