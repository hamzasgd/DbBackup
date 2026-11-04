import { Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';
import { AppError } from '../middleware/errorHandler';
import { logAuditReq } from '../services/audit.service';
import { getQuotaUsage } from '../services/quota.service';
import { decryptIfPresent } from '../services/crypto.service';

/** All handlers sit behind `authenticate` + `requireAdmin`. */

const PAGE_MAX = 100;

function parsePagination(query: Record<string, unknown>): { page: number; limit: number } {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(String(query.limit ?? '20'), 10) || 20));
  return { page, limit };
}

/** Never let a decrypt failure 500 the whole support view. */
function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return decryptIfPresent(value);
  } catch {
    return '(unreadable)';
  }
}

/** Support-view row for one connection: host/username/database are decrypted
 * for display, but every secret stays masked or omitted — the same mask
 * contract as decryptConnection() in connection.controller.ts. */
function maskConnectionForAdmin(conn: {
  id: string; name: string; type: string; host: string; port: number; database: string;
  username: string; sslEnabled: boolean; sshEnabled: boolean; heartbeatEnabled: boolean;
  createdAt: Date;
}) {
  return {
    id: conn.id,
    name: conn.name,
    type: conn.type,
    host: safeDecrypt(conn.host as string),
    port: conn.port,
    database: safeDecrypt(conn.database as string),
    username: safeDecrypt(conn.username as string),
    sslEnabled: conn.sslEnabled,
    sshEnabled: conn.sshEnabled,
    heartbeatEnabled: conn.heartbeatEnabled,
    createdAt: conn.createdAt,
  };
}

export async function getPlatformStats(_req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [totalUsers, activeUsers, totalConnections, backupCounts, storageSum, failed7d, activeKeys, allKeys] =
      await Promise.all([
        prisma.user.count(),
        prisma.user.count({ where: { isActive: true } }),
        prisma.connection.count(),
        prisma.backup.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.backup.aggregate({ where: { status: 'COMPLETED' }, _sum: { fileSize: true } }),
        prisma.backup.count({ where: { status: 'FAILED', createdAt: { gte: since7d } } }),
        prisma.mcpApiKey.count({ where: { revokedAt: null } }),
        prisma.mcpApiKey.count(),
      ]);
    const backupByStatus = { PENDING: 0, RUNNING: 0, COMPLETED: 0, FAILED: 0 } as Record<string, number>;
    for (const row of backupCounts) backupByStatus[row.status] = row._count._all;
    res.json({
      success: true,
      data: {
        users: { total: totalUsers, active: activeUsers },
        connections: { total: totalConnections },
        backups: { byStatus: backupByStatus, failedLast7d: failed7d },
        storageBytes: storageSum._sum.fileSize ?? 0,
        mcpKeys: { active: activeKeys, total: allKeys },
      },
    });
  } catch (err) { next(err); }
}

export async function listUsers(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { page, limit } = parsePagination(req.query as Record<string, unknown>);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const skip = (page - 1) * limit;

    const where = {
      ...(search ? {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { name: { contains: search, mode: 'insensitive' as const } },
        ],
      } : {}),
      ...(status === 'active' ? { isActive: true } : {}),
      ...(status === 'suspended' ? { isActive: false } : {}),
    };

    const [users, total, connCounts, backupStats] = await Promise.all([
      prisma.user.findMany({
        where,
        select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true, storageQuotaBytes: true, connectionLimit: true, maxRetentionDays: true },
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
      prisma.connection.groupBy({ by: ['userId'], _count: { _all: true } }),
      prisma.backup.groupBy({ by: ['userId'], _count: { _all: true }, _max: { createdAt: true }, _sum: { fileSize: true } }),
    ]);

    const connMap = new Map(connCounts.map((c) => [c.userId, c._count._all]));
    const backupMap = new Map(backupStats.map((b) => [b.userId, { count: b._count._all, last: b._max.createdAt, bytes: b._sum.fileSize ?? BigInt(0) }]));

    const items = users.map((u) => ({
      ...u,
      connections: connMap.get(u.id) ?? 0,
      backups: backupMap.get(u.id)?.count ?? 0,
      lastBackupAt: backupMap.get(u.id)?.last ?? null,
      storageUsed: backupMap.get(u.id)?.bytes ?? BigInt(0),
    }));

    res.json({ success: true, data: { users: items, total, page, limit } });
  } catch (err) { next(err); }
}

export async function getUserDetail(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = req.params.id;
    if (!targetId) throw new AppError('User id is required', 400);

    const user = await prisma.user.findUnique({
      where: { id: targetId },
      select: {
        id: true, email: true, name: true, role: true, isActive: true,
        createdAt: true, termsAcceptedAt: true, passwordLoginDisabled: true,
        storageQuotaBytes: true, connectionLimit: true, maxRetentionDays: true,
      },
    });
    if (!user) throw new AppError('User not found', 404);

    const [connections, backups, schedules, mcpKeys, auditLogs] = await Promise.all([
      prisma.connection.findMany({
        where: { userId: targetId },
        select: {
          id: true, name: true, type: true, host: true, port: true, database: true,
          username: true, sslEnabled: true, sshEnabled: true, heartbeatEnabled: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.backup.findMany({
        where: { userId: targetId },
        select: {
          id: true, fileName: true, fileSize: true, dbType: true, dbName: true,
          status: true, storageType: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      prisma.schedule.count({ where: { connection: { userId: targetId } } }),
      prisma.mcpApiKey.findMany({
        where: { userId: targetId },
        select: {
          id: true, name: true, keyPrefix: true, scopes: true, approvalRequired: true,
          dailyCallLimit: true, callsToday: true, revokedAt: true, lastUsedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.auditLog.findMany({
        where: { userId: targetId },
        select: { action: true, resource: true, details: true, createdAt: true, ipAddress: true },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    ]);

    const quotaUsage = await getQuotaUsage(targetId);

    // The support view exposes another user's setup: always leave a trail.
    await logAuditReq(req, req.user!.userId, 'ADMIN_VIEW_USER', 'user', {
      targetUserId: targetId, targetEmail: user.email,
    });

    res.json({
      success: true,
      data: {
        user,
        connections: connections.map(maskConnectionForAdmin),
        backups,
        schedules,
        mcpKeys,
        auditLogs,
        quota: {
          usedBytes: Number(quotaUsage.usedBytes),
          quotaBytes: quotaUsage.quotaBytes === null ? null : Number(quotaUsage.quotaBytes),
          percent: quotaUsage.percent,
        },
      },
    });
  } catch (err) { next(err); }
}

export async function setUserStatus(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = req.params.id;
    const { isActive } = req.body as { isActive: boolean };
    if (!targetId) throw new AppError('User id is required', 400);
    if (typeof isActive !== 'boolean') throw new AppError('isActive must be a boolean', 400);
    if (targetId === req.user!.userId) {
      throw new AppError('You cannot suspend or reactivate your own account', 400);
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, email: true, isActive: true, tokenVersion: true },
    });
    if (!target) throw new AppError('User not found', 404);
    if (target.isActive === isActive) {
      return void res.json({ success: true, data: { id: target.id, isActive: target.isActive, unchanged: true } });
    }

    // Suspending also bumps tokenVersion: refresh tokens die immediately, so a
    // suspended user cannot mint new access tokens while isActive propagates.
    const updated = await prisma.user.update({
      where: { id: targetId },
      data: {
        isActive,
        ...(isActive ? {} : { tokenVersion: { increment: 1 } }),
      },
      select: { id: true, email: true, isActive: true },
    });

    await logAuditReq(req, req.user!.userId, isActive ? 'ADMIN_REACTIVATE' : 'ADMIN_SUSPEND', 'user', {
      targetUserId: targetId,
      targetEmail: updated.email,
    });

    res.json({ success: true, data: updated });
  } catch (err) { next(err); }
}

export async function setUserQuota(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = req.params.id;
    if (!targetId) throw new AppError('User id is required', 400);
    // storageQuotaGb: number (GB, 1 decimal ok) or null = unlimited
    const { storageQuotaGb } = req.body as { storageQuotaGb?: number | null };
    if (storageQuotaGb !== null && storageQuotaGb !== undefined && (typeof storageQuotaGb !== 'number' || !Number.isFinite(storageQuotaGb) || storageQuotaGb <= 0)) {
      throw new AppError('storageQuotaGb must be a positive number, or null for unlimited', 400);
    }
    const quotaBytes = storageQuotaGb == null ? null : BigInt(Math.round(storageQuotaGb * 1024 * 1024 * 1024));

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, email: true, storageQuotaBytes: true },
    });
    if (!target) throw new AppError('User not found', 404);

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { storageQuotaBytes: quotaBytes },
      select: { id: true, email: true, storageQuotaBytes: true },
    });

    await logAuditReq(req, req.user!.userId, 'ADMIN_SET_QUOTA', 'user', {
      targetUserId: targetId,
      targetEmail: updated.email,
      oldQuotaBytes: target.storageQuotaBytes === null ? null : Number(target.storageQuotaBytes),
      newQuotaBytes: quotaBytes === null ? null : Number(quotaBytes),
    });

    res.json({ success: true, data: { id: updated.id, storageQuotaBytes: updated.storageQuotaBytes === null ? null : Number(updated.storageQuotaBytes) } });
  } catch (err) { next(err); }
}

export async function setUserConnectionLimit(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = req.params.id;
    if (!targetId) throw new AppError('User id is required', 400);
    // connectionLimit: positive integer or null = unlimited
    const { connectionLimit } = req.body as { connectionLimit?: number | null };
    if (connectionLimit !== null && connectionLimit !== undefined && (typeof connectionLimit !== 'number' || !Number.isInteger(connectionLimit) || connectionLimit <= 0)) {
      throw new AppError('connectionLimit must be a positive integer, or null for unlimited', 400);
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, email: true, connectionLimit: true },
    });
    if (!target) throw new AppError('User not found', 404);

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { connectionLimit },
      select: { id: true, email: true, connectionLimit: true },
    });

    await logAuditReq(req, req.user!.userId, 'ADMIN_SET_CONNECTION_LIMIT', 'user', {
      targetUserId: targetId,
      targetEmail: updated.email,
      oldLimit: target.connectionLimit,
      newLimit: updated.connectionLimit,
    });

    res.json({ success: true, data: { id: updated.id, connectionLimit: updated.connectionLimit } });
  } catch (err) { next(err); }
}

export async function setUserRetentionLimit(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const targetId = req.params.id;
    if (!targetId) throw new AppError('User id is required', 400);
    // maxRetentionDays: positive integer or null = unlimited
    const { maxRetentionDays } = req.body as { maxRetentionDays?: number | null };
    if (maxRetentionDays !== null && maxRetentionDays !== undefined && (typeof maxRetentionDays !== 'number' || !Number.isInteger(maxRetentionDays) || maxRetentionDays <= 0)) {
      throw new AppError('maxRetentionDays must be a positive integer, or null for unlimited', 400);
    }

    const target = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, email: true, maxRetentionDays: true },
    });
    if (!target) throw new AppError('User not found', 404);

    const updated = await prisma.user.update({
      where: { id: targetId },
      data: { maxRetentionDays },
      select: { id: true, email: true, maxRetentionDays: true },
    });

    await logAuditReq(req, req.user!.userId, 'ADMIN_SET_RETENTION_LIMIT', 'user', {
      targetUserId: targetId,
      targetEmail: updated.email,
      oldDays: target.maxRetentionDays,
      newDays: updated.maxRetentionDays,
    });

    res.json({ success: true, data: { id: updated.id, maxRetentionDays: updated.maxRetentionDays } });
  } catch (err) { next(err); }
}
