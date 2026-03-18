import { Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { ConflictResolverService } from '../services/sync/conflict-resolver.service';
import { prisma } from '../config/database';

const conflictResolverService = new ConflictResolverService();

/**
 * Get all unresolved conflicts for a sync configuration
 * GET /api/sync/configurations/:id/conflicts
 * 
 * Requirements: 4.7
 */
export async function getUnresolvedConflicts(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Verify sync configuration exists
    const syncConfig = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: {
        sourceConnection: true,
        targetConnection: true,
      },
    });

    if (!syncConfig) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership via connection ownership
    if (
      syncConfig.sourceConnection.userId !== req.user!.userId ||
      syncConfig.targetConnection.userId !== req.user!.userId
    ) {
      throw new AppError('Access denied', 403);
    }

    // Get unresolved conflicts
    const conflicts = await conflictResolverService.getUnresolvedConflicts(id);

    res.json({
      success: true,
      data: conflicts,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Manually resolve a conflict
 * POST /api/sync/conflicts/:conflictId/resolve
 * 
 * Requirements: 4.8
 */
export async function resolveConflict(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { conflictId } = req.params;
    const { resolution } = req.body;

    // Validate resolution parameter
    if (!resolution || !['SOURCE', 'TARGET'].includes(resolution)) {
      throw new AppError('Invalid resolution. Must be "SOURCE" or "TARGET"', 400);
    }

    // Verify conflict exists
    const conflict = await prisma.conflict.findUnique({
      where: { id: conflictId },
      include: {
        syncConfig: {
          include: {
            sourceConnection: true,
            targetConnection: true,
          },
        },
      },
    });

    if (!conflict) {
      throw new AppError('Conflict not found', 404);
    }

    // Verify user ownership via connection ownership
    if (
      conflict.syncConfig.sourceConnection.userId !== req.user!.userId ||
      conflict.syncConfig.targetConnection.userId !== req.user!.userId
    ) {
      throw new AppError('Access denied', 403);
    }

    // Determine resolved data based on resolution choice
    const resolvedData = resolution === 'SOURCE' ? conflict.sourceData : conflict.targetData;

    // Resolve the conflict
    await conflictResolverService.resolveConflictManually(
      conflictId,
      resolvedData,
      req.user!.userId
    );

    res.json({
      success: true,
      message: 'Conflict resolved successfully',
    });
  } catch (err) {
    next(err);
  }
}
