import { Response, NextFunction } from 'express';
import type { LiveSync } from '@prisma/client';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { assertWritable } from '../services/write-protection';
import { toEngineConfig } from '../services/engines/connection-config';
import { databaseAddress } from '../services/restore-safety.service';
import { logAudit } from '../services/audit.service';
import { checkLiveSource } from '../services/data-sync/mysql-live';
import { randomServerId } from '../services/data-sync/live-sync.service';

const SUPPORTED = new Set(['MYSQL', 'MARIADB']);

const view = (l: LiveSync) => ({
  ...l,
  binlogPos: l.binlogPos === null ? null : Number(l.binlogPos),
  headPos: l.headPos === null ? null : Number(l.headPos),
  inserted: Number(l.inserted),
  updated: Number(l.updated),
  deleted: Number(l.deleted),
  transactions: Number(l.transactions),
});

export async function listLiveSyncs(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const list = await prisma.liveSync.findMany({ where: { userId: req.user!.userId }, orderBy: { createdAt: 'asc' } });
    res.json({ success: true, data: { liveSyncs: list.map(view), serverTime: new Date().toISOString() } });
  } catch (err) { next(err); }
}

/**
 * Start (or restart) following the source's binary log into the target. Needs
 * the target database name typed back, like a sync. One live sync per target.
 */
export async function startLiveSync(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { sourceConnectionId, targetConnectionId, confirmTarget } = req.body as {
      sourceConnectionId: string; targetConnectionId: string; confirmTarget?: string;
    };
    const [source, target] = await Promise.all([
      prisma.connection.findFirst({ where: { id: sourceConnectionId, userId } }),
      prisma.connection.findFirst({ where: { id: targetConnectionId, userId } }),
    ]);
    if (!source || !target) throw new AppError('Connection not found', 404, 'NOT_FOUND');
    if (!SUPPORTED.has(source.type) || !SUPPORTED.has(target.type)) {
      throw new AppError('Live sync supports MySQL and MariaDB databases', 400, 'UNSUPPORTED');
    }
    const s = toEngineConfig(source);
    const t = toEngineConfig(target);
    if (source.id === target.id || databaseAddress(s, s.database) === databaseAddress(t, t.database)) {
      throw new AppError('The source and the target are the same database', 400, 'SAME_DATABASE');
    }
    assertWritable(target, 'apply changes to it');
    if (confirmTarget !== t.database) {
      throw new AppError(
        `Live sync keeps changing data in "${target.name}". To go ahead, confirm with its database name "${t.database}".`,
        409, 'CONFIRM_TARGET',
      );
    }
    const existing = await prisma.liveSync.findUnique({ where: { userId_targetConnectionId: { userId, targetConnectionId: target.id } } });
    if (existing?.enabled) throw new AppError(`Live sync into "${target.name}" is already on`, 409, 'LIVE_SYNC_RUNNING');

    // Settings and privileges first, so problems show right away
    let check;
    try {
      check = await checkLiveSource(s);
    } catch (err) {
      throw new AppError(`Could not check "${source.name}": ${err instanceof Error ? err.message : String(err)}`, 400, 'SOURCE_CHECK_FAILED');
    }
    if (check.problems.length) throw new AppError(check.problems.join(' '), 400, 'SOURCE_NOT_READY');

    const fresh = {
      sourceConnectionId: source.id, sourceName: source.name, targetName: target.name,
      sourceDatabase: s.database, targetDatabase: t.database,
      enabled: true, status: 'STARTING', error: null, warnings: check.warnings, stoppedAt: null,
    };
    const sameSource = existing && existing.sourceConnectionId === source.id && existing.sourceDatabase === s.database;
    const live = existing
      ? await prisma.liveSync.update({
        where: { id: existing.id },
        data: {
          ...fresh,
          // Another source: start over (its position and history mean nothing for this one)
          ...(sameSource ? {} : {
            binlogFile: null, binlogPos: null, catchUpRunId: null, lastEventAt: null, appliedAt: null,
            headFile: null, headPos: null, checkedAt: null, startedAt: null,
            inserted: 0, updated: 0, deleted: 0, transactions: 0, serverId: randomServerId(),
          }),
        },
      })
      : await prisma.liveSync.create({ data: { ...fresh, userId, targetConnectionId: target.id, serverId: randomServerId() } });
    await logAudit(userId, 'LIVE_SYNC_START', 'connection', { liveSyncId: live.id, source: source.name, target: target.name }, req.ip);
    res.status(202).json({ success: true, data: view(live) });
  } catch (err) { next(err); }
}

export async function stopLiveSync(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const live = await prisma.liveSync.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
    if (!live) throw new AppError('Live sync not found', 404, 'NOT_FOUND');
    // The runner notices within seconds, saves its position and lets go
    const updated = await prisma.liveSync.update({
      where: { id: live.id },
      data: { enabled: false, status: 'STOPPED', stoppedAt: new Date() },
    });
    await logAudit(req.user!.userId, 'LIVE_SYNC_STOP', 'connection', { liveSyncId: live.id, source: live.sourceName, target: live.targetName }, req.ip);
    res.json({ success: true, data: view(updated) });
  } catch (err) { next(err); }
}

export async function removeLiveSync(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const live = await prisma.liveSync.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
    if (!live) throw new AppError('Live sync not found', 404, 'NOT_FOUND');
    if (live.enabled) throw new AppError('Stop it first', 400, 'LIVE_SYNC_RUNNING');
    await prisma.liveSync.delete({ where: { id: live.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
}
