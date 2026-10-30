import { Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { SyncEngineService } from '../services/sync/sync-engine.service';
import { streamSSE } from '../services/sse.service';
import { SYNC_PROGRESS_CHANNEL } from '../queue/sync.queue';
import { prisma } from '../config/database';

const syncEngineService = new SyncEngineService();

/**
 * Trigger a manual sync for a configuration
 * POST /api/sync/configurations/:id/trigger
 * 
 * Requirements: 6.3, 10.1
 */
export async function triggerSync(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const { tables } = req.body;

    // Verify the configuration exists and user owns it
    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership via connection ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    // Per-run table filtering is not supported yet — reject explicitly instead
    // of silently ignoring the parameter. Configure tables via the sync
    // configuration's includeTables setting instead.
    if (tables !== undefined) {
      throw new AppError(
        'Per-run table filtering is not supported. Use the configuration\'s includeTables setting to select tables.',
        400,
      );
    }

    const jobId = await syncEngineService.triggerSync(id, false);

    res.status(202).json({
      success: true,
      data: { jobId },
      message: 'Sync job triggered successfully',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Trigger a full sync for a configuration
 * POST /api/sync/configurations/:id/full-sync
 * 
 * Requirements: 7.6, 7.7, 14.1
 */
export async function triggerFullSync(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const { tables } = req.body;

    // Verify the configuration exists and user owns it
    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership via connection ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    // Per-run table filtering is not supported yet — reject explicitly instead
    // of silently ignoring the parameter. Configure tables via the sync
    // configuration's includeTables setting instead.
    if (tables !== undefined) {
      throw new AppError(
        'Per-run table filtering is not supported. Use the configuration\'s includeTables setting to select tables.',
        400,
      );
    }

    const jobId = await syncEngineService.performFullSync(id);

    res.status(202).json({
      success: true,
      data: { jobId },
      message: 'Full sync job triggered successfully',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Stream sync progress updates via SSE
 * GET /api/sync/configurations/:id/progress
 * 
 * Requirements: 10.1
 */
export async function syncProgressSSE(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Verify the configuration exists and user owns it
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
    });

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    // Stream SSE progress updates
    streamSSE(res, SYNC_PROGRESS_CHANNEL(id));
  } catch (err) {
    next(err);
  }
}
