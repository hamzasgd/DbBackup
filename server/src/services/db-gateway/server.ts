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

/** "KILL [QUERY|CONNECTION] <id>", with the id the gateway gave the session */
const KILL_RE = /^\s*KILL\s+(QUERY\s+|CONNECTION\s+)?(\d+)\s*;?\s*$/i;

export class GatewayServer {
  private server: net.Server | null = null;
  private sessions = new Map<number, Session>();
  private nextId = 1000 + Math.floor(Math.random() * 1000);
  private failures = new Map<string, number[]>();
  /** The version clients are greeted with: the last one a database reported */
  private serverVersion = '8.0.40';

  constructor(private readonly o: GatewayOptions) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => {
        this.handle(sock).catch(() => sock.destroy());
      });
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
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  activeSessions(accountId?: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (!accountId || s.accountId === accountId) n++;
    return n;
  }

  /** End every session of an account (access turned off, changed or removed) */
  closeAccount(accountId: string, reason: string): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.accountId === accountId) {
        s.close(reason);
        n++;
      }
    }
    return n;
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
          secure.once('secure', () => resolve());
          secure.once('error', reject);
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
      if (this.activeSessions(account.id) >= account.maxConnections) {
        return refuse(ER_CON_COUNT, '08004', `'${hello.user}' already has ${account.maxConnections} open connection(s), the most allowed`);
      }

      // Log in to the database with the same session flags the client chose
      const clientCaps = hello.caps & (GATEWAY_CAPS | CLIENT.SSL);
      let target: BackendTarget;
      try {
        target = await this.o.hooks.openBackend(account);
      } catch (e) {
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

      const sessionId = await this.o.hooks.sessionStarted({ accountId: account.id, clientIp: ip, clientProgram, serverVersion: backend.serverVersion });
      send(backend.ok);
      const clientLeft = ch.detach();
      this.relay({
        gatewayId, sessionId, account, client: stream, backend: backend.stream, backendThreadId: backend.threadId,
        clientLeft, backendLeft: backend.leftover, release: target.release,
      });
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
    let continuing = false;
    const toBackend = (b: Buffer) => {
      if (!backend.write(b)) {
        client.pause();
        backend.once('drain', () => client.resume());
      }
    };
    const fromClient = (d: Buffer) => {
      stats.bytesIn += d.length;
      for (const p of splitter.push(d)) {
        const wasContinuing = continuing;
        continuing = p.payload.length === MAX_PAYLOAD;
        if (wasContinuing || p.seq !== 0 || p.payload.length === 0) {
          toBackend(encodePacket(p.seq, p.payload));
          continue;
        }
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
