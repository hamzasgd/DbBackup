import { Job } from 'bullmq';
import { SyncDirection } from '@prisma/client';
import { prisma } from '../../../config/database';
import { logger } from '../../../config/logger';
import { publishProgress } from '../../../services/sse.service';
import { ConnectionConfig } from '../../../services/engines/base.engine';
import { BaseEngine } from '../../../services/engines/base.engine';
import { ConflictResolverService } from '../../../services/sync/conflict-resolver.service';
import { validateChange } from '../validation/change-validator';
import { applyChangeBatch } from '../execution/change-applicator';
import { getTablesInDependencyOrder } from '../execution/table-ordered-executor';
import { createConflictKey } from '../utils/conflict-key';
import { SYNC_PROGRESS_CHANNEL } from '../sync.queue';
import type { SyncJobData } from '../sync.queue';

export interface IncrementalSyncContext {
  configId: string;
  config: {
    id: string;
    direction: SyncDirection;
    conflictStrategy: string;
    batchSize: number;
    syncState: {
      sourceCheckpoint: string | null;
      targetCheckpoint: string | null;
    };
  };
  syncStateId: string;
  userId: string;
  job: Job<SyncJobData>;
  sourceConfig: ConnectionConfig;
  targetConfig: ConnectionConfig;
  sourceEngine: BaseEngine;
  targetEngine: BaseEngine;
  strictTableOrdering: boolean;
}

export interface IncrementalSyncResult {
  totalRowsSynced: number;
  tablesProcessed: number;
  conflictsDetected: number;
  conflictsResolved: number;
  validationErrors: number;
}

/**
 * Execute incremental sync for a configuration.
 * Handles synchronization of changes captured since last checkpoint.
 */
export async function executeIncrementalSync(ctx: IncrementalSyncContext): Promise<IncrementalSyncResult> {
  const {
    configId,
    config,
    syncStateId,
    job,
    sourceConfig,
    targetConfig,
    sourceEngine,
    targetEngine,
    strictTableOrdering,
  } = ctx;
  const conflictResolver = new ConflictResolverService();

  let totalRowsSynced = 0;
  let tablesProcessed = 0;
  let conflictsDetected = 0;
  let conflictsResolved = 0;
  let validationErrors = 0;
  let lastProgressUpdate = Date.now();

  // Get changes from CDC tracker
  const sourceCheckpoint = config.syncState.sourceCheckpoint ?? '';
  const changeLogs = await prisma.changeLog.findMany({
    where: {
      syncConfigId: configId,
      synchronized: false,
      origin: 'source',
      ...(sourceCheckpoint
        ? {
            checkpoint: { gt: sourceCheckpoint },
          }
        : {}),
    },
    orderBy: {
      timestamp: 'asc',
    },
  });

  let targetChangeLogs: { id: string; tableName: string; primaryKeyValues: Record<string, unknown>; checkpoint: string }[] = [];
  if (config.direction === SyncDirection.BIDIRECTIONAL) {
    const targetCheckpoint = config.syncState.targetCheckpoint ?? '';
    const rawTargetLogs = await prisma.changeLog.findMany({
      where: {
        syncConfigId: configId,
        synchronized: false,
        origin: 'target',
        ...(targetCheckpoint
          ? {
              checkpoint: { gt: targetCheckpoint },
            }
          : {}),
      },
      orderBy: {
        timestamp: 'asc',
      },
    });
    targetChangeLogs = rawTargetLogs.map(log => ({
      id: log.id,
      tableName: log.tableName,
      primaryKeyValues: log.primaryKeyValues as Record<string, unknown>,
      checkpoint: log.checkpoint,
    }));
  }

  // Handle case when there are no changes to sync
  if (changeLogs.length === 0 && targetChangeLogs.length === 0) {
    logger.info(`No changes to synchronize for ${configId}`);

    await publishProgress(SYNC_PROGRESS_CHANNEL(configId), {
      progress: 100,
      status: 'COMPLETED',
      message: 'No changes to synchronize',
      rowsSynced: 0,
      tablesProcessed: 0,
      conflictsDetected: 0,
      conflictsResolved: 0,
    });
    return { totalRowsSynced: 0, tablesProcessed: 0, conflictsDetected: 0, conflictsResolved: 0, validationErrors: 0 };
  }

  // Only process changes if there are any
  if (changeLogs.length > 0 || targetChangeLogs.length > 0) {
    logger.info(
      `Processing ${changeLogs.length} source changes and ${targetChangeLogs.length} target changes for ${configId}`
    );
  }

  // Detect and resolve conflicts in bidirectional sync
  const conflictingSourceKeys = new Set<string>();
  if (config.direction === SyncDirection.BIDIRECTIONAL && targetChangeLogs.length > 0) {
    const conflicts = await conflictResolver.detectConflicts(
      changeLogs as any,
      targetChangeLogs as any
    );
    conflictsDetected = conflicts.length;

    for (const conflict of conflicts) {
      const resolved = await conflictResolver.resolveConflict(conflict, config.conflictStrategy as any);

      if (resolved.resolution !== 'manual') {
        conflictsResolved++;
        const conflictKey = createConflictKey(conflict.tableName, conflict.primaryKeyValues);
        conflictingSourceKeys.add(conflictKey);

        if (resolved.resolution === 'source' && resolved.resolvedData) {
          // source wins — the source change will be applied as normal
        } else if (resolved.resolution === 'target') {
          // target wins — skip the source change
        }
      } else {
        const conflictKey = createConflictKey(conflict.tableName, conflict.primaryKeyValues);
        conflictingSourceKeys.add(conflictKey);
      }
    }
  }

  // Group changes by table
  const changesByTable = new Map<string, typeof changeLogs>();
  for (const change of changeLogs) {
    const conflictKey = createConflictKey(change.tableName, change.primaryKeyValues as Record<string, unknown>);
    if (conflictingSourceKeys.has(conflictKey)) {
      continue;
    }
    const tableName = change.tableName;
    if (!changesByTable.has(tableName)) {
      changesByTable.set(tableName, []);
    }
    changesByTable.get(tableName)!.push(change);
  }

  const tables = Array.from(changesByTable.keys());
  const orderedTables = await getTablesInDependencyOrder(targetConfig, tables, {
    strict: strictTableOrdering,
  });

  if (tables.length > 0) {
    logger.info(`Syncing ${tables.length} tables with ${changeLogs.length} total changes for ${configId}`);
  }

  // Process each table
  for (const tableName of orderedTables) {
    const tableChanges = changesByTable.get(tableName)!;

    await prisma.syncState.update({
      where: { id: syncStateId },
      data: { currentTable: tableName },
    });

    // Process changes in batches
    const batchSize = config.batchSize;
    for (let i = 0; i < tableChanges.length; i += batchSize) {
      const batch = tableChanges.slice(i, Math.min(i + batchSize, tableChanges.length));

      // Validate changes before applying
      const validChanges: typeof tableChanges = [];
      for (const change of batch) {
        const validation = await validateChange(
          change as any,
          tableName,
          targetEngine,
          targetConfig
        );
        if (validation.valid) {
          validChanges.push(change);
        } else {
          validationErrors++;
          logger.warn(`Validation failed for ${tableName}:`, validation.errors);
        }
      }

      if (validChanges.length === 0) {
        continue;
      }

      // Apply batch changes to target database
      await applyChangeBatch(targetConfig, tableName, validChanges as any);

      // Mark changes as synchronized
      const changeIds = validChanges.map((c) => c.id);
      await prisma.changeLog.updateMany({
        where: { id: { in: changeIds } },
        data: {
          synchronized: true,
          synchronizedAt: new Date(),
        },
      });

      // Update checkpoint after successful batch
      const lastChange = validChanges[validChanges.length - 1];
      await prisma.syncState.update({
        where: { id: syncStateId },
        data: {
          sourceCheckpoint: lastChange.checkpoint,
        },
      });

      totalRowsSynced += validChanges.length;

      // Publish progress every 2 seconds
      const now = Date.now();
      if (now - lastProgressUpdate >= 2000) {
        lastProgressUpdate = now;
        const progress = Math.min(Math.round((totalRowsSynced / changeLogs.length) * 100), 99);

        await prisma.syncState.update({
          where: { id: syncStateId },
          data: {
            currentProgress: progress,
            totalRowsSynced: BigInt(totalRowsSynced),
          },
        });

        await publishProgress(SYNC_PROGRESS_CHANNEL(configId), {
          progress,
          status: 'RUNNING',
          currentTable: tableName,
          tablesProcessed,
          tableCount: orderedTables.length,
          rowsSynced: totalRowsSynced,
        });

        await job.updateProgress(progress);

        logger.info(
          `Sync ${configId} progress ${progress}% ` +
            `(table=${tableName}, tables=${tablesProcessed}/${orderedTables.length}, rows=${totalRowsSynced})`
        );
      }
    }

    tablesProcessed++;
  }

  // Handle bidirectional sync - apply target changes to source
  if (config.direction === SyncDirection.BIDIRECTIONAL && targetChangeLogs.length > 0) {
    const targetChangesByTable = new Map<string, typeof targetChangeLogs>();
    for (const change of targetChangeLogs) {
      const conflictKey = createConflictKey(change.tableName, change.primaryKeyValues);
      if (conflictingSourceKeys.has(conflictKey)) {
        continue;
      }
      const tableName = change.tableName;
      if (!targetChangesByTable.has(tableName)) {
        targetChangesByTable.set(tableName, []);
      }
      targetChangesByTable.get(tableName)!.push(change);
    }

    const orderedTargetTables = await getTablesInDependencyOrder(sourceConfig, Array.from(targetChangesByTable.keys()), {
      strict: strictTableOrdering,
    });

    for (const tableName of orderedTargetTables) {
      const tableChanges = targetChangesByTable.get(tableName)!;
      const batchSize = config.batchSize;
      for (let i = 0; i < tableChanges.length; i += batchSize) {
        const batch = tableChanges.slice(i, Math.min(i + batchSize, tableChanges.length));

        // Validate changes
        const validChanges: typeof tableChanges = [];
        for (const change of batch) {
          const validation = await validateChange(change as any, tableName, sourceEngine, sourceConfig);
          if (validation.valid) {
            validChanges.push(change);
          } else {
            validationErrors++;
            logger.warn(`Validation failed for ${tableName}:`, validation.errors);
          }
        }

        if (validChanges.length === 0) {
          continue;
        }

        // Apply batch changes to source database
        await applyChangeBatch(sourceConfig, tableName, validChanges as any);

        // Mark changes as synchronized
        const changeIds = validChanges.map((c) => c.id);
        await prisma.changeLog.updateMany({
          where: { id: { in: changeIds } },
          data: {
            synchronized: true,
            synchronizedAt: new Date(),
          },
        });

        // Update target checkpoint
        const lastChange = validChanges[validChanges.length - 1];
        await prisma.syncState.update({
          where: { id: syncStateId },
          data: {
            targetCheckpoint: lastChange.checkpoint,
          },
        });

        totalRowsSynced += validChanges.length;
      }
    }
  }

  return { totalRowsSynced, tablesProcessed, conflictsDetected, conflictsResolved, validationErrors };
}
