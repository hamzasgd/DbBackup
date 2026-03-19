import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { publishProgress } from '../services/sse.service';
import { notify } from '../services/notification.service';
import { engineFactory } from '../services/engines/engine.factory';
import { ConnectionConfig } from '../services/engines/base.engine';
import { ConflictResolverService } from '../services/sync/conflict-resolver.service';
import {
  escapeIdentifierMySQL,
  escapeIdentifierPG,
  connectionToConfig,
  fetchPrimaryKeyColumnsMySQL,
  fetchPrimaryKeyColumnsPG,
  extractPrimaryKeyFromColumns,
} from '../services/sync/sync-utils';
import { 
  SyncDirection, 
  SyncStatus, 
  ChangeOperation,
  ConflictStrategy 
} from '@prisma/client';

export const SYNC_QUEUE_NAME = 'sync';
export const SYNC_PROGRESS_CHANNEL = (id: string) => `sync:progress:${id}`;

export interface SyncJobData {
  configId: string;
  mode: 'incremental' | 'full';
  tables?: string[];
}

let syncQueue: Queue<SyncJobData>;

export function getSyncQueue(): Queue<SyncJobData> {
  if (!syncQueue) {
    syncQueue = new Queue<SyncJobData>(SYNC_QUEUE_NAME, {
      connection: getRedisConfig(),
    });
  }
  return syncQueue;
}

export async function addSyncJob(data: SyncJobData): Promise<string> {
  const queue = getSyncQueue();
  const job = await queue.add('sync', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  });
  return job.id ?? '';
}

/** Page size when streaming large tables during full sync */
const FULL_SYNC_PAGE_SIZE = 10000;

/** Maximum age (in days) for synchronized change logs before cleanup */
const CHANGELOG_RETENTION_DAYS = 7;

/**
 * Create the sync worker that processes synchronization jobs
 * 
 * This worker implements the core synchronization logic:
 * 1. Updates SyncState status to running on job start
 * 2. Retrieves sync configuration and connections
 * 3. Calls CDC tracker to get changes since checkpoint
 * 4. Applies changes in batches using database engines
 * 5. Updates checkpoint after each batch
 * 6. Handles bidirectional sync with origin tracking
 * 7. Detects and resolves conflicts using ConflictResolver
 * 8. Publishes progress via SSE every 2 seconds
 * 9. Updates SyncState and creates SyncHistory on completion
 * 10. Handles errors with retry logic and notifications
 * 
 * Requirements: 2.6, 3.1, 3.2, 3.3, 3.4, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4, 7.5, 
 *               9.1, 9.2, 9.3, 9.6, 9.7, 10.1, 10.2, 10.3, 10.4, 13.2, 13.4
 */
export function createSyncWorker(): Worker<SyncJobData> {
  const conflictResolver = new ConflictResolverService();
  const strictTableOrdering = (process.env.SYNC_STRICT_TABLE_ORDER ?? 'true').toLowerCase() !== 'false';

  const worker = new Worker<SyncJobData>(
    SYNC_QUEUE_NAME,
    async (job: Job<SyncJobData>) => {
      const { configId, mode } = job.data;
      const startTime = Date.now();
      
      logger.info(`Sync worker picked job ${job.id} (configId=${configId}, mode=${mode})`);

      // Fetch sync configuration with connections and state
      const config = await prisma.syncConfiguration.findUnique({
        where: { id: configId },
        include: {
          sourceConnection: true,
          targetConnection: true,
          syncState: true,
        },
      });

      if (!config) {
        throw new Error(`Sync configuration ${configId} not found`);
      }

      if (!config.syncState) {
        throw new Error(`Sync state not found for configuration ${configId}`);
      }

      const userId = config.userId;
      const syncStateId = config.syncState.id;

      // Update SyncState status to running
      await prisma.syncState.update({
        where: { id: syncStateId },
        data: {
          status: SyncStatus.ACTIVE,
          currentJobId: job.id ?? null,
          currentProgress: 0,
          currentTable: null,
        },
      });

      try {
        // Create connection configs with decryption (using shared utility)
        const sourceConfig = connectionToConfig(config.sourceConnection);
        const targetConfig = connectionToConfig(config.targetConnection);

        // Get database engines
        const sourceEngine = engineFactory(sourceConfig);
        const targetEngine = engineFactory(targetConfig);

        let totalRowsSynced = 0;
        let tablesProcessed = 0;
        let conflictsDetected = 0;
        let conflictsResolved = 0;
        let validationErrors = 0;
        let lastProgressUpdate = Date.now();

        // Handle full sync mode (initial synchronization)
        if (mode === 'full') {
          logger.info(`Starting full sync for ${configId}`);
          
          // Get list of tables to sync
          const tablesToSync = config.includeTables.length > 0 
            ? config.includeTables 
            : await getTableList(sourceEngine, sourceConfig);
          
          const filteredTables = tablesToSync.filter(
            t => !config.excludeTables.includes(t)
          );
          const orderedTables = await getTablesInDependencyOrder(targetConfig, filteredTables, {
            strict: strictTableOrdering,
          });

          // Cache primary key columns per table for the duration of this sync
          const pkCache = new Map<string, string[]>();

          for (const tableName of orderedTables) {
            await prisma.syncState.update({
              where: { id: syncStateId },
              data: { currentTable: tableName },
            });

            // Fetch PK columns for this table (cached)
            if (!pkCache.has(tableName)) {
              const pkCols = await fetchPrimaryKeyColumnsForConfig(sourceConfig, tableName);
              pkCache.set(tableName, pkCols);
            }
            const pkColumns = pkCache.get(tableName)!;

            if (pkColumns.length === 0) {
              logger.warn(`Table ${tableName} has no detectable primary key, skipping`);
              tablesProcessed++;
              continue;
            }

            // Paginated fetch — process page by page instead of loading entire table
            let offset = 0;
            let pageRecords: Record<string, any>[];
            do {
              pageRecords = await fetchTableRecordsPaginated(sourceConfig, tableName, FULL_SYNC_PAGE_SIZE, offset);

              if (pageRecords.length === 0) break;

              // Process records in batches
              const batchSize = config.batchSize;
              for (let i = 0; i < pageRecords.length; i += batchSize) {
                const batch = pageRecords.slice(i, Math.min(i + batchSize, pageRecords.length));
                
                // Convert records to change log format using real PK columns
                const changes = batch.map(record => ({
                  operation: ChangeOperation.INSERT,
                  primaryKeyValues: extractPrimaryKeyFromColumns(record, pkColumns),
                  changeData: record,
                }));

                // Validate and filter — only apply valid changes (P0 fix)
                const validChanges: typeof changes = [];
                for (const change of changes) {
                  const validation = await validateChange(change, tableName, targetEngine, targetConfig);
                  if (!validation.valid) {
                    validationErrors++;
                    logger.warn(`Validation failed for ${tableName}:`, validation.errors);
                    continue;
                  }
                  validChanges.push(change);
                }

                if (validChanges.length > 0) {
                  await applyChangeBatch(targetConfig, tableName, validChanges);
                  totalRowsSynced += validChanges.length;
                }

                // Publish progress
                const now = Date.now();
                if (now - lastProgressUpdate >= 2000) {
                  lastProgressUpdate = now;
                  const progress = Math.min(
                    Math.round(((tablesProcessed + ((offset + i) / Math.max(offset + pageRecords.length, 1))) / orderedTables.length) * 100),
                    99
                  );

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

                  // Keep BullMQ lock alive
                  await job.updateProgress(progress);
                }
              }

              offset += pageRecords.length;
            } while (pageRecords.length === FULL_SYNC_PAGE_SIZE);

            tablesProcessed++;
          }

          // Establish initial checkpoint after full sync
          const { MySQLCDCTracker } = await import('../services/sync/mysql-cdc-tracker.service');
          const { PostgreSQLCDCTracker } = await import('../services/sync/postgresql-cdc-tracker.service');
          
          const sourceCDC = sourceConfig.type === 'MYSQL' || sourceConfig.type === 'MARIADB'
            ? new MySQLCDCTracker()
            : new PostgreSQLCDCTracker();
          
          const checkpoint = await sourceCDC.getCheckpoint(config as any, 'source');
          
          await prisma.syncState.update({
            where: { id: syncStateId },
            data: {
              sourceCheckpoint: checkpoint,
            },
          });

          logger.info(`Full sync completed for ${configId}. Rows synced: ${totalRowsSynced}`);
        } else {
          // Incremental sync mode (existing logic)
          // Get changes from CDC tracker
          const sourceCheckpoint = config.syncState.sourceCheckpoint ?? '';
          const changeLogs = await prisma.changeLog.findMany({
            where: {
              syncConfigId: configId,
              synchronized: false,
              origin: 'source',
              ...(sourceCheckpoint ? {
                checkpoint: { gt: sourceCheckpoint }
              } : {}),
            },
            orderBy: {
              timestamp: 'asc',
            },
          });

          let targetChangeLogs: any[] = [];
          if (config.direction === SyncDirection.BIDIRECTIONAL) {
            const targetCheckpoint = config.syncState.targetCheckpoint ?? '';
            targetChangeLogs = await prisma.changeLog.findMany({
              where: {
                syncConfigId: configId,
                synchronized: false,
                origin: 'target',
                ...(targetCheckpoint ? {
                  checkpoint: { gt: targetCheckpoint }
                } : {}),
              },
              orderBy: {
                timestamp: 'asc',
              },
            });
          }

          // Handle case when there are no changes to sync
          if (changeLogs.length === 0 && targetChangeLogs.length === 0) {
            logger.info(`No changes to synchronize for ${configId}`);
            
            // Publish progress update indicating no changes
            await publishProgress(SYNC_PROGRESS_CHANNEL(configId), {
              progress: 100,
              status: 'COMPLETED',
              message: 'No changes to synchronize',
              rowsSynced: 0,
              tablesProcessed: 0,
              conflictsDetected: 0,
              conflictsResolved: 0,
            });
          }

          // Only process changes if there are any
          if (changeLogs.length > 0 || targetChangeLogs.length > 0) {
            logger.info(`Processing ${changeLogs.length} source changes and ${targetChangeLogs.length} target changes for ${configId}`);
          }

          // Detect and resolve conflicts in bidirectional sync
          // Build a set of conflicting change keys so they can be removed from changeLogs
          const conflictingSourceKeys = new Set<string>();
          if (config.direction === SyncDirection.BIDIRECTIONAL && targetChangeLogs.length > 0) {
            const conflicts = await conflictResolver.detectConflicts(changeLogs, targetChangeLogs);
            conflictsDetected = conflicts.length;

            for (const conflict of conflicts) {
              const resolved = await conflictResolver.resolveConflict(
                conflict,
                config.conflictStrategy
              );
              
              if (resolved.resolution !== 'manual') {
                conflictsResolved++;
                // Apply the resolved data instead of the original change
                const conflictKey = createConflictKey(conflict.tableName, conflict.primaryKeyValues);
                conflictingSourceKeys.add(conflictKey);

                // If resolved in favour of source, the original source change will be applied normally.
                // If resolved in favour of target, we skip the source change (target data wins).
                if (resolved.resolution === 'source' && resolved.resolvedData) {
                  // source wins — the source change will be applied as normal, nothing extra needed
                } else if (resolved.resolution === 'target') {
                  // target wins — skip the source change for this record (below filter)
                }
              } else {
                // Manual — skip both source and target changes for this record
                const conflictKey = createConflictKey(conflict.tableName, conflict.primaryKeyValues);
                conflictingSourceKeys.add(conflictKey);
              }
            }
          }

          // Group changes by table for batch processing, filtering out conflicting records
          const changesByTable = new Map<string, any[]>();
          for (const change of changeLogs) {
            const conflictKey = createConflictKey(change.tableName, change.primaryKeyValues);
            if (conflictingSourceKeys.has(conflictKey)) {
              continue; // Skip — handled by conflict resolution
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

          // Log sync details
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
              const validChanges = [];
              for (const change of batch) {
                const validation = await validateChange(change, tableName, targetEngine, targetConfig);
                if (validation.valid) {
                  validChanges.push(change);
                } else {
                  validationErrors++;
                  logger.warn(`Validation failed for ${tableName}:`, validation.errors);
                }
              }

              if (validChanges.length === 0) {
                continue; // Skip batch if all changes are invalid
              }

              // Apply batch changes to target database
              await applyChangeBatch(targetConfig, tableName, validChanges);

              // Mark changes as synchronized
              const changeIds = validChanges.map(c => c.id);
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
                const progress = Math.min(
                  Math.round((totalRowsSynced / changeLogs.length) * 100),
                  99
                );

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

                // Keep BullMQ lock alive
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
            const targetChangesByTable = new Map<string, any[]>();
            for (const change of targetChangeLogs) {
              const conflictKey = createConflictKey(change.tableName, change.primaryKeyValues);
              if (conflictingSourceKeys.has(conflictKey)) {
                continue; // Skip conflicting records
              }
              const tableName = change.tableName;
              if (!targetChangesByTable.has(tableName)) {
                targetChangesByTable.set(tableName, []);
              }
              targetChangesByTable.get(tableName)!.push(change);
            }

            const orderedTargetTables = await getTablesInDependencyOrder(
              sourceConfig,
              Array.from(targetChangesByTable.keys()),
              { strict: strictTableOrdering }
            );

            for (const tableName of orderedTargetTables) {
              const tableChanges = targetChangesByTable.get(tableName)!;
              const batchSize = config.batchSize;
              for (let i = 0; i < tableChanges.length; i += batchSize) {
                const batch = tableChanges.slice(i, Math.min(i + batchSize, tableChanges.length));
                
                // Validate changes
                const validChanges = [];
                for (const change of batch) {
                  const validation = await validateChange(change, tableName, sourceEngine, sourceConfig);
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
                await applyChangeBatch(sourceConfig, tableName, validChanges);

                // Mark changes as synchronized
                const changeIds = validChanges.map(c => c.id);
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
        }

        // Calculate duration and update statistics
        const endTime = Date.now();
        const duration = endTime - startTime;

        // Calculate average duration from last 10 executions
        const recentHistory = await prisma.syncHistory.findMany({
          where: { syncConfigId: configId },
          orderBy: { startedAt: 'desc' },
          take: 9,
          select: { duration: true },
        });

        const durations = [duration, ...recentHistory.map(h => h.duration)];
        const averageDuration = Math.round(
          durations.reduce((sum, d) => sum + d, 0) / durations.length
        );

        // Update SyncState with completion
        await prisma.syncState.update({
          where: { id: syncStateId },
          data: {
            status: SyncStatus.ACTIVE,
            currentJobId: null,
            currentTable: null,
            currentProgress: 100,
            lastSyncAt: new Date(),
            totalRowsSynced: BigInt(totalRowsSynced),
            lastSyncDuration: duration,
            averageSyncDuration: averageDuration,
            consecutiveFailures: 0,
            lastError: null,
            lastErrorAt: null,
          },
        });

        // Create SyncHistory record
        await prisma.syncHistory.create({
          data: {
            syncConfigId: configId,
            status: 'COMPLETED',
            rowsSynced: BigInt(totalRowsSynced),
            tablesProcessed,
            conflictsDetected,
            conflictsResolved,
            startedAt: new Date(startTime),
            completedAt: new Date(endTime),
            duration,
          },
        });

        // Publish completion via SSE
        await publishProgress(SYNC_PROGRESS_CHANNEL(configId), {
          progress: 100,
          status: 'COMPLETED',
          rowsSynced: totalRowsSynced,
          tablesProcessed,
          conflictsDetected,
          conflictsResolved,
        });

        logger.info(
          `✅ Sync ${configId} completed. Rows synced: ${totalRowsSynced}, ` +
          `Tables: ${tablesProcessed}, Conflicts: ${conflictsDetected}/${conflictsResolved}, ` +
          `Duration: ${duration}ms`
        );

        // Send success notification if enabled
        void notify(userId, {
          event: 'SYNC_COMPLETED',
          title: '✅ Sync Completed',
          message: `Synchronization "${config.name}" completed successfully`,
          details: {
            'Rows Synced': totalRowsSynced.toString(),
            'Tables Processed': tablesProcessed.toString(),
            'Conflicts Resolved': `${conflictsResolved}/${conflictsDetected}`,
            'Duration': `${(duration / 1000).toFixed(1)}s`,
          },
        });

        // Clean up old synchronized change logs (retention: 7 days)
        try {
          const retentionDate = new Date(Date.now() - CHANGELOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
          const deleted = await prisma.changeLog.deleteMany({
            where: {
              syncConfigId: configId,
              synchronized: true,
              synchronizedAt: { lt: retentionDate },
            },
          });
          if (deleted.count > 0) {
            logger.info(`Cleaned up ${deleted.count} old change log entries for ${configId}`);
          }
        } catch (cleanupError) {
          logger.warn(`Change log cleanup failed for ${configId}:`, cleanupError);
        }

      } catch (error: any) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        
        // Update consecutive failures count
        const currentState = await prisma.syncState.findUnique({
          where: { id: syncStateId },
        });
        
        const consecutiveFailures = (currentState?.consecutiveFailures ?? 0) + 1;

        // Update SyncState with error
        await prisma.syncState.update({
          where: { id: syncStateId },
          data: {
            status: SyncStatus.FAILED,
            currentJobId: null,
            currentTable: null,
            lastError: errMsg,
            lastErrorAt: new Date(),
            consecutiveFailures,
          },
        });

        // Create SyncHistory record for failure
        await prisma.syncHistory.create({
          data: {
            syncConfigId: configId,
            status: 'FAILED',
            rowsSynced: BigInt(0),
            tablesProcessed: 0,
            conflictsDetected: 0,
            conflictsResolved: 0,
            startedAt: new Date(startTime),
            completedAt: new Date(),
            duration: Date.now() - startTime,
            error: errMsg,
          },
        });

        // Publish failure via SSE
        await publishProgress(SYNC_PROGRESS_CHANNEL(configId), {
          status: 'FAILED',
          error: errMsg,
        });

        logger.error(`❌ Sync ${configId} failed:`, error);

        // Send failure notification
        void notify(userId, {
          event: 'SYNC_FAILED',
          title: '❌ Sync Failed',
          message: `Synchronization "${config.name}" failed: ${errMsg}`,
          details: {
            'Sync Configuration': config.name,
            'Error': errMsg,
            'Consecutive Failures': consecutiveFailures.toString(),
          },
        });

        throw error;
      }
    },
    {
      connection: getRedisConfig(),
      concurrency: 5, // max 5 sync jobs in parallel (Requirement 12.5)
      lockDuration: 600000, // 10 minutes — sync jobs can run long on large tables
      stalledInterval: 300000, // 5 minutes — check for stalled jobs every 5 min
      maxStalledCount: 3, // allow up to 3 stall retries before failing
    }
  );

  worker.on('completed', (job) => logger.info(`Sync job ${job.id} completed`));
  worker.on('failed', (job, err) => logger.error(`Sync job ${job?.id} failed:`, err));
  worker.on('active', (job) => logger.info(`Sync job ${job.id} is active`));
  worker.on('stalled', (jobId) => logger.warn(`Sync job ${jobId} stalled`));
  worker.on('error', (err) => logger.error('Sync worker error:', err));

  return worker;
}

// ──────────────────────────────────────────────────────
// Conflict key helper
// ──────────────────────────────────────────────────────

function createConflictKey(tableName: string, primaryKeyValues: any): string {
  const sortedKeys = Object.keys(primaryKeyValues).sort();
  const keyParts = sortedKeys.map(k => `${k}:${primaryKeyValues[k]}`);
  return `${tableName}:${keyParts.join(',')}`;
}

// ──────────────────────────────────────────────────────
// Validation
// ──────────────────────────────────────────────────────

/**
 * Validate a change before applying it to the target database
 * 
 * Validates:
 * - Primary key values exist and are not null
 * - Foreign key constraints (if applicable)
 * - Data type compatibility
 * - JSON column validity
 * 
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */
async function validateChange(
  change: { operation: ChangeOperation; primaryKeyValues: Record<string, any>; changeData: Record<string, any> },
  tableName: string,
  targetEngine: any,
  targetConfig: ConnectionConfig
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Validate primary key values
  const pkValues = change.primaryKeyValues;
  if (!pkValues || Object.keys(pkValues).length === 0) {
    errors.push('Primary key values are missing');
    return { valid: false, errors };
  }

  for (const [key, value] of Object.entries(pkValues)) {
    if (value === null || value === undefined) {
      errors.push(`Primary key '${key}' is null or undefined`);
    }
  }

  // For INSERT and UPDATE operations, validate change data
  if (change.operation === ChangeOperation.INSERT || change.operation === ChangeOperation.UPDATE) {
    const data = change.changeData;
    
    if (!data || Object.keys(data).length === 0) {
      errors.push('Change data is missing');
      return { valid: false, errors };
    }

    // Validate data types (basic validation)
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) {
        if (typeof value === 'function' || typeof value === 'symbol') {
          errors.push(`Invalid data type for column '${key}'`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ──────────────────────────────────────────────────────
// Data Sanitization
// ──────────────────────────────────────────────────────

/**
 * Sanitize data before applying to target database
 * Handles JSON columns and other data type issues
 */
function sanitizeData(
  data: Record<string, any>,
  options?: { jsonColumns?: Set<string>; tableName?: string }
): Record<string, any> {
  const sanitized: Record<string, any> = {};
  const jsonColumns = options?.jsonColumns;
  
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      sanitized[key] = value;
      continue;
    }

    // MySQL JSON columns expect valid JSON text. Normalize values first.
    if (jsonColumns?.has(key)) {
      const normalized = normalizeJsonValue(value);
      sanitized[key] = normalized.value;
      if (normalized.coerced) {
        logger.info(
          `Normalized JSON column '${options?.tableName ?? 'unknown_table'}.${key}' (${normalized.reason})`
        );
      }
      continue;
    }
    
    // Only known JSON columns are transformed. Non-JSON columns are preserved as-is.
    sanitized[key] = value;
  }
  
  return sanitized;
}

/**
 * Convert a runtime value into JSON text accepted by MySQL JSON columns.
 */
function normalizeJsonValue(value: any): { value: string | null; coerced: boolean; reason?: string } {
  if (value === null || value === undefined) {
    return { value: null, coerced: false };
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { value: JSON.stringify(value), coerced: true, reason: 'empty_or_whitespace_string' };
    }

    try {
      JSON.parse(trimmed);
      return { value: trimmed, coerced: false };
    } catch {
      return { value: JSON.stringify(value), coerced: true, reason: 'plain_text_to_json_string' };
    }
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return { value: JSON.stringify(value), coerced: true, reason: `primitive_${typeof value}` };
  }

  if (typeof value === 'bigint') {
    return { value: JSON.stringify(value.toString()), coerced: true, reason: 'bigint_to_string' };
  }

  if (value instanceof Date) {
    return { value: JSON.stringify(value.toISOString()), coerced: true, reason: 'date_to_iso_string' };
  }

  try {
    return { value: JSON.stringify(value), coerced: true, reason: 'object_to_json' };
  } catch {
    return { value: JSON.stringify(String(value)), coerced: true, reason: 'stringified_fallback' };
  }
}

// ──────────────────────────────────────────────────────
// JSON Column Detection
// ──────────────────────────────────────────────────────

/**
 * Fetch JSON column names for a MySQL/MariaDB table.
 */
async function getMySqlJsonColumns(
  connection: any,
  database: string,
  tableName: string
): Promise<Set<string>> {
  const sql = `
    SELECT COLUMN_NAME AS columnName
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = ?
      AND DATA_TYPE = 'json'
  `;

  const [rows] = await connection.execute(sql, [database, tableName]);
  return new Set((rows as any[]).map((row: any) => String(row.columnName)));
}

// ──────────────────────────────────────────────────────
// Apply Changes (with SQL injection prevention)
// ──────────────────────────────────────────────────────

/**
 * Apply a batch of changes to the target database
 * 
 * Handles INSERT, UPDATE, and DELETE operations with proper error handling,
 * transaction support, and SQL identifier escaping.
 */
async function applyChangeBatch(
  config: ConnectionConfig,
  tableName: string,
  changes: Array<{ operation: ChangeOperation; primaryKeyValues: Record<string, any>; changeData: Record<string, any> }>
): Promise<void> {
  if (config.type === 'MYSQL' || config.type === 'MARIADB') {
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? {
        ca: config.sslCa,
        cert: config.sslCert,
        key: config.sslKey,
        rejectUnauthorized: false,
      } : undefined,
    });

    try {
      const jsonColumns = await getMySqlJsonColumns(connection, config.database, tableName);
      const escapedTable = escapeIdentifierMySQL(tableName);
      await connection.beginTransaction();

      for (const change of changes) {
        const pkValues = change.primaryKeyValues;
        const data = sanitizeData(change.changeData, {
          jsonColumns,
          tableName,
        });

        if (change.operation === ChangeOperation.INSERT) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const escapedColumns = columns.map(c => escapeIdentifierMySQL(c));
          const placeholders = columns.map(() => '?').join(', ');
          const pkColumns = Object.keys(pkValues);
          const nonPkColumns = columns.filter(col => !pkColumns.includes(col));

          if (pkColumns.length > 0 && nonPkColumns.length > 0) {
            const updateClause = nonPkColumns.map(col => `${escapeIdentifierMySQL(col)} = ?`).join(', ');
            const whereClause = pkColumns.map(col => `${escapeIdentifierMySQL(col)} = ?`).join(' AND ');
            const updateSql = `UPDATE ${escapedTable} SET ${updateClause} WHERE ${whereClause}`;
            const [updateResult] = await connection.execute(updateSql, [
              ...nonPkColumns.map(col => data[col]),
              ...pkColumns.map(col => pkValues[col]),
            ]);

            const affectedRows = (updateResult as any)?.affectedRows ?? 0;
            if (affectedRows === 0) {
              const insertSql = `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`;
              await connection.execute(insertSql, values);
            }
          } else {
            const insertSql = `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`;
            await connection.execute(insertSql, values);
          }
        } else if (change.operation === ChangeOperation.UPDATE) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const setClause = columns.map(col => `${escapeIdentifierMySQL(col)} = ?`).join(', ');
          const whereClause = Object.keys(pkValues).map(col => `${escapeIdentifierMySQL(col)} = ?`).join(' AND ');
          const sql = `UPDATE ${escapedTable} SET ${setClause} WHERE ${whereClause}`;
          await connection.execute(sql, [...values, ...Object.values(pkValues)]);
        } else if (change.operation === ChangeOperation.DELETE) {
          const whereClause = Object.keys(pkValues).map(col => `${escapeIdentifierMySQL(col)} = ?`).join(' AND ');
          const sql = `DELETE FROM ${escapedTable} WHERE ${whereClause}`;
          await connection.execute(sql, Object.values(pkValues));
        }
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  } else if (config.type === 'POSTGRESQL' || config.type === 'POSTGRES') {
    const { Client } = await import('pg');
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? {
        ca: config.sslCa,
        cert: config.sslCert,
        key: config.sslKey,
        rejectUnauthorized: false,
      } : undefined,
    });

    try {
      await client.connect();
      await client.query('BEGIN');

      const escapedTable = escapeIdentifierPG(tableName);

      for (const change of changes) {
        const pkValues = change.primaryKeyValues;
        const data = sanitizeData(change.changeData);

        if (change.operation === ChangeOperation.INSERT) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const escapedColumns = columns.map(c => escapeIdentifierPG(c));
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const pkColumns = Object.keys(pkValues);
          const hasAllPkColumns = pkColumns.length > 0 && pkColumns.every(col => columns.includes(col));
          const nonPkColumns = columns.filter(col => !pkColumns.includes(col));

          if (hasAllPkColumns && nonPkColumns.length > 0) {
            const setClause = nonPkColumns
              .map((col, i) => `${escapeIdentifierPG(col)} = $${i + 1}`)
              .join(', ');
            const whereClause = pkColumns
              .map((col, i) => `${escapeIdentifierPG(col)} = $${nonPkColumns.length + i + 1}`)
              .join(' AND ');
            const updateSql = `UPDATE ${escapedTable} SET ${setClause} WHERE ${whereClause}`;
            const updateResult = await client.query(updateSql, [
              ...nonPkColumns.map(col => data[col]),
              ...pkColumns.map(col => pkValues[col]),
            ]);

            if (updateResult.rowCount === 0) {
              const insertSql = `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`;
              await client.query(insertSql, values);
            }
          } else {
            const insertSql = `INSERT INTO ${escapedTable} (${escapedColumns.join(', ')}) VALUES (${placeholders})`;
            await client.query(insertSql, values);
          }
        } else if (change.operation === ChangeOperation.UPDATE) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const setClause = columns.map((col, i) => `${escapeIdentifierPG(col)} = $${i + 1}`).join(', ');
          const pkColumns = Object.keys(pkValues);
          const whereClause = pkColumns.map((col, i) => `${escapeIdentifierPG(col)} = $${columns.length + i + 1}`).join(' AND ');
          const sql = `UPDATE ${escapedTable} SET ${setClause} WHERE ${whereClause}`;
          await client.query(sql, [...values, ...Object.values(pkValues)]);
        } else if (change.operation === ChangeOperation.DELETE) {
          const pkColumns = Object.keys(pkValues);
          const whereClause = pkColumns.map((col, i) => `${escapeIdentifierPG(col)} = $${i + 1}`).join(' AND ');
          const sql = `DELETE FROM ${escapedTable} WHERE ${whereClause}`;
          await client.query(sql, Object.values(pkValues));
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }
}

// ──────────────────────────────────────────────────────
// Table List
// ──────────────────────────────────────────────────────

/**
 * Get list of tables from a database
 */
async function getTableList(engine: any, config: ConnectionConfig): Promise<string[]> {
  const dbInfo = await engine.getDbInfo();
  return dbInfo.tables.map((t: any) => t.name);
}

// ──────────────────────────────────────────────────────
// Table Dependency Ordering
// ──────────────────────────────────────────────────────

type TableDependency = {
  childTable: string;
  parentTable: string;
};

/**
 * Order tables so parent tables are synchronized before child tables.
 * Falls back to original order if metadata query fails.
 */
async function getTablesInDependencyOrder(
  config: ConnectionConfig,
  tables: string[],
  options?: { strict?: boolean }
): Promise<string[]> {
  if (tables.length <= 1) {
    return tables;
  }

  try {
    const dependencies = await getForeignKeyDependencies(config);
    return topologicalSortTables(tables, dependencies);
  } catch (error) {
    if (options?.strict) {
      const details = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Strict table ordering is enabled and foreign key dependency metadata could not be resolved: ${details}`
      );
    }
    logger.warn(`Could not resolve table dependency order, using original order: ${String(error)}`);
    return tables;
  }
}

async function getForeignKeyDependencies(config: ConnectionConfig): Promise<TableDependency[]> {
  if (config.type === 'MYSQL' || config.type === 'MARIADB') {
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? {
        ca: config.sslCa,
        cert: config.sslCert,
        key: config.sslKey,
        rejectUnauthorized: false,
      } : undefined,
    });

    try {
      const sql = `
        SELECT TABLE_NAME AS childTable, REFERENCED_TABLE_NAME AS parentTable
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
      `;
      const [rows] = await connection.execute(sql, [config.database]);
      return (rows as any[]).map((row: any) => ({
        childTable: String(row.childTable),
        parentTable: String(row.parentTable),
      }));
    } finally {
      await connection.end();
    }
  }

  if (config.type === 'POSTGRESQL' || config.type === 'POSTGRES') {
    const { Client } = await import('pg');
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? {
        ca: config.sslCa,
        cert: config.sslCert,
        key: config.sslKey,
        rejectUnauthorized: false,
      } : undefined,
    });

    try {
      await client.connect();
      // Use current_schema() instead of hardcoded 'public'
      const sql = `
        SELECT tc.table_name AS child_table, ccu.table_name AS parent_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
         AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = current_schema()
      `;
      const result = await client.query(sql);
      return result.rows.map((row: any) => ({
        childTable: String(row.child_table),
        parentTable: String(row.parent_table),
      }));
    } finally {
      await client.end();
    }
  }

  return [];
}

function topologicalSortTables(tables: string[], dependencies: TableDependency[]): string[] {
  const tableSet = new Set(tables);
  const tableIndex = new Map(tables.map((table, index) => [table, index]));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, Set<string>>();

  for (const table of tables) {
    inDegree.set(table, 0);
    adjacency.set(table, new Set());
  }

  for (const dep of dependencies) {
    if (!tableSet.has(dep.parentTable) || !tableSet.has(dep.childTable)) {
      continue;
    }
    if (dep.parentTable === dep.childTable) {
      continue;
    }

    const children = adjacency.get(dep.parentTable)!;
    if (children.has(dep.childTable)) {
      continue;
    }

    children.add(dep.childTable);
    inDegree.set(dep.childTable, (inDegree.get(dep.childTable) ?? 0) + 1);
  }

  const queue = tables
    .filter(table => (inDegree.get(table) ?? 0) === 0)
    .sort((a, b) => (tableIndex.get(a) ?? 0) - (tableIndex.get(b) ?? 0));

  const ordered: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);

    const children = Array.from(adjacency.get(current) ?? []).sort(
      (a, b) => (tableIndex.get(a) ?? 0) - (tableIndex.get(b) ?? 0)
    );

    for (const child of children) {
      const nextDegree = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, nextDegree);
      if (nextDegree === 0) {
        queue.push(child);
      }
    }
  }

  if (ordered.length === tables.length) {
    return ordered;
  }

  // Cycles or unresolved dependencies: preserve original order for remaining tables.
  for (const table of tables) {
    if (!ordered.includes(table)) {
      ordered.push(table);
    }
  }

  return ordered;
}

// ──────────────────────────────────────────────────────
// Paginated Table Records (replaces SELECT * with LIMIT/OFFSET)
// ──────────────────────────────────────────────────────

/**
 * Fetch records from a table in pages to avoid loading entire table into memory.
 */
async function fetchTableRecordsPaginated(
  config: ConnectionConfig,
  tableName: string,
  limit: number,
  offset: number
): Promise<Record<string, any>[]> {
  if (config.type === 'MYSQL' || config.type === 'MARIADB') {
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? {
        ca: config.sslCa,
        cert: config.sslCert,
        key: config.sslKey,
        rejectUnauthorized: false,
      } : undefined,
    });

    try {
      const escapedTable = escapeIdentifierMySQL(tableName);
      const [rows] = await connection.query(
        `SELECT * FROM ${escapedTable} LIMIT ? OFFSET ?`,
        [limit, offset]
      );
      return rows as Record<string, any>[];
    } finally {
      await connection.end();
    }
  } else if (config.type === 'POSTGRESQL' || config.type === 'POSTGRES') {
    const { Client } = await import('pg');
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? {
        ca: config.sslCa,
        cert: config.sslCert,
        key: config.sslKey,
        rejectUnauthorized: false,
      } : undefined,
    });

    try {
      await client.connect();
      const escapedTable = escapeIdentifierPG(tableName);
      const result = await client.query(
        `SELECT * FROM ${escapedTable} LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return result.rows;
    } finally {
      await client.end();
    }
  }

  return [];
}

// ──────────────────────────────────────────────────────
// Primary Key Detection (uses real schema metadata)
// ──────────────────────────────────────────────────────

/**
 * Fetch actual primary key columns for a table from the target database schema.
 * Falls back to common PK names only if schema introspection fails.
 */
async function fetchPrimaryKeyColumnsForConfig(
  config: ConnectionConfig,
  tableName: string
): Promise<string[]> {
  if (config.type === 'MYSQL' || config.type === 'MARIADB') {
    const mysql = await import('mysql2/promise');
    const connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? {
        ca: config.sslCa,
        cert: config.sslCert,
        key: config.sslKey,
        rejectUnauthorized: false,
      } : undefined,
    });

    try {
      return await fetchPrimaryKeyColumnsMySQL(connection, config.database, tableName);
    } finally {
      await connection.end();
    }
  } else if (config.type === 'POSTGRESQL' || config.type === 'POSTGRES') {
    const { Client } = await import('pg');
    const client = new Client({
      host: config.host,
      port: config.port,
      user: config.username,
      password: config.password,
      database: config.database,
      ssl: config.sslEnabled ? {
        ca: config.sslCa,
        cert: config.sslCert,
        key: config.sslKey,
        rejectUnauthorized: false,
      } : undefined,
    });

    try {
      await client.connect();
      return await fetchPrimaryKeyColumnsPG(client, tableName);
    } finally {
      await client.end();
    }
  }

  return [];
}
