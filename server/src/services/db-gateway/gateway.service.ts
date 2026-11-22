import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import tls from 'tls';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { decrypt } from '../crypto.service';
import { toEngineConfig } from '../engines/connection-config';
import { nodeTlsOptions } from '../engines/tls';
import type { ConnectionConfig } from '../engines/base.engine';
import { SSHTunnel } from '../ssh.service';
import { sanitizeForLog } from '../../utils/sanitize';
import { BackendTarget, GatewayAccount, GatewayServer, QueryKind } from './server';

/**
 * Settings (server/.env):
 *   DB_GATEWAY_PORT          port the gateway listens on; unset = gateway off
 *   DB_GATEWAY_BIND          address to listen on (default 0.0.0.0)
 *   DB_GATEWAY_PUBLIC_HOST   host name people connect to (shown in the app)
 *   DB_GATEWAY_TLS_CERT      certificate (PEM, full chain), e.g. the site's Let's Encrypt fullchain.pem
 *   DB_GATEWAY_TLS_KEY       its private key
 *   DB_GATEWAY_REQUIRE_TLS   "false" allows unencrypted clients (only for a private network)
 *   DB_GATEWAY_LOG_DAYS      days to keep the query log (default 30)
 */
export interface GatewayConfig {
  port: number | null;
  bind: string;
  publicHost: string | null;
  certFile: string | null;
  keyFile: string | null;
  requireTls: boolean;
  logDays: number;
}

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const port = Number(env.DB_GATEWAY_PORT);
  let publicHost = env.DB_GATEWAY_PUBLIC_HOST?.trim() || null;
  if (!publicHost && env.FRONTEND_URL) {
    try { publicHost = new URL(env.FRONTEND_URL).hostname; } catch { /* not a URL */ }
  }
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    bind: env.DB_GATEWAY_BIND?.trim() || '0.0.0.0',
    publicHost,
    certFile: env.DB_GATEWAY_TLS_CERT?.trim() || null,
    keyFile: env.DB_GATEWAY_TLS_KEY?.trim() || null,
    requireTls: env.DB_GATEWAY_REQUIRE_TLS !== 'false',
    logDays: Math.max(1, Number(env.DB_GATEWAY_LOG_DAYS) || 30),
  };
}

export interface GatewayStatus {
  running: boolean;
  port: number | null;
  publicHost: string | null;
  requireTls: boolean;
  tls: { configured: boolean; subject: string | null; validTo: string | null; error: string | null };
  /** Why it is not running, or what needs attention */
  problem: string | null;
}

// ── TLS certificate, read again when the files change (renewals)

let tlsState: { context: tls.SecureContext; mtime: number; subject: string; validTo: string } | null = null;
let tlsError: string | null = null;

function loadTls(cfg: GatewayConfig): tls.SecureContext | null {
  if (!cfg.certFile || !cfg.keyFile) {
    tlsState = null;
    tlsError = null;
    return null;
  }
  try {
    const mtime = Math.max(fs.statSync(cfg.certFile).mtimeMs, fs.statSync(cfg.keyFile).mtimeMs);
    if (tlsState && tlsState.mtime === mtime) return tlsState.context;
    const cert = fs.readFileSync(cfg.certFile);
    const key = fs.readFileSync(cfg.keyFile);
    const x509 = new crypto.X509Certificate(cert);
    tlsState = {
      context: tls.createSecureContext({ cert, key, minVersion: 'TLSv1.2' }),
      mtime,
      subject: x509.subject.replace(/\n/g, ', '),
      validTo: new Date(x509.validTo).toISOString(),
    };
    tlsError = null;
    logger.info(`DB gateway: TLS certificate loaded (${sanitizeForLog(tlsState.subject)}, valid until ${tlsState.validTo})`);
    return tlsState.context;
  } catch (e) {
    tlsError = `Could not read the TLS certificate or key: ${(e as Error).message}`;
    // Keep using the last good certificate while a renewal is half written
    return tlsState?.context ?? null;
  }
}

// ── SSH tunnels, shared by the sessions to one connection

interface TunnelEntry { tunnel: SSHTunnel; port: number; refs: number; timer: NodeJS.Timeout | null; dead: boolean }
const tunnels = new Map<string, Promise<TunnelEntry>>();
const TUNNEL_IDLE_MS = 5 * 60_000;

async function acquireTunnel(key: string, config: ConnectionConfig): Promise<TunnelEntry> {
  let pending = tunnels.get(key);
  if (pending) {
    const e = await pending.catch(() => null);
    if (e && !e.dead) {
      e.refs++;
      if (e.timer) { clearTimeout(e.timer); e.timer = null; }
      return e;
    }
    tunnels.delete(key);
  }
  pending = (async () => {
    const tunnel = new SSHTunnel({ ...config });
    const port = await tunnel.connect();
    const entry: TunnelEntry = { tunnel, port, refs: 0, timer: null, dead: false };
    tunnel.onClose(() => { entry.dead = true; tunnels.delete(key); });
    return entry;
  })();
  tunnels.set(key, pending);
  try {
    const e = await pending;
    e.refs++;
    return e;
  } catch (err) {
    tunnels.delete(key);
    throw err;
  }
}

function releaseTunnel(key: string, e: TunnelEntry): void {
  e.refs--;
  if (e.refs > 0 || e.dead) return;
  e.timer = setTimeout(() => {
    if (e.refs > 0) return;
    e.dead = true;
    tunnels.delete(key);
    e.tunnel.close();
  }, TUNNEL_IDLE_MS);
  e.timer.unref();
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, host);
    const t = setTimeout(() => { s.destroy(); reject(new Error(`no answer from ${host}:${port}`)); }, 15_000);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

// ── Query log, written in batches

let pendingQueries: { sessionId: string; kind: string; sql: string; at: Date }[] = [];
let flushTimer: NodeJS.Timeout | null = null;
const MAX_SQL = 4000;

async function flushQueries(): Promise<void> {
  flushTimer = null;
  const batch = pendingQueries;
  pendingQueries = [];
  if (!batch.length) return;
  try {
    await prisma.dbAccessQuery.createMany({ data: batch });
  } catch (e) {
    logger.warn(`DB gateway: could not save ${batch.length} logged queries: ${(e as Error).message}`);
  }
}

// ── The gateway

let gateway: GatewayServer | null = null;
let status: GatewayStatus = {
  running: false, port: null, publicHost: null, requireTls: true,
  tls: { configured: false, subject: null, validTo: null, error: null }, problem: 'not started',
};
let timers: NodeJS.Timeout[] = [];

function toAccount(a: {
  id: string; username: string; hashNative: string; hashSha2: string; enabled: boolean; expiresAt: Date | null;
  maxConnections: number; database: string;
}): GatewayAccount {
  return {
    id: a.id, username: a.username, hashNative: a.hashNative, hashSha2: a.hashSha2, enabled: a.enabled,
    expiresAt: a.expiresAt, maxConnections: a.maxConnections, database: a.database,
  };
}

async function openBackend(account: GatewayAccount): Promise<BackendTarget> {
  const access = await prisma.dbAccess.findUnique({ where: { id: account.id }, include: { connection: true } });
  if (!access) throw new Error('this access was removed');
  const config = toEngineConfig(access.connection);
  const password = decrypt(access.backendPassword);
  const tlsOptions = config.sslEnabled ? (nodeTlsOptions(config, 'pg') as tls.ConnectionOptions) : undefined;
  if (config.sshEnabled) {
    const key = `${access.connection.id}:${access.connection.updatedAt.getTime()}`;
    const entry = await acquireTunnel(key, config);
    let released = false;
    const release = () => { if (!released) { released = true; releaseTunnel(key, entry); } };
    try {
      const socket = await connectTcp('127.0.0.1', entry.port);
      return { socket, user: access.backendUser, password, tls: tlsOptions, release };
    } catch (e) {
      release();
      throw e;
    }
  }
  const socket = await connectTcp(config.host, config.port);
  return { socket, user: access.backendUser, password, tls: tlsOptions, release: () => {} };
}

export async function startDbGateway(): Promise<void> {
  const cfg = gatewayConfig();
  const context = loadTls(cfg);
  status = {
    running: false,
    port: cfg.port,
    publicHost: cfg.publicHost,
    requireTls: cfg.requireTls,
    tls: { configured: !!context, subject: tlsState?.subject ?? null, validTo: tlsState?.validTo ?? null, error: tlsError },
    problem: null,
  };
  if (!cfg.port) {
    status.problem = 'The gateway is off: set DB_GATEWAY_PORT (and DB_GATEWAY_TLS_CERT / DB_GATEWAY_TLS_KEY) in server/.env and restart DbBackup.';
    return;
  }
  if (cfg.requireTls && !context) {
    status.problem = tlsError ?? 'The gateway needs a TLS certificate: set DB_GATEWAY_TLS_CERT and DB_GATEWAY_TLS_KEY in server/.env.';
    logger.warn(`DB gateway not started: ${status.problem}`);
    return;
  }

  // Sessions left open by a stop or crash
  await prisma.dbAccessSession.updateMany({ where: { endedAt: null }, data: { endedAt: new Date(), error: 'DbBackup restarted' } }).catch(() => {});

  gateway = new GatewayServer({
    port: cfg.port,
    host: cfg.bind,
    requireTls: cfg.requireTls,
    secureContext: () => loadTls(cfg),
    hooks: {
      findAccount: async (username) => {
        const a = await prisma.dbAccess.findUnique({ where: { username } });
        return a ? toAccount(a) : null;
      },
      openBackend,
      sessionStarted: async (info) => {
        const s = await prisma.dbAccessSession.create({
          data: { accessId: info.accountId, clientIp: info.clientIp, clientProgram: info.clientProgram?.slice(0, 200), serverVersion: info.serverVersion },
        });
        await prisma.dbAccess.update({ where: { id: info.accountId }, data: { lastUsedAt: new Date() } }).catch(() => {});
        return s.id;
      },
      query: (sessionId, _accountId, kind: QueryKind, sql) => {
        pendingQueries.push({ sessionId, kind, sql: sql.length > MAX_SQL ? `${sql.slice(0, MAX_SQL)}…` : sql, at: new Date() });
        if (pendingQueries.length >= 500) void flushQueries();
        else if (!flushTimer) flushTimer = setTimeout(() => void flushQueries(), 2000);
      },
      sessionEnded: (sessionId, s) => {
        void flushQueries().then(() => prisma.dbAccessSession.update({
          where: { id: sessionId },
          data: { endedAt: new Date(), queries: s.queries, bytesIn: BigInt(s.bytesIn), bytesOut: BigInt(s.bytesOut), error: s.error },
        })).catch(() => {});
      },
      loginFailed: (username, ip, reason) => {
        logger.warn(`DB gateway: login refused for ${sanitizeForLog(username)} from ${ip} (${reason})`);
      },
    },
  });
  try {
    await gateway.start();
  } catch (e) {
    gateway = null;
    status.problem = `The gateway could not listen on port ${cfg.port}: ${(e as Error).message}`;
    logger.error(`DB gateway: ${status.problem}`);
    return;
  }
  status.running = true;
  logger.info(`🔌 DB gateway listening on ${cfg.bind}:${cfg.port}${cfg.requireTls ? ' (TLS required)' : ''}`);

  // End sessions once their access expires; keep the log to its length
  const expiry = setInterval(() => {
    void (async () => {
      const expired = await prisma.dbAccess.findMany({ where: { expiresAt: { lte: new Date() } }, select: { id: true } });
      for (const a of expired) gateway?.closeAccount(a.id, 'Access has expired');
    })().catch(() => {});
  }, 30_000);
  const prune = setInterval(() => void pruneLog(cfg.logDays), 6 * 3600_000);
  expiry.unref();
  prune.unref();
  timers = [expiry, prune];
  void pruneLog(cfg.logDays);
}

async function pruneLog(days: number): Promise<void> {
  try {
    const before = new Date(Date.now() - days * 86_400_000);
    await prisma.dbAccessQuery.deleteMany({ where: { at: { lt: before } } });
    await prisma.dbAccessSession.deleteMany({ where: { endedAt: { lt: new Date(Date.now() - Math.max(days, 90) * 86_400_000) } } });
  } catch (e) {
    logger.warn(`DB gateway: could not prune the query log: ${(e as Error).message}`);
  }
}

export async function stopDbGateway(): Promise<void> {
  for (const t of timers) clearInterval(t);
  timers = [];
  await gateway?.stop();
  gateway = null;
  await flushQueries();
  for (const [key, p] of tunnels) {
    tunnels.delete(key);
    p.then((e) => { e.dead = true; e.tunnel.close(); }).catch(() => {});
  }
}

export function getGatewayStatus(): GatewayStatus {
  if (status.tls.configured || tlsState) {
    status.tls = { configured: !!tlsState, subject: tlsState?.subject ?? null, validTo: tlsState?.validTo ?? null, error: tlsError };
  }
  return status;
}

export function closeAccessSessions(accessId: string, reason: string): number {
  return gateway?.closeAccount(accessId, reason) ?? 0;
}

export function closeGatewaySession(sessionId: string, reason: string): boolean {
  return gateway?.closeSession(sessionId, reason) ?? false;
}

export function activeSessionCount(accessId: string): number {
  return gateway?.activeSessions(accessId) ?? 0;
}
