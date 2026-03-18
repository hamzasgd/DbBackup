import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { prisma } from '../config/database';
import { engineFactory } from '../services/engines/engine.factory';
import { ConnectionConfig, BackupFormat } from '../services/engines/base.engine';
import { logger } from '../config/logger';
import { verifyBackup } from '../services/verification.service';
import { publishProgress, BACKUP_PROGRESS_CHANNEL } from '../services/sse.service';
import { notify } from '../services/notification.service';
import { uploadToS3 } from '../services/storage.service';
import { enforceRetentionForConnection } from '../services/retention.service';

export const BACKUP_QUEUE_NAME = 'backups';

export interface BackupJobData {
  backupId: string;
  connectionId: string;
  outputDir: string;
  config: ConnectionConfig;
  format?: BackupFormat;
}

let backupQueue: Queue<BackupJobData>;

export function getBackupQueue(): Queue<BackupJobData> {
  if (!backupQueue) {
    backupQueue = new Queue<BackupJobData>(BACKUP_QUEUE_NAME, {
      connection: getRedisConfig(),
    });
  }
  return backupQueue;
}

export async function addBackupJob(data: BackupJobData): Promise<void> {
  const queue = getBackupQueue();
  await queue.add('backup', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  });
}

export function createBackupWorker(): Worker<BackupJobData> {
  const worker = new Worker<BackupJobData>(
    BACKUP_QUEUE_NAME,
    async (job: Job<BackupJobData>) => {
      const { backupId, config, outputDir, format } = job.data;
      logger.info(`Backup worker picked job ${job.id} (backupId=${backupId}, db=${config.database})`);

      // Fetch connection to get userId for notifications/retention
      const backupRecord = await prisma.backup.findUnique({
        where: { id: backupId },
        include: { connection: { select: { userId: true, id: true } } },
      });
      const userId = backupRecord?.connection.userId ?? '';
      const connectionId = backupRecord?.connection.id ?? '';

      await prisma.backup.update({
        where: { id: backupId },
        data: { status: 'RUNNING', startedAt: new Date(), progress: 0 },
      });

      const resolvedFormat = format ?? (config.type === 'POSTGRESQL' ? 'CUSTOM' : 'COMPRESSED_SQL');

      try {
        const engine = engineFactory(config);

        // Progress callback: update DB + publish SSE every 10% step
        let lastReported = 0;
        const onProgress = async (pct: number) => {
          if (pct - lastReported >= 10) {
            lastReported = pct;
            logger.info(`Backup ${backupId} progress ${pct}%`);
            await prisma.backup.update({ where: { id: backupId }, data: { progress: pct } });
            await publishProgress(BACKUP_PROGRESS_CHANNEL(backupId), { progress: pct, status: 'RUNNING' });
          }
        };

        const result = await engine.backup(outputDir, {
          format: resolvedFormat,
          onProgress: (pct) => { void onProgress(pct); },
        });

        // ── Step 1: Verify integrity ──
        const verification = await verifyBackup(result.filePath, config.type, resolvedFormat);

        // ── Step 2: Upload to S3 if configured ──
        let storageType: 'LOCAL' | 'S3' = 'LOCAL';
        let storageKey: string | undefined;
        if (userId) {
          const uploaded = await uploadToS3(userId, result.filePath, result.fileName).catch((err) => {
            logger.warn('S3 upload failed (keeping local):', err);
            return null;
          });
          if (uploaded) {
            storageType = 'S3';
            storageKey = uploaded.storageKey;
          }
        }

        // ── Step 3: Mark completed ──
        await prisma.backup.update({
          where: { id: backupId },
          data: {
            status: 'COMPLETED',
            fileName: result.fileName,
            filePath: result.filePath,
            fileSize: result.fileSize,
            progress: 100,
            completedAt: new Date(),
            checksum: verification.checksum || null,
            verified: verification.valid,
            verifiedAt: verification.valid ? new Date() : null,
            storageType,
            storageKey: storageKey ?? null,
          },
        });

        // ── Step 4: Publish completion via SSE ──
        await publishProgress(BACKUP_PROGRESS_CHANNEL(backupId), {
          progress: 100,
          status: 'COMPLETED',
          verified: verification.valid,
        });

        logger.info(`✅ Backup completed: ${result.fileName} (verified: ${verification.valid})`);

        // ── Step 5: Notify on completion ──
        if (userId) {
          const sizeStr = `${(Number(result.fileSize) / 1_048_576).toFixed(2)} MB`;
          if (!verification.valid) {
            void notify(userId, {
              event: 'VERIFICATION_FAILED',
              title: '⚠️ Backup Verification Failed',
              message: `Backup "${result.fileName}" completed but failed integrity check.`,
              details: { File: result.fileName, Error: verification.error ?? 'Unknown', Size: sizeStr },
            });
          } else {
            void notify(userId, {
              event: 'BACKUP_COMPLETED',
              title: '✅ Backup Completed',
              message: `Backup "${result.fileName}" completed and verified successfully.`,
              details: { File: result.fileName, Size: sizeStr, Storage: storageType },
            });
          }

          // ── Step 6: Enforce retention ──
          const schedule = await prisma.schedule.findFirst({
            where: { connectionId },
            select: { retentionDays: true, retentionCount: true },
          });
          if (schedule) {
            void enforceRetentionForConnection(
              connectionId,
              schedule.retentionDays,
              schedule.retentionCount,
              userId,
            ).catch((err) => logger.warn('Retention enforcement failed:', err));
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        await prisma.backup.update({
          where: { id: backupId },
          data: { status: 'FAILED', error: errMsg, completedAt: new Date() },
        });
        await publishProgress(BACKUP_PROGRESS_CHANNEL(backupId), { progress: 0, status: 'FAILED', error: errMsg });
        logger.error(`❌ Backup failed for ${backupId}:`, error);

        if (userId) {
          void notify(userId, {
            event: 'BACKUP_FAILED',
            title: '❌ Backup Failed',
            message: `Backup job failed with error: ${errMsg}`,
            details: { 'Backup ID': backupId, Error: errMsg },
          });
        }

        throw error;
      }
    },
    { connection: getRedisConfig() }
  );

  worker.on('completed', (job) => logger.info(`Backup job ${job.id} completed`));
  worker.on('failed', (job, err) => logger.error(`Backup job ${job?.id} failed:`, err));
  worker.on('active', (job) => logger.info(`Backup job ${job.id} is active`));
  worker.on('stalled', (jobId) => logger.warn(`Backup job ${jobId} stalled`));
  worker.on('error', (err) => logger.error('Backup worker error:', err));

  return worker;
}
