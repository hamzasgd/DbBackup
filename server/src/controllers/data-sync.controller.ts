import { Response, NextFunction } from 'express';
import { assertWritable } from '../services/write-protection';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { toEngineConfig } from '../services/engines/connection-config';
import { databaseAddress } from '../services/restore-safety.service';
import { addDataSyncJob, getDataSyncQueue } from '../queue/data-sync.queue';
import { logAudit } from '../services/audit.service';

const SUPPORTED = new Set(['MYSQL', 'MARIADB']);

/**
 * Start a compare (read-only) or apply (copy the differences) run from a
 * source database to a target with the same schema. Applying needs the
 * target database name typed back; source and target can never be the same.
 */
export async function startDataSync(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { sourceConnectionId, targetConnectionId, mode, tables = [], confirmTarget, parallel = 4 } = req.body as {
      sourceConnectionId: string; targetConnectionId: string; mode: 'COMPARE' | 'APPLY'; tables?: string[]; confirmTarget?: string; parallel?: number;
    };
    const [source, target] = await Promise.all([
      prisma.connection.findFirst({ where: { id: sourceConnectionId, userId } }),
      prisma.connection.findFirst({ where: { id: targetConnectionId, userId } }),
    ]);
    if (!source || !target) throw new AppError('Connection not found', 404, 'NOT_FOUND');
    if (!SUPPORTED.has(source.type) || !SUPPORTED.has(target.type)) {
      throw new AppError('Compare & sync supports MySQL and MariaDB databases for now', 400, 'UNSUPPORTED');
    }
    const s = toEngineConfig(source);
    const t = toEngineConfig(target);
    if (source.id === target.id || databaseAddress(s, s.database) === databaseAddress(t, t.database)) {
      throw new AppError('The source and the target are the same database', 400, 'SAME_DATABASE');
    }
    if (mode === 'APPLY') assertWritable(target, 'sync changes into it (Compare still works)');
    if (mode === 'APPLY' && confirmTarget !== t.database) {
      throw new AppError(
        `Syncing changes data in "${target.name}". To go ahead, confirm with its database name "${t.database}".`,
        409, 'CONFIRM_TARGET',
      );
    }
    const busy = await prisma.dataSyncRun.findFirst({
      where: { userId, targetConnectionId: target.id, status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    });
    if (busy) throw new AppError(`A compare or sync with "${target.name}" as the target is already running`, 409, 'SYNC_IN_PROGRESS');

    const run = await prisma.dataSyncRun.create({
      data: {
        userId, sourceConnectionId: source.id, targetConnectionId: target.id,
        sourceName: source.name, targetName: target.name, sourceDatabase: s.database, targetDatabase: t.database,
        mode, tables, parallel,
      },
    });
    try {
      await addDataSyncJob({ runId: run.id, userId });
    } catch (err) {
      await prisma.dataSyncRun.update({ where: { id: run.id }, data: { status: 'FAILED', error: 'Could not queue the run', completedAt: new Date() } });
      throw err;
    }
    await logAudit(userId, mode === 'APPLY' ? 'DATA_SYNC' : 'DATA_COMPARE', 'connection', {
      runId: run.id, source: source.name, target: target.name,
    }, req.ip);
    res.status(202).json({ success: true, data: { id: run.id } });
  } catch (err) { next(err); }
}

export async function listDataSyncs(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const runs = await prisma.dataSyncRun.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({
      success: true,
      data: {
        runs: runs.map((r) => ({
          ...r,
          rowsChecked: Number(r.rowsChecked),
          rowsEstimate: r.rowsEstimate === null ? null : Number(r.rowsEstimate),
        })),
        serverTime: new Date().toISOString(),
      },
    });
  } catch (err) { next(err); }
}

export async function cancelDataSync(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const run = await prisma.dataSyncRun.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
    if (!run) throw new AppError('Run not found', 404, 'NOT_FOUND');
    if (run.status !== 'PENDING' && run.status !== 'RUNNING') throw new AppError('This run has already finished', 400, 'NOT_RUNNING');
    if (run.status === 'PENDING') {
      // Not started yet: take it off the queue
      const job = await getDataSyncQueue().getJob(run.id);
      if (job && (await job.getState()) !== 'active') await job.remove().catch(() => undefined);
      await prisma.dataSyncRun.updateMany({ where: { id: run.id, status: 'PENDING' }, data: { status: 'CANCELLED', completedAt: new Date() } });
    }
    // A running one stops after its current chunk (the worker reads this flag every few seconds)
    await prisma.dataSyncRun.update({ where: { id: run.id }, data: { cancelRequested: true } });
    res.json({ success: true, message: 'Stopping' });
  } catch (err) { next(err); }
}
