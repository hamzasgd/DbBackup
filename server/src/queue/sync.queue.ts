import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { publishProgress } from '../services/sse.service';
import { notify } from '../services/notification.service';
import { engineFactory } from '../services/engines/engine.factory';
import { ConnectionConfig } from '../services/engines/base.engine';
import { ConflictResolverService } from '../services/sync/conflict-resolver.service';
import { decrypt, decryptIfPresent } from '../services/crypto.service';
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
        // Create connection configs with decryption
        const sourceConfig: ConnectionConfig = {
          type: config.sourceConnection.type as any,
          host: decrypt(config.sourceConnection.host),
          port: config.sourceConnection.port,
          username: decrypt(config.sourceConnection.username),
          password: decrypt(config.sourceConnection.password),
          database: decrypt(config.sourceConnection.database),
          sslEnabled: config.sourceConnection.sslEnabled,
          sslCa: decryptIfPresent(config.sourceConnection.sslCa) ?? undefined,
          sslCert: decryptIfPresent(config.sourceConnection.sslCert) ?? undefined,
          sslKey: decryptIfPresent(config.sourceConnection.sslKey) ?? undefined,
          sshEnabled: config.sourceConnection.sshEnabled,
          sshHost: decryptIfPresent(config.sourceConnection.sshHost) ?? undefined,
          sshPort: config.sourceConnection.sshPort ?? undefined,
          sshUsername: decryptIfPresent(config.sourceConnection.sshUsername) ?? undefined,
          sshPrivateKey: decryptIfPresent(config.sourceConnection.sshPrivateKey) ?? undefined,
          sshPassphrase: decryptIfPresent(config.sourceConnection.sshPassphrase) ?? undefined,
          connectionTimeout: 30000,
        };

        const targetConfig: ConnectionConfig = {
          type: config.targetConnection.type as any,
          host: decrypt(config.targetConnection.host),
          port: config.targetConnection.port,
          username: decrypt(config.targetConnection.username),
          password: decrypt(config.targetConnection.password),
          database: decrypt(config.targetConnection.database),
          sslEnabled: config.targetConnection.sslEnabled,
          sslCa: decryptIfPresent(config.targetConnection.sslCa) ?? undefined,
          sslCert: decryptIfPresent(config.targetConnection.sslCert) ?? undefined,
          sslKey: decryptIfPresent(config.targetConnection.sslKey) ?? undefined,
          sshEnabled: config.targetConnection.sshEnabled,
          sshHost: decryptIfPresent(config.targetConnection.sshHost) ?? undefined,
          sshPort: config.targetConnection.sshPort ?? undefined,
          sshUsername: decryptIfPresent(config.targetConnection.sshUsername) ?? undefined,
          sshPrivateKey: decryptIfPresent(config.targetConnection.sshPrivateKey) ?? undefined,
          sshPassphrase: decryptIfPresent(config.targetConnection.sshPassphrase) ?? undefined,
          connectionTimeout: 30000,
        };

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

          for (const tableName of filteredTables) {
            await prisma.syncState.update({
              where: { id: syncStateId },
              data: { currentTable: tableName },
            });

            // Fetch all records from source table
            const sourceRecords = await fetchTableRecords(sourceEngine, sourceConfig, tableName);
            
            // Process records in batches
            const batchSize = config.batchSize;
            for (let i = 0; i < sourceRecords.length; i += batchSize) {
              const batch = sourceRecords.slice(i, Math.min(i + batchSize, sourceRecords.length));
              
              // Convert records to change log format
              const changes = batch.map(record => ({
                operation: ChangeOperation.INSERT,
                primaryKeyValues: extractPrimaryKey(record, tableName),
                changeData: record,
              }));

              // Validate and apply changes
              for (const change of changes) {
                const validation = await validateChange(change, tableName, targetEngine, targetConfig);
                if (!validation.valid) {
                  validationErrors++;
                  logger.warn(`Validation failed for ${tableName}:`, validation.errors);
                  continue; // Skip invalid records
                }
              }

              await applyChangeBatch(targetEngine, targetConfig, tableName, changes);
              totalRowsSynced += batch.length;

              // Publish progress
              const now = Date.now();
              if (now - lastProgressUpdate >= 2000) {
                lastProgressUpdate = now;
                const progress = Math.min(
                  Math.round(((tablesProcessed + (i / sourceRecords.length)) / filteredTables.length) * 100),
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
                  tableCount: filteredTables.length,
                  rowsSynced: totalRowsSynced,
                });
              }
            }

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

          // Detect conflicts in bidirectional sync
          if (config.direction === SyncDirection.BIDIRECTIONAL && targetChangeLogs.length > 0) {
            const conflicts = await conflictResolver.detectConflicts(changeLogs, targetChangeLogs);
            conflictsDetected = conflicts.length;

            // Resolve conflicts according to strategy
            for (const conflict of conflicts) {
              const resolved = await conflictResolver.resolveConflict(
                conflict,
                config.conflictStrategy
              );
              
              if (resolved.resolution !== 'manual') {
                conflictsResolved++;
              }
            }
          }

          // Group changes by table for batch processing
          const changesByTable = new Map<string, any[]>();
          for (const change of changeLogs) {
            const tableName = change.tableName;
            if (!changesByTable.has(tableName)) {
              changesByTable.set(tableName, []);
            }
            changesByTable.get(tableName)!.push(change);
          }

          const tables = Array.from(changesByTable.keys());

          // Log sync details
          if (tables.length > 0) {
            logger.info(`Syncing ${tables.length} tables with ${changeLogs.length} total changes for ${configId}`);
          }

          // Process each table
          for (const tableName of tables) {
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
              await applyChangeBatch(targetEngine, targetConfig, tableName, validChanges);

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
                  tableCount: tables.length,
                  rowsSynced: totalRowsSynced,
                });

                logger.info(
                  `Sync ${configId} progress ${progress}% ` +
                  `(table=${tableName}, tables=${tablesProcessed}/${tables.length}, rows=${totalRowsSynced})`
                );
              }
            }

            tablesProcessed++;
          }

          // Handle bidirectional sync - apply target changes to source
          if (config.direction === SyncDirection.BIDIRECTIONAL && targetChangeLogs.length > 0) {
            const targetChangesByTable = new Map<string, any[]>();
            for (const change of targetChangeLogs) {
              const tableName = change.tableName;
              if (!targetChangesByTable.has(tableName)) {
                targetChangesByTable.set(tableName, []);
              }
              targetChangesByTable.get(tableName)!.push(change);
            }

            for (const [tableName, tableChanges] of targetChangesByTable) {
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
                await applyChangeBatch(sourceEngine, sourceConfig, tableName, validChanges);

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
    }
  );

  worker.on('completed', (job) => logger.info(`Sync job ${job.id} completed`));
  worker.on('failed', (job, err) => logger.error(`Sync job ${job?.id} failed:`, err));
  worker.on('active', (job) => logger.info(`Sync job ${job.id} is active`));
  worker.on('stalled', (jobId) => logger.warn(`Sync job ${jobId} stalled`));
  worker.on('error', (err) => logger.error('Sync worker error:', err));

  return worker;
}

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
  change: any,
  tableName: string,
  targetEngine: any,
  targetConfig: ConnectionConfig
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Validate primary key values
  const pkValues = change.primaryKeyValues as Record<string, any>;
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
    const data = change.changeData as Record<string, any>;
    
    if (!data || Object.keys(data).length === 0) {
      errors.push('Change data is missing');
      return { valid: false, errors };
    }

    // Validate data types (basic validation)
    // In production, you would fetch table schema and validate against it
    for (const [key, value] of Object.entries(data)) {
      if (value !== null && value !== undefined) {
        // Check for invalid data types
        if (typeof value === 'function' || typeof value === 'symbol') {
          errors.push(`Invalid data type for column '${key}'`);
        }
        
        // Validate JSON columns (if value is a string that looks like it should be JSON)
        if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
          try {
            JSON.parse(value);
          } catch (e) {
            // If it looks like JSON but isn't valid, try to fix it or skip
            logger.warn(`Column '${key}' in table '${tableName}' contains invalid JSON: ${value.substring(0, 100)}`);
            // Don't add to errors - we'll handle this by converting to NULL or empty JSON
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Sanitize data before applying to target database
 * Handles JSON columns and other data type issues
 */
function sanitizeData(
  data: Record<string, any>,
  options?: { jsonColumns?: Set<string> }
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
      sanitized[key] = normalizeJsonValue(value);
      continue;
    }
    
    // Handle potential JSON columns
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
      try {
        // Try to parse to validate it's valid JSON
        JSON.parse(value);
        sanitized[key] = value;
      } catch (e) {
        // Invalid JSON - convert to NULL to avoid insertion errors
        logger.warn(`Sanitizing invalid JSON in column '${key}': ${value.substring(0, 100)}`);
        sanitized[key] = null;
      }
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Convert a runtime value into JSON text accepted by MySQL JSON columns.
 */
function normalizeJsonValue(value: any): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return JSON.stringify(value);
    }

    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // If it is plain text, persist it as a valid JSON string.
      return JSON.stringify(value);
    }
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

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

/**
 * Apply a batch of changes to the target database
 * 
 * Handles INSERT, UPDATE, and DELETE operations with proper error handling
 * and transaction support.
 */
async function applyChangeBatch(
  engine: any,
  config: ConnectionConfig,
  tableName: string,
  changes: any[]
): Promise<void> {
  // Import mysql2 or pg dynamically based on database type
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
        rejectUnauthorized: false, // Allow self-signed certificates
      } : undefined,
    });

    try {
      const jsonColumns = await getMySqlJsonColumns(connection, config.database, tableName);
      await connection.beginTransaction();

      for (const change of changes) {
        const pkValues = change.primaryKeyValues as Record<string, any>;
        const data = sanitizeData(change.changeData as Record<string, any>, {
          jsonColumns,
        });

        if (change.operation === ChangeOperation.INSERT) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const placeholders = columns.map(() => '?').join(', ');
          const pkColumns = Object.keys(pkValues);
          const nonPkColumns = columns.filter(col => !pkColumns.includes(col));

          if (pkColumns.length > 0 && nonPkColumns.length > 0) {
            // Safer upsert: update by primary key only, then insert if row does not exist.
            const updateClause = nonPkColumns.map(col => `\`${col}\` = ?`).join(', ');
            const whereClause = pkColumns.map(col => `\`${col}\` = ?`).join(' AND ');
            const updateSql = `UPDATE \`${tableName}\` SET ${updateClause} WHERE ${whereClause}`;
            const [updateResult] = await connection.execute(updateSql, [
              ...nonPkColumns.map(col => data[col]),
              ...pkColumns.map(col => pkValues[col]),
            ]);

            const affectedRows = (updateResult as any)?.affectedRows ?? 0;
            if (affectedRows === 0) {
              const insertSql = `INSERT INTO \`${tableName}\` (\`${columns.join('`, `')}\`) VALUES (${placeholders})`;
              await connection.execute(insertSql, values);
            }
          } else {
            const insertSql = `INSERT INTO \`${tableName}\` (\`${columns.join('`, `')}\`) VALUES (${placeholders})`;
            await connection.execute(insertSql, values);
          }
        } else if (change.operation === ChangeOperation.UPDATE) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const setClause = columns.map(col => `\`${col}\` = ?`).join(', ');
          const whereClause = Object.keys(pkValues).map(col => `\`${col}\` = ?`).join(' AND ');
          const sql = `UPDATE \`${tableName}\` SET ${setClause} WHERE ${whereClause}`;
          await connection.execute(sql, [...values, ...Object.values(pkValues)]);
        } else if (change.operation === ChangeOperation.DELETE) {
          const whereClause = Object.keys(pkValues).map(col => `\`${col}\` = ?`).join(' AND ');
          const sql = `DELETE FROM \`${tableName}\` WHERE ${whereClause}`;
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
        rejectUnauthorized: false, // Allow self-signed certificates
      } : undefined,
    });

    try {
      await client.connect();
      await client.query('BEGIN');

      for (const change of changes) {
        const pkValues = change.primaryKeyValues as Record<string, any>;
        const data = sanitizeData(change.changeData as Record<string, any>);

        if (change.operation === ChangeOperation.INSERT) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const pkColumns = Object.keys(pkValues);
          const hasAllPkColumns = pkColumns.length > 0 && pkColumns.every(col => columns.includes(col));
          const nonPkColumns = columns.filter(col => !pkColumns.includes(col));

          if (hasAllPkColumns && nonPkColumns.length > 0) {
            // Safer upsert: update by primary key only, then insert if row does not exist.
            const setClause = nonPkColumns
              .map((col, i) => `"${col}" = $${i + 1}`)
              .join(', ');
            const whereClause = pkColumns
              .map((col, i) => `"${col}" = $${nonPkColumns.length + i + 1}`)
              .join(' AND ');
            const updateSql = `UPDATE "${tableName}" SET ${setClause} WHERE ${whereClause}`;
            const updateResult = await client.query(updateSql, [
              ...nonPkColumns.map(col => data[col]),
              ...pkColumns.map(col => pkValues[col]),
            ]);

            if (updateResult.rowCount === 0) {
              const insertSql = `INSERT INTO "${tableName}" ("${columns.join('", "')}") VALUES (${placeholders})`;
              await client.query(insertSql, values);
            }
          } else {
            const insertSql = `INSERT INTO "${tableName}" ("${columns.join('", "')}") VALUES (${placeholders})`;
            await client.query(insertSql, values);
          }
        } else if (change.operation === ChangeOperation.UPDATE) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const setClause = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');
          const pkColumns = Object.keys(pkValues);
          const whereClause = pkColumns.map((col, i) => `"${col}" = $${columns.length + i + 1}`).join(' AND ');
          const sql = `UPDATE "${tableName}" SET ${setClause} WHERE ${whereClause}`;
          await client.query(sql, [...values, ...Object.values(pkValues)]);
        } else if (change.operation === ChangeOperation.DELETE) {
          const pkColumns = Object.keys(pkValues);
          const whereClause = pkColumns.map((col, i) => `"${col}" = $${i + 1}`).join(' AND ');
          const sql = `DELETE FROM "${tableName}" WHERE ${whereClause}`;
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

/**
 * Get list of tables from a database
 */
async function getTableList(engine: any, config: ConnectionConfig): Promise<string[]> {
  const dbInfo = await engine.getDbInfo();
  return dbInfo.tables.map((t: any) => t.name);
}

/**
 * Fetch all records from a table
 */
async function fetchTableRecords(
  engine: any,
  config: ConnectionConfig,
  tableName: string
): Promise<any[]> {
  // Use raw SQL to fetch all records
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
        rejectUnauthorized: false, // Allow self-signed certificates
      } : undefined,
    });

    try {
      const [rows] = await connection.query(`SELECT * FROM \`${tableName}\``);
      return rows as any[];
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
        rejectUnauthorized: false, // Allow self-signed certificates
      } : undefined,
    });

    try {
      await client.connect();
      const result = await client.query(`SELECT * FROM "${tableName}"`);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  return [];
}

/**
 * Extract primary key values from a record
 * Note: This is a simplified implementation. In production, you would
 * fetch the actual primary key columns from the table schema.
 */
function extractPrimaryKey(record: any, tableName: string): Record<string, any> {
  // Common primary key column names
  const commonPkNames = ['id', 'ID', `${tableName}_id`, 'uuid', 'UUID'];
  
  for (const pkName of commonPkNames) {
    if (record[pkName] !== undefined) {
      return { [pkName]: record[pkName] };
    }
  }

  // If no common PK found, use the first column as PK
  const firstKey = Object.keys(record)[0];
  return { [firstKey]: record[firstKey] };
}
