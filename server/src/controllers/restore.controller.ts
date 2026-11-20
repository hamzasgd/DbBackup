import { Response, NextFunction } from 'express';
import { assertWritable } from '../services/write-protection';
import { z } from 'zod';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { addRestoreJob } from '../queue/restore.queue';
import { checkRestoreTarget, type RestoreTargetCheck } from '../services/restore-safety.service';
import { logger } from '../config/logger';
import { resolveToolStrategy } from '../services/tool-strategy';

const checkQuerySchema = z.object({
  backupId: z.string().uuid('Invalid backup ID'),
  targetConnectionId: z.string().uuid('Invalid connection ID').optional(),
  targetDatabase: z.string().min(1).max(255).optional(),
});

function serializeCheck(c: RestoreTargetCheck) {
  return { ...c, backup: { ...c.backup, createdAt: c.backup.createdAt.toISOString() } };
}

/**
 * What a restore would do, before it starts: which database it overwrites,
 * whether that is the backup's own source, and whether it can run at all.
 * The restore dialog shows this and asks for a typed confirmation when the
 * target is the source.
 */
export async function checkRestore(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = checkQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? 'Invalid request', 400, 'VALIDATION_ERROR');
    const { backupId, targetConnectionId, targetDatabase } = parsed.data;
    const check = await checkRestoreTarget(req.user!.userId, backupId, targetConnectionId, targetDatabase);
    res.json({ success: true, data: serializeCheck(check) });
  } catch (err) { next(err); }
}

/**
 * Validate the restore request, record it and enqueue it.
 * The heavy work (download, decrypt, engine restore) runs in the restore
 * worker; progress is on the `restores` row (GET /api/restore) and streamed
 * via GET /api/restore/:jobId/progress (SSE).
 */
export async function restoreBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { backupId, targetConnectionId, targetDatabase, confirmOverwrite, strategy } = req.body as {
      backupId: string;
      targetConnectionId?: string;
      targetDatabase?: string;
      confirmOverwrite?: string;
      strategy?: string;
    };

    const check = await checkRestoreTarget(userId, backupId, targetConnectionId, targetDatabase);
    if (check.incompatible) throw new AppError(check.incompatible, 400, 'INCOMPATIBLE_TARGET');
    assertWritable({ name: check.target.name, writeProtected: check.target.writeProtected }, 'restore into it');
    const resolvedStrategy = resolveToolStrategy(strategy, {
      name: check.target.name, type: check.target.type, sshEnabled: check.target.sshEnabled,
    });
    if (check.busy) {
      throw new AppError(
        `A restore into "${check.target.name}" (${check.target.database}) is already ${check.busy.status === 'RUNNING' ? 'running' : 'queued'}. Wait for it to finish.`,
        409,
        'RESTORE_IN_PROGRESS',
      );
    }
    // Overwriting the live database the backup came from loses everything
    // written since the backup: only with the database name typed back
    if (check.overwritesSource && confirmOverwrite !== check.target.database) {
      throw new AppError(
        `"${check.target.name}" is the database this backup was taken from. Restoring replaces its current data with the backup's. To do it anyway, confirm with the database name "${check.target.database}".`,
        409,
        'CONFIRM_OVERWRITE_SOURCE',
      );
    }

    const restore = await prisma.restore.create({
      data: {
        userId,
        backupId: check.backup.id,
        targetConnectionId: check.target.connectionId,
        backupLabel: check.backup.label,
        targetName: check.target.name,
        targetDatabase: check.target.database,
        overwritesSource: check.overwritesSource,
        strategy: resolvedStrategy,
      },
    });

    try {
      await addRestoreJob({
        jobId: restore.id,
        backupId,
        userId,
        targetConnectionId: check.target.connectionId,
        targetDatabase: targetDatabase || undefined,
      });
    } catch (err) {
      await prisma.restore.update({
        where: { id: restore.id },
        data: { status: 'FAILED', error: 'Could not queue the restore', completedAt: new Date() },
      }).catch(() => undefined);
      throw err;
    }

    if (check.overwritesSource) {
      logger.warn(`Restore ${restore.id}: user ${userId} confirmed overwriting the backup's source database ${check.target.name}/${check.target.database}`);
    }

    res.status(202).json({
      success: true,
      data: { jobId: restore.id },
      message: 'Restore job queued',
    });
  } catch (err) { next(err); }
}

/** Recent restores (running first), with live progress fields. */
export async function listRestores(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const rows = await prisma.restore.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        backup: { select: { createdAt: true, fileSize: true, connection: { select: { name: true } } } },
      },
    });
    const restores = rows.map((r) => ({
      id: r.id,
      backupId: r.backupId,
      backupLabel: r.backupLabel,
      backupCreatedAt: r.backup?.createdAt.toISOString() ?? null,
      backupSourceName: r.backup?.connection?.name ?? null,
      targetConnectionId: r.targetConnectionId,
      targetName: r.targetName,
      targetDatabase: r.targetDatabase,
      overwritesSource: r.overwritesSource,
      strategy: r.strategy,
      status: r.status,
      stage: r.stage,
      bytesRead: Number(r.bytesRead),
      totalBytes: r.totalBytes === null ? null : Number(r.totalBytes),
      stageStartedAt: r.stageStartedAt?.toISOString() ?? null,
      progressAt: r.progressAt?.toISOString() ?? null,
      error: r.error,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json({ success: true, data: { restores, serverTime: new Date().toISOString() } });
  } catch (err) { next(err); }
}
