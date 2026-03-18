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
        // Create connection configs
        const sourceConfig: ConnectionConfig = {
          type: config.sourceConnection.type as any,
          host: config.sourceConnection.host,
          port: config.sourceConnection.port,
          username: config.sourceConnection.username,
          password: config.sourceConnection.password,
          database: config.sourceConnection.database,
          sslEnabled: config.sourceConnection.sslEnabled,
          sslCa: config.sourceConnection.sslCa ?? undefined,
          sslCert: config.sourceConnection.sslCert ?? undefined,
          sslKey: config.sourceConnection.sslKey ?? undefined,
          sshEnabled: config.sourceConnection.sshEnabled,
          sshHost: config.sourceConnection.sshHost ?? undefined,
          sshPort: config.sourceConnection.sshPort ?? undefined,
          sshUsername: config.sourceConnection.sshUsername ?? undefined,
          sshPrivateKey: config.sourceConnection.sshPrivateKey ?? undefined,
          sshPassphrase: config.sourceConnection.sshPassphrase ?? undefined,
          connectionTimeout: 30000,
        };

        const targetConfig: ConnectionConfig = {
          type: config.targetConnection.type as any,
          host: config.targetConnection.host,
          port: config.targetConnection.port,
          username: config.targetConnection.username,
          password: config.targetConnection.password,
          database: config.targetConnection.database,
          sslEnabled: config.targetConnection.sslEnabled,
          sslCa: config.targetConnection.sslCa ?? undefined,
          sslCert: config.targetConnection.sslCert ?? undefined,
          sslKey: config.targetConnection.sslKey ?? undefined,
          sshEnabled: config.targetConnection.sshEnabled,
          sshHost: config.targetConnection.sshHost ?? undefined,
          sshPort: config.targetConnection.sshPort ?? undefined,
          sshUsername: config.targetConnection.sshUsername ?? undefined,
          sshPrivateKey: config.targetConnection.sshPrivateKey ?? undefined,
          sshPassphrase: config.targetConnection.sshPassphrase ?? undefined,
          connectionTimeout: 30000,
        };

        // Get database engines
        const sourceEngine = engineFactory(sourceConfig);
        const targetEngine = engineFactory(targetConfig);

        // Get changes from CDC tracker
        const sourceCheckpoint = config.syncState.sourceCheckpoint ?? '';
        const changeLogs = await prisma.changeLog.findMany({
          where: {
            syncConfigId: configId,
            synchronized: false,
            origin: 'source',
            ...(mode === 'incremental' && sourceCheckpoint ? {
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
              ...(mode === 'incremental' && targetCheckpoint ? {
                checkpoint: { gt: targetCheckpoint }
              } : {}),
            },
            orderBy: {
              timestamp: 'asc',
            },
          });
        }

        // Detect conflicts in bidirectional sync
        let conflictsDetected = 0;
        let conflictsResolved = 0;
        
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
        let totalRowsSynced = 0;
        let tablesProcessed = 0;
        let lastProgressUpdate = Date.now();

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
            
            // Apply batch changes to target database
            await applyChangeBatch(targetEngine, targetConfig, tableName, batch);

            // Mark changes as synchronized
            const changeIds = batch.map(c => c.id);
            await prisma.changeLog.updateMany({
              where: { id: { in: changeIds } },
              data: {
                synchronized: true,
                synchronizedAt: new Date(),
              },
            });

            // Update checkpoint after successful batch
            const lastChange = batch[batch.length - 1];
            await prisma.syncState.update({
              where: { id: syncStateId },
              data: {
                sourceCheckpoint: lastChange.checkpoint,
              },
            });

            totalRowsSynced += batch.length;

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
              
              // Apply batch changes to source database
              await applyChangeBatch(sourceEngine, sourceConfig, tableName, batch);

              // Mark changes as synchronized
              const changeIds = batch.map(c => c.id);
              await prisma.changeLog.updateMany({
                where: { id: { in: changeIds } },
                data: {
                  synchronized: true,
                  synchronizedAt: new Date(),
                },
              });

              // Update target checkpoint
              const lastChange = batch[batch.length - 1];
              await prisma.syncState.update({
                where: { id: syncStateId },
                data: {
                  targetCheckpoint: lastChange.checkpoint,
                },
              });

              totalRowsSynced += batch.length;
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
      } : undefined,
    });

    try {
      await connection.beginTransaction();

      for (const change of changes) {
        const pkValues = change.primaryKeyValues as Record<string, any>;
        const data = change.changeData as Record<string, any>;

        if (change.operation === ChangeOperation.INSERT) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const placeholders = columns.map(() => '?').join(', ');
          const sql = `INSERT INTO \`${tableName}\` (\`${columns.join('`, `')}\`) VALUES (${placeholders})`;
          await connection.execute(sql, values);
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
      } : undefined,
    });

    try {
      await client.connect();
      await client.query('BEGIN');

      for (const change of changes) {
        const pkValues = change.primaryKeyValues as Record<string, any>;
        const data = change.changeData as Record<string, any>;

        if (change.operation === ChangeOperation.INSERT) {
          const columns = Object.keys(data);
          const values = Object.values(data);
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const sql = `INSERT INTO "${tableName}" ("${columns.join('", "')}") VALUES (${placeholders})`;
          await client.query(sql, values);
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
