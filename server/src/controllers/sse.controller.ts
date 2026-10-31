import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { streamSSE, BACKUP_PROGRESS_CHANNEL, MIGRATION_PROGRESS_CHANNEL, RESTORE_PROGRESS_CHANNEL } from '../services/sse.service';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';

export async function backupProgressSSE(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!backup) { next(new AppError('Backup not found', 404)); return; }

    streamSSE(res, BACKUP_PROGRESS_CHANNEL(req.params.id));
  } catch (err) { next(err); }
}

export async function migrationProgressSSE(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const migration = await prisma.migration.findFirst({
      where: { id: req.params.id, sourceConnection: { userId: req.user!.userId } },
    });
    if (!migration) { next(new AppError('Migration not found', 404)); return; }

    streamSSE(res, MIGRATION_PROGRESS_CHANNEL(req.params.id));
  } catch (err) { next(err); }
}

/**
 * Restore progress SSE. The channel is keyed by the authenticated user's id,
 * so ownership is enforced by the channel itself (no DB lookup needed).
 */
export async function restoreProgressSSE(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    streamSSE(res, RESTORE_PROGRESS_CHANNEL(req.user!.userId, req.params.jobId));
  } catch (err) { next(err); }
}
