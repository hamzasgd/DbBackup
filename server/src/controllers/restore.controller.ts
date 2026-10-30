import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { addRestoreJob } from '../queue/restore.queue';

/**
 * Validate the restore request and enqueue it.
 * The heavy work (S3 download + engine restore) runs in the restore worker —
 * long restores no longer block (and time out) the HTTP request.
 * Progress is streamed via GET /api/restore/:jobId/progress (SSE).
 */
export async function restoreBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { backupId, targetConnectionId, targetDatabase } = req.body;

    const backup = await prisma.backup.findFirst({
      where: { id: backupId, connection: { userId: req.user!.userId } },
    });
    if (!backup) throw new AppError('Backup not found', 404);
    if (backup.status !== 'COMPLETED') throw new AppError('Backup is not in completed state', 400);

    const connId = targetConnectionId || backup.connectionId;
    const conn = await prisma.connection.findFirst({
      where: { id: connId, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Target connection not found', 404);

    const jobId = uuidv4();
    await addRestoreJob({
      jobId,
      backupId,
      userId: req.user!.userId,
      targetConnectionId: targetConnectionId || undefined,
      targetDatabase,
    });

    res.status(202).json({
      success: true,
      data: { jobId },
      message: 'Restore job queued',
    });
  } catch (err) { next(err); }
}
