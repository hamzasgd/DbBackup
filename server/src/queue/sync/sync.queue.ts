import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../../config/redis';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { publishProgress } from '../../services/sse.service';
import { notify } from '../../services/notification.service';
import { engineFactory } from '../../services/engines/engine.factory';
import { ConnectionConfig } from '../../services/engines/base.engine';
import { connectionToConfig } from '../../services/sync/sync-utils';
import { SyncStatus } from '@prisma/client';
import { executeFullSync, SYNC_PROGRESS_CHANNEL } from './handlers/full-sync.handler';
import { executeIncrementalSync } from './handlers/incremental-sync.handler';

export const SYNC_QUEUE_NAME = 'sync';
export { SYNC_PROGRESS_CHANNEL };

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

const CHANGELOG_RETENTION_DAYS = 7;

export function createSyncWorker(): Worker<SyncJobData> {
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
        const sourceConfig = connectionToConfig(config.sourceConnection);
        const targetConfig = connectionToConfig(config.targetConnection);

        const sourceEngine = engineFactory(sourceConfig);
        const targetEngine = engineFactory(targetConfig);

        // Execute appropriate sync mode
        let totalRowsSynced = 0;
        let tablesProcessed = 0;
        let conflictsDetected = 0;
        let conflictsResolved = 0;
        let validationErrors = 0;

        if (mode === 'full') {
          const result = await executeFullSync({
            configId,
            config: {
              id: config.id,
              includeTables: config.includeTables,
              excludeTables: config.excludeTables,
              batchSize: config.batchSize,
            },
            syncStateId,
            job,
            sourceConfig,
            targetConfig,
            sourceEngine,
            targetEngine,
            strictTableOrdering,
          });
          totalRowsSynced = result.totalRowsSynced;
          tablesProcessed = result.tablesProcessed;
          validationErrors = result.validationErrors;

          // Establish initial checkpoint after full sync
          const { MySQLCDCTracker } = await import('../../services/sync/mysql-cdc-tracker.service');
          const { PostgreSQLCDCTracker } = await import('../../services/sync/postgresql-cdc-tracker.service');

          const sourceCDC =
            sourceConfig.type === 'MYSQL' || sourceConfig.type === 'MARIADB'
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
          const result = await executeIncrementalSync({
            configId,
            config: {
              id: config.id,
              direction: config.direction,
              conflictStrategy: config.conflictStrategy,
              batchSize: config.batchSize,
              syncState: {
                sourceCheckpoint: config.syncState?.sourceCheckpoint ?? null,
                targetCheckpoint: config.syncState?.targetCheckpoint ?? null,
              },
            },
            syncStateId,
            userId,
            job,
            sourceConfig,
            targetConfig,
            sourceEngine,
            targetEngine,
            strictTableOrdering,
          });
          totalRowsSynced = result.totalRowsSynced;
          tablesProcessed = result.tablesProcessed;
          conflictsDetected = result.conflictsDetected;
          conflictsResolved = result.conflictsResolved;
          validationErrors = result.validationErrors;
        }

        // Common completion logic
        const endTime = Date.now();
        const duration = endTime - startTime;

        const recentHistory = await prisma.syncHistory.findMany({
          where: { syncConfigId: configId },
          orderBy: { startedAt: 'desc' },
          take: 9,
          select: { duration: true },
        });

        const durations = [duration, ...recentHistory.map((h) => h.duration)];
        const averageDuration = Math.round(
          durations.reduce((sum, d) => sum + d, 0) / durations.length
        );

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

        await publishProgress(SYNC_PROGRESS_CHANNEL(configId), {
          progress: 100,
          status: 'COMPLETED',
          rowsSynced: totalRowsSynced,
          tablesProcessed,
          conflictsDetected,
          conflictsResolved,
        });

        logger.info(
          `Sync ${configId} completed. Rows synced: ${totalRowsSynced}, ` +
            `Tables: ${tablesProcessed}, Conflicts: ${conflictsDetected}/${conflictsResolved}`
        );

        void notify(userId, {
          event: 'SYNC_COMPLETED',
          title: 'Sync Completed',
          message: `Synchronization "${config.name}" completed successfully`,
          details: {
            'Rows Synced': totalRowsSynced.toString(),
            'Tables Processed': tablesProcessed.toString(),
            'Conflicts Resolved': `${conflictsResolved}/${conflictsDetected}`,
            Duration: `${(duration / 1000).toFixed(1)}s`,
          },
        });

        // Cleanup old change logs
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

        const currentState = await prisma.syncState.findUnique({
          where: { id: syncStateId },
        });

        const consecutiveFailures = (currentState?.consecutiveFailures ?? 0) + 1;

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

        await publishProgress(SYNC_PROGRESS_CHANNEL(configId), {
          status: 'FAILED',
          error: errMsg,
        });

        logger.error(`Sync ${configId} failed:`, error);

        void notify(userId, {
          event: 'SYNC_FAILED',
          title: 'Sync Failed',
          message: `Synchronization "${config.name}" failed: ${errMsg}`,
          details: {
            'Sync Configuration': config.name,
            Error: errMsg,
            'Consecutive Failures': consecutiveFailures.toString(),
          },
        });

        throw error;
      }
    },
    {
      connection: getRedisConfig(),
      concurrency: 5,
      lockDuration: 600000,
      stalledInterval: 300000,
      maxStalledCount: 3,
    }
  );

  worker.on('completed', (job) => logger.info(`Sync job ${job.id} completed`));
  worker.on('failed', (job, err) => logger.error(`Sync job ${job?.id} failed:`, err));
  worker.on('active', (job) => logger.info(`Sync job ${job.id} is active`));
  worker.on('stalled', (jobId) => logger.warn(`Sync job ${jobId} stalled`));
  worker.on('error', (err) => logger.error('Sync worker error:', err));

  return worker;
}
