import { Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { SyncEngineService } from '../services/sync/sync-engine.service';
import { SyncDirection, SyncMode, ConflictStrategy } from '@prisma/client';

const syncEngineService = new SyncEngineService();

/**
 * Create a new sync configuration
 * POST /api/sync/configurations
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */
export async function createSyncConfiguration(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const {
      name,
      sourceConnectionId,
      targetConnectionId,
      direction,
      mode,
      conflictStrategy,
      includeTables,
      excludeTables,
      cronExpression,
      batchSize,
      parallelTables,
    } = req.body;

    // Validate required fields
    if (!name || !sourceConnectionId || !targetConnectionId) {
      throw new AppError('Missing required fields: name, sourceConnectionId, targetConnectionId', 400);
    }

    // Validate direction enum
    if (direction && !Object.values(SyncDirection).includes(direction)) {
      throw new AppError(`Invalid direction. Must be one of: ${Object.values(SyncDirection).join(', ')}`, 400);
    }

    // Validate mode enum
    if (mode && !Object.values(SyncMode).includes(mode)) {
      throw new AppError(`Invalid mode. Must be one of: ${Object.values(SyncMode).join(', ')}`, 400);
    }

    // Validate conflict strategy enum
    if (conflictStrategy && !Object.values(ConflictStrategy).includes(conflictStrategy)) {
      throw new AppError(
        `Invalid conflictStrategy. Must be one of: ${Object.values(ConflictStrategy).join(', ')}`,
        400
      );
    }

    // Validate cron expression if scheduled mode
    if (mode === SyncMode.SCHEDULED && !cronExpression) {
      throw new AppError('cronExpression is required for SCHEDULED mode', 400);
    }

    // Validate batch size
    if (batchSize !== undefined && (batchSize < 1 || batchSize > 10000)) {
      throw new AppError('batchSize must be between 1 and 10000', 400);
    }

    // Validate parallel tables
    if (parallelTables !== undefined && (parallelTables < 1 || parallelTables > 10)) {
      throw new AppError('parallelTables must be between 1 and 10', 400);
    }

    const syncConfig = await syncEngineService.createSyncConfiguration({
      userId: req.user!.userId,
      name,
      sourceConnectionId,
      targetConnectionId,
      direction,
      mode,
      conflictStrategy,
      includeTables,
      excludeTables,
      cronExpression,
      batchSize,
      parallelTables,
    });

    res.status(201).json({
      success: true,
      data: syncConfig,
      message: 'Sync configuration created successfully',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get all sync configurations for the authenticated user
 * GET /api/sync/configurations
 * 
 * Requirements: 1.8
 */
export async function getSyncConfigurations(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const configs = await syncEngineService.listSyncConfigurations(req.user!.userId);

    res.json({
      success: true,
      data: configs,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Get a single sync configuration by ID
 * GET /api/sync/configurations/:id
 * 
 * Requirements: 1.8
 */
export async function getSyncConfiguration(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const config = await syncEngineService.getSyncConfiguration(id);

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    res.json({
      success: true,
      data: config,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Update a sync configuration
 * PATCH /api/sync/configurations/:id
 * 
 * Requirements: 1.6
 */
export async function updateSyncConfiguration(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const {
      name,
      direction,
      mode,
      conflictStrategy,
      includeTables,
      excludeTables,
      cronExpression,
      batchSize,
      parallelTables,
    } = req.body;

    // First verify the configuration exists and user owns it
    const existingConfig = await syncEngineService.getSyncConfiguration(id);

    if (!existingConfig) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (existingConfig.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    // Validate direction enum
    if (direction && !Object.values(SyncDirection).includes(direction)) {
      throw new AppError(`Invalid direction. Must be one of: ${Object.values(SyncDirection).join(', ')}`, 400);
    }

    // Validate mode enum
    if (mode && !Object.values(SyncMode).includes(mode)) {
      throw new AppError(`Invalid mode. Must be one of: ${Object.values(SyncMode).join(', ')}`, 400);
    }

    // Validate conflict strategy enum
    if (conflictStrategy && !Object.values(ConflictStrategy).includes(conflictStrategy)) {
      throw new AppError(
        `Invalid conflictStrategy. Must be one of: ${Object.values(ConflictStrategy).join(', ')}`,
        400
      );
    }

    // Validate cron expression if mode is being changed to scheduled
    if (mode === SyncMode.SCHEDULED && !cronExpression && !existingConfig.cronExpression) {
      throw new AppError('cronExpression is required for SCHEDULED mode', 400);
    }

    // Validate batch size
    if (batchSize !== undefined && (batchSize < 1 || batchSize > 10000)) {
      throw new AppError('batchSize must be between 1 and 10000', 400);
    }

    // Validate parallel tables
    if (parallelTables !== undefined && (parallelTables < 1 || parallelTables > 10)) {
      throw new AppError('parallelTables must be between 1 and 10', 400);
    }

    const updatedConfig = await syncEngineService.updateSyncConfiguration(id, {
      name,
      direction,
      mode,
      conflictStrategy,
      includeTables,
      excludeTables,
      cronExpression,
      batchSize,
      parallelTables,
    });

    res.json({
      success: true,
      data: updatedConfig,
      message: 'Sync configuration updated successfully',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Delete a sync configuration
 * DELETE /api/sync/configurations/:id
 * 
 * Requirements: 1.7
 */
export async function deleteSyncConfiguration(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // First verify the configuration exists and user owns it
    const existingConfig = await syncEngineService.getSyncConfiguration(id);

    if (!existingConfig) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership
    if (existingConfig.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    await syncEngineService.deleteSyncConfiguration(id);

    res.json({
      success: true,
      message: 'Sync configuration deleted successfully',
    });
  } catch (err) {
    next(err);
  }
}
