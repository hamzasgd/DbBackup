import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { prisma } from '../config/database';
import { ConnectionConfig } from '../services/engines/base.engine';
import { runMigration } from '../services/migration.service';
import { logger } from '../config/logger';
import { publishProgress, MIGRATION_PROGRESS_CHANNEL } from '../services/sse.service';
import { notify } from '../services/notification.service';

export const MIGRATION_QUEUE_NAME = 'migrations';

export interface MigrationJobData {
  migrationId: string;
  sourceConfig: ConnectionConfig;
  targetConfig: ConnectionConfig;
  tables?: string[];
  batchSize?: number;
}

let migrationQueue: Queue<MigrationJobData>;

export function getMigrationQueue(): Queue<MigrationJobData> {
  if (!migrationQueue) {
    migrationQueue = new Queue<MigrationJobData>(MIGRATION_QUEUE_NAME, {
      connection: getRedisConfig(),
    });
  }
  return migrationQueue;
}

export async function addMigrationJob(data: MigrationJobData): Promise<void> {
  const queue = getMigrationQueue();
  await queue.add('migration', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
  });
}

export function createMigrationWorker(): Worker<MigrationJobData> {
  const worker = new Worker<MigrationJobData>(
    MIGRATION_QUEUE_NAME,
    async (job: Job<MigrationJobData>) => {
      const { migrationId, sourceConfig, targetConfig, tables, batchSize } = job.data;

      await prisma.migration.update({
        where: { id: migrationId },
        data: { status: 'RUNNING', startedAt: new Date(), progress: 0 },
      });

      try {
        let lastProgressUpdate = Date.now();

        const result = await runMigration(sourceConfig, targetConfig, {
          tables,
          batchSize: batchSize ?? 500,
          onProgress: async (info) => {
            const now = Date.now();
            if (now - lastProgressUpdate > 3000) {
              lastProgressUpdate = now;
              await prisma.migration.update({
                where: { id: migrationId },
                data: {
                  progress: Math.min(info.progress, 99),
                  currentTable: info.currentTable,
                  tablesCompleted: info.tablesCompleted,
                  tableCount: info.tableCount,
                  rowsMigrated: info.rowsMigrated,
                },
              });
              await publishProgress(MIGRATION_PROGRESS_CHANNEL(migrationId), {
                progress: Math.min(info.progress, 99),
                status: 'RUNNING',
                currentTable: info.currentTable,
                tablesCompleted: info.tablesCompleted,
                tableCount: info.tableCount,
                rowsMigrated: Number(info.rowsMigrated),
              });
            }
          },
        });

        await prisma.migration.update({
          where: { id: migrationId },
          data: {
            status: 'COMPLETED',
            progress: 100,
            rowsMigrated: result.rowsMigrated,
            completedAt: new Date(),
            currentTable: null,
          },
        });

        await publishProgress(MIGRATION_PROGRESS_CHANNEL(migrationId), {
          progress: 100,
          status: 'COMPLETED',
          rowsMigrated: Number(result.rowsMigrated),
        });

        logger.info(`✅ Migration ${migrationId} completed. Rows migrated: ${result.rowsMigrated}`);

        // Fetch userId for notification
        const migRecord = await prisma.migration.findUnique({
          where: { id: migrationId },
          include: { sourceConnection: { select: { userId: true, name: true } }, targetConnection: { select: { name: true } } },
        });
        if (migRecord) {
          void notify(migRecord.sourceConnection.userId, {
            event: 'MIGRATION_COMPLETED',
            title: '✅ Migration Completed',
            message: `Migration from "${migRecord.sourceConnection.name}" to "${migRecord.targetConnection.name}" completed.`,
            details: { 'Rows Migrated': Number(result.rowsMigrated).toLocaleString() },
          });
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        await prisma.migration.update({
          where: { id: migrationId },
          data: { status: 'FAILED', error: errMsg, completedAt: new Date() },
        });
        await publishProgress(MIGRATION_PROGRESS_CHANNEL(migrationId), { status: 'FAILED', error: errMsg });

        const migRecord = await prisma.migration.findUnique({
          where: { id: migrationId },
          include: { sourceConnection: { select: { userId: true, name: true } }, targetConnection: { select: { name: true } } },
        });
        if (migRecord) {
          void notify(migRecord.sourceConnection.userId, {
            event: 'MIGRATION_FAILED',
            title: '❌ Migration Failed',
            message: `Migration from "${migRecord.sourceConnection.name}" to "${migRecord.targetConnection.name}" failed.`,
            details: { Error: errMsg },
          });
        }

        logger.error(`❌ Migration ${migrationId} failed:`, error);
        throw error;
      }
    },
    {
      connection: getRedisConfig(),
      concurrency: 2, // max 2 migrations in parallel
    }
  );

  worker.on('completed', (job) => logger.info(`Migration job ${job.id} completed`));
  worker.on('failed', (job, err) => logger.error(`Migration job ${job?.id} failed:`, err));

  return worker;
}
