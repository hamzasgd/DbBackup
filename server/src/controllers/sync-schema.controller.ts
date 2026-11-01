import { Response, NextFunction } from 'express';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { SchemaValidatorService } from '../services/sync/schema-validator.service';
import { prisma } from '../config/database';
import { toEngineConfig } from '../services/engines/connection-config';

const schemaValidatorService = new SchemaValidatorService();

/**
 * Get schema comparison between source and target databases
 * GET /api/sync/configurations/:id/schema-comparison
 * 
 * Requirements: 5.5
 */
export async function getSchemaComparison(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    // Verify the configuration exists and user owns it
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: {
        sourceConnection: true,
        targetConnection: true,
      },
    });

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership via connection ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    // Get schema comparison
    const comparison = await schemaValidatorService.getSchemaComparison(id);

    res.json({
      success: true,
      data: comparison,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Create missing tables in target database
 * POST /api/sync/configurations/:id/create-missing-tables
 * 
 * Requirements: 5.6
 */
export async function createMissingTables(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const { tables } = req.body;

    // Verify the configuration exists and user owns it
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: {
        sourceConnection: true,
        targetConnection: true,
      },
    });

    if (!config) {
      throw new AppError('Sync configuration not found', 404);
    }

    // Verify user ownership via connection ownership
    if (config.userId !== req.user!.userId) {
      throw new AppError('Access denied', 403);
    }

    // Validate tables parameter if provided
    if (tables !== undefined && !Array.isArray(tables)) {
      throw new AppError('tables must be an array of table names', 400);
    }

    // Get schema comparison to determine missing tables
    const comparison = await schemaValidatorService.getSchemaComparison(id);

    // Determine which tables to create
    const tablesToCreate = tables && tables.length > 0
      ? comparison.missingTables.filter(t => tables.includes(t))
      : comparison.missingTables;

    if (tablesToCreate.length === 0) {
      throw new AppError('No missing tables to create', 400);
    }

    // Decrypt the stored connections into engine configs
    const sourceConfig = toEngineConfig(config.sourceConnection);
    const targetConfig = toEngineConfig(config.targetConnection);

    // Create missing tables
    await schemaValidatorService.createMissingTables(
      sourceConfig,
      targetConfig,
      tablesToCreate
    );

    res.status(201).json({
      success: true,
      data: { tablesCreated: tablesToCreate },
      message: `Successfully created ${tablesToCreate.length} missing table(s)`,
    });
  } catch (err) {
    next(err);
  }
}
