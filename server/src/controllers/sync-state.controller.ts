import { Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { SyncEngineService } from '../services/sync/sync-engine.service';

const syncEngineService = new SyncEngineService();

/**
 * Get the current sync state for a configuration
 * GET /api/sync/configurations/:id/state
 * 
 * Requirements: 13.1, 13.8
 */
export async function getSyncState(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Verify the configuration exists and user owns it
    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    const state = await syncEngineService.getSyncState(id);

    res.json({
      success: true,
      data: state,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get synchronization history for a configuration
 * GET /api/sync/configurations/:id/history
 * 
 * Requirements: 13.2, 13.8
 */
export async function getSyncHistory(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;

    // Validate limit
    if (limit < 1 || limit > 100) {
      throw new AppError('limit must be between 1 and 100', 400);
    }

    // Verify the configuration exists and user owns it
    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    const history = await syncEngineService.getSyncHistory(id, limit);

    res.json({
      success: true,
      data: history,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Activate a sync configuration
 * POST /api/sync/configurations/:id/activate
 * 
 * Requirements: 13.3, 13.8
 */
export async function activateSyncConfiguration(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const { performInitialSync } = req.body;

    // Verify the configuration exists and user owns it
    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    await syncEngineService.activateSyncConfiguration(
      id,
      performInitialSync ?? false
    );

    res.json({
      success: true,
      message: 'Sync configuration activated successfully',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Pause a sync configuration
 * POST /api/sync/configurations/:id/pause
 * 
 * Requirements: 13.4, 13.8
 */
export async function pauseSyncConfiguration(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Verify the configuration exists and user owns it
    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    await syncEngineService.pauseSyncConfiguration(id);

    res.json({
      success: true,
      message: 'Sync configuration paused successfully',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Resume a paused sync configuration
 * POST /api/sync/configurations/:id/resume
 * 
 * Requirements: 13.5, 13.8
 */
export async function resumeSyncConfiguration(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Verify the configuration exists and user owns it
    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    await syncEngineService.resumeSyncConfiguration(id);

    res.json({
      success: true,
      message: 'Sync configuration resumed successfully',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Stop a sync configuration
 * POST /api/sync/configurations/:id/stop
 * 
 * Requirements: 13.6, 13.8
 */
export async function stopSyncConfiguration(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Verify the configuration exists and user owns it
    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    await syncEngineService.stopSyncConfiguration(id);

    res.json({
      success: true,
      message: 'Sync configuration stopped successfully',
    });
  } catch (err) {
    next(err);
  }
}
