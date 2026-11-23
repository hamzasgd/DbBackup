import { Response, NextFunction } from 'express';
import type { DbAccess } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { logAuditReq } from '../services/audit.service';
import { encrypt } from '../services/crypto.service';
import { toEngineConfig } from '../services/engines/connection-config';
import { passwordHashes, randomPassword, shellQuote } from '../services/db-gateway/protocol';
import {
  PRESETS, ProvisionError, createBackendUser, dropBackendUser, listTables, normalizePrivileges, onlyReads,
  updateBackendUser, DATABASE_PRIVILEGES, TABLE_PRIVILEGES,
} from '../services/db-gateway/provision';
import {
  activeSessionCount, closeAccessSessions, closeGatewaySession, gatewayConfig, getGatewayStatus,
} from '../services/db-gateway/gateway.service';

const SUPPORTED = new Set(['MYSQL', 'MARIADB']);

const view = (a: DbAccess & { connection?: { name: string; type: string } | null }) => ({
  id: a.id,
  name: a.name,
  username: a.username,
  connectionId: a.connectionId,
  connectionName: a.connection?.name ?? null,
  database: a.database,
  tables: a.tables,
  privileges: a.privileges,
  maxConnections: a.maxConnections,
  enabled: a.enabled,
  expiresAt: a.expiresAt,
  lastUsedAt: a.lastUsedAt,
  createdAt: a.createdAt,
  activeSessions: activeSessionCount(a.id),
});

/** What to put in a database client (DBeaver, DbGate, mysql) */
function clientSettings(a: { username: string; database: string }, password?: string) {
  const s = getGatewayStatus();
  const cfg = gatewayConfig();
  const host = s.publicHost ?? 'your-dbbackup-host';
  const port = s.port ?? cfg.port ?? 3307;
  const pw = password ?? '<password>';
  return {
    host,
    port,
    username: a.username,
    password: password ?? null,
    database: a.database,
    ssl: s.requireTls ? 'REQUIRED' : 'PREFERRED',
    url: `mysql://${encodeURIComponent(a.username)}:${encodeURIComponent(pw)}@${host}:${port}/${encodeURIComponent(a.database)}?ssl-mode=REQUIRED`,
    // The database's name is quoted: it is whatever was typed (or came with an imported connection), and
    // this line is pasted into a shell
    command: `mysql -h ${host} -P ${port} -u ${a.username} -p --ssl-mode=REQUIRED ${shellQuote(a.database)}`,
  };
}

async function ownAccess(req: AuthRequest, id = req.params.id) {
  const a = await prisma.dbAccess.findFirst({ where: { id, userId: req.user!.userId }, include: { connection: true } });
  if (!a) throw new AppError('Access not found', 404);
  return a;
}

/** Writing is refused on a write-protected connection and on the target of a live sync */
async function assertWritesAllowed(conn: { id: string; name: string; writeProtected: boolean }, privileges: string[]): Promise<void> {
  if (onlyReads(privileges)) return;
  if (conn.writeProtected) {
    throw new AppError(`"${conn.name}" is write-protected, so only read rights (SELECT, SHOW VIEW) can be given on it.`, 403, 'WRITE_PROTECTED');
  }
  const live = await prisma.liveSync.findFirst({ where: { targetConnectionId: conn.id, enabled: true }, select: { sourceName: true } });
  if (live) {
    throw new AppError(
      `"${conn.name}" receives a live sync from "${live.sourceName}": anything written there directly would be overwritten or lost. Only read rights can be given while the live sync runs.`,
      409,
    );
  }
}

async function uniqueUsername(wanted: string | undefined, name: string): Promise<string> {
  if (wanted) {
    if (await prisma.dbAccess.findUnique({ where: { username: wanted } })) throw new AppError(`The login name "${wanted}" is taken`, 409);
    return wanted;
  }
  let base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (!/^[a-z]/.test(base)) base = `u_${base}`;
  if (base.length < 3) base = `${base}_db`;
  for (let i = 0; i < 100; i++) {
    const candidate = i ? `${base}${i + 1}` : base;
    if (!(await prisma.dbAccess.findUnique({ where: { username: candidate } }))) return candidate;
  }
  throw new AppError('Choose a login name', 409);
}

function provisionFailed(e: unknown): never {
  if (e instanceof ProvisionError) throw new AppError(e.message, 400);
  throw new AppError(`Could not reach the database: ${(e as Error).message}`, 502);
}

/** What everyone but the administrator is told when the certificate could not be read: the reason names a file on the server */
const TLS_PROBLEM_HIDDEN = 'The TLS certificate or key could not be read. The DbBackup administrator finds the reason in the server log.';

export async function gatewayStatus(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const s = getGatewayStatus();
    // The reason (which file, why it could not be read) is for the administrator, who can do something about it
    const data = s.tls.error && req.user!.role !== 'ADMIN'
      ? { ...s, problem: s.problem === s.tls.error ? TLS_PROBLEM_HIDDEN : s.problem, tls: { ...s.tls, error: TLS_PROBLEM_HIDDEN } }
      : s;
    res.json({ success: true, data: { ...data, presets: PRESETS, databasePrivileges: DATABASE_PRIVILEGES, tablePrivileges: TABLE_PRIVILEGES } });
  } catch (err) { next(err); }
}

export async function listAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const list = await prisma.dbAccess.findMany({
      where: { userId: req.user!.userId }, include: { connection: { select: { name: true, type: true } } }, orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, data: { accesses: list.map(view) } });
  } catch (err) { next(err); }
}

export async function listAccessTables(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const conn = await prisma.connection.findFirst({ where: { id: String(req.query.connectionId), userId: req.user!.userId } });
    if (!conn) throw new AppError('Connection not found', 404);
    if (!SUPPORTED.has(conn.type)) throw new AppError('Database access works with MySQL and MariaDB connections', 400);
    const config = toEngineConfig(conn);
    const database = String(req.query.database || config.database);
    const tables = await listTables(config, database).catch(provisionFailed);
    res.json({ success: true, data: { database, tables } });
  } catch (err) { next(err); }
}

/** Give someone access: a database user with the chosen rights, and a gateway login. The password is shown once. */
export async function createAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const body = req.body as {
      connectionId: string; name: string; username?: string; database?: string; tables?: string[];
      privileges: string[]; maxConnections?: number; expiresAt?: string | null;
    };
    const conn = await prisma.connection.findFirst({ where: { id: body.connectionId, userId } });
    if (!conn) throw new AppError('Connection not found', 404);
    if (!SUPPORTED.has(conn.type)) throw new AppError('Database access works with MySQL and MariaDB connections', 400);

    const tables = [...new Set(body.tables ?? [])];
    let privileges: string[];
    try { privileges = normalizePrivileges(body.privileges, tables.length > 0); } catch (e) { throw new AppError((e as Error).message, 400); }
    await assertWritesAllowed(conn, privileges);
    const username = await uniqueUsername(body.username, body.name);
    const config = toEngineConfig(conn);
    // Stored encrypted: the name comes from the decrypted config
    const database = body.database ?? config.database;
    const maxConnections = body.maxConnections ?? 5;
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) throw new AppError('The end date is in the past', 400);

    const backend = await createBackendUser(config, { database, tables, privileges, maxConnections }).catch(provisionFailed);
    const password = randomPassword(24);
    const h = passwordHashes(password);
    let access;
    try {
      access = await prisma.dbAccess.create({
        data: {
          userId, connectionId: conn.id, name: body.name, username, hashNative: h.native, hashSha2: h.sha2,
          database, tables, privileges, maxConnections, expiresAt,
          backendUser: backend.user, backendHost: backend.host, backendPassword: encrypt(backend.password),
        },
        include: { connection: { select: { name: true, type: true } } },
      });
    } catch (e) {
      await dropBackendUser(config, backend.user, backend.host).catch(() => {});
      throw e;
    }
    await logAuditReq(req, userId, 'CREATE', 'db_access', { id: access.id, name: access.name, username, connection: conn.name, database, tables, privileges, expiresAt });
    res.status(201).json({ success: true, data: { access: view(access), settings: clientSettings(access, password) } });
  } catch (err) { next(err); }
}

/** Change the rights, the limit, the end date, or turn it off and on */
export async function updateAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = await ownAccess(req);
    const body = req.body as { name?: string; tables?: string[]; privileges?: string[]; maxConnections?: number; expiresAt?: string | null; enabled?: boolean };
    const tables = body.tables ? [...new Set(body.tables)] : a.tables;
    let privileges = a.privileges;
    if (body.privileges || body.tables) {
      try { privileges = normalizePrivileges(body.privileges ?? a.privileges, tables.length > 0); } catch (e) { throw new AppError((e as Error).message, 400); }
    }
    const maxConnections = body.maxConnections ?? a.maxConnections;
    const rightsChanged = privileges.join() !== a.privileges.join() || tables.join('\n') !== a.tables.join('\n') || maxConnections !== a.maxConnections;
    if (rightsChanged) {
      await assertWritesAllowed(a.connection, privileges);
      await updateBackendUser(toEngineConfig(a.connection), a.backendUser, a.backendHost, { database: a.database, tables, privileges, maxConnections }).catch(provisionFailed);
    }
    const expiresAt = body.expiresAt === undefined ? a.expiresAt : body.expiresAt ? new Date(body.expiresAt) : null;
    const updated = await prisma.dbAccess.update({
      where: { id: a.id },
      data: { name: body.name ?? a.name, tables, privileges, maxConnections, expiresAt, enabled: body.enabled ?? a.enabled },
      include: { connection: { select: { name: true, type: true } } },
    });
    // Open sessions keep the rights they logged in with: end them so the change applies at once
    if (rightsChanged || updated.enabled === false || (expiresAt && expiresAt.getTime() <= Date.now())) {
      closeAccessSessions(a.id, updated.enabled ? 'The access was changed: connect again' : 'The access was turned off');
    }
    await logAuditReq(req, req.user!.userId, 'UPDATE', 'db_access', { id: a.id, username: a.username, ...body });
    res.json({ success: true, data: { access: view(updated) } });
  } catch (err) { next(err); }
}

/** A new password (the old one stops working); shown once */
export async function resetAccessPassword(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = await ownAccess(req);
    const password = randomPassword(24);
    const h = passwordHashes(password);
    await prisma.dbAccess.update({ where: { id: a.id }, data: { hashNative: h.native, hashSha2: h.sha2 } });
    closeAccessSessions(a.id, 'The password was changed');
    await logAuditReq(req, req.user!.userId, 'UPDATE', 'db_access', { id: a.id, username: a.username, passwordReset: true });
    res.json({ success: true, data: { settings: clientSettings(a, password) } });
  } catch (err) { next(err); }
}

/** Take the access away: end its sessions and remove the database user */
export async function deleteAccess(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = await ownAccess(req);
    const force = req.query.force === 'true';
    await prisma.dbAccess.update({ where: { id: a.id }, data: { enabled: false } });
    closeAccessSessions(a.id, 'The access was removed');
    let warning: string | null = null;
    try {
      await dropBackendUser(toEngineConfig(a.connection), a.backendUser, a.backendHost);
    } catch (e) {
      if (!force) {
        throw new AppError(
          `The access is turned off, but its database user ${a.backendUser}@${a.backendHost} could not be removed: ${(e as Error).message}. ` +
          'Try again, or remove it anyway (then drop that user on the database yourself).', 502);
      }
      warning = `Remove the database user ${a.backendUser}@${a.backendHost} yourself: ${(e as Error).message}`;
    }
    await prisma.dbAccess.delete({ where: { id: a.id } });
    await logAuditReq(req, req.user!.userId, 'DELETE', 'db_access', { id: a.id, name: a.name, username: a.username, warning });
    res.json({ success: true, data: { warning } });
  } catch (err) { next(err); }
}

export async function listAccessSessions(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const a = await ownAccess(req);
    // The newest `limit` sessions (the page can ask for more); `total` says how many there are
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const [rows, total] = await prisma.$transaction([
      prisma.dbAccessSession.findMany({ where: { accessId: a.id }, orderBy: { startedAt: 'desc' }, take: limit }),
      prisma.dbAccessSession.count({ where: { accessId: a.id } }),
    ]);
    res.json({
      success: true,
      data: { sessions: rows.map((s) => ({ ...s, bytesIn: Number(s.bytesIn), bytesOut: Number(s.bytesOut) })), total },
    });
  } catch (err) { next(err); }
}

export async function listSessionQueries(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const s = await prisma.dbAccessSession.findFirst({ where: { id: req.params.sessionId, access: { userId: req.user!.userId } } });
    if (!s) throw new AppError('Session not found', 404);
    // The first `limit` statements (the page can ask for more); `total` says how many there are
    const limit = Math.min(10_000, Math.max(1, parseInt(String(req.query.limit ?? '1000'), 10) || 1000));
    const [queries, total] = await prisma.$transaction([
      prisma.dbAccessQuery.findMany({ where: { sessionId: s.id }, orderBy: { at: 'asc' }, take: limit }),
      prisma.dbAccessQuery.count({ where: { sessionId: s.id } }),
    ]);
    res.json({ success: true, data: { queries, total } });
  } catch (err) { next(err); }
}

export async function closeAccessSession(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const s = await prisma.dbAccessSession.findFirst({ where: { id: req.params.sessionId, access: { userId: req.user!.userId } } });
    if (!s) throw new AppError('Session not found', 404);
    const closed = closeGatewaySession(s.id, 'The session was ended from DbBackup');
    res.json({ success: true, data: { closed } });
  } catch (err) { next(err); }
}

