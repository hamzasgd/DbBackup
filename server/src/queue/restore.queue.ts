import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { prisma } from '../config/database';
import { engineFactory } from '../services/engines/engine.factory';
import { ConnectionConfig } from '../services/engines/base.engine';
import { logger } from '../config/logger';
import { publishProgress, RESTORE_PROGRESS_CHANNEL } from '../services/sse.service';
import { notify } from '../services/notification.service';
import { ensureLocalBackupFile, cleanupTempFile } from '../services/storage.service';
import { logAudit } from '../services/audit.service';
import { toEngineConfig, type StoredConnection } from '../services/engines/connection-config';
import { startRestoreTracker } from '../services/restore-progress.service';
import { outputSize, watchOutputSize } from '../services/engines/output-watcher';
import { backupLabel } from '../services/restore-safety.service';

export const RESTORE_QUEUE_NAME = 'restores';

export interface RestoreJobData {
  /** The `restores` row id (also the SSE channel id) */
  jobId: string;
  backupId: string;
  userId: string;
  targetConnectionId?: string;
  targetDatabase?: string;
}

let restoreQueue: Queue<RestoreJobData>;

export function getRestoreQueue(): Queue<RestoreJobData> {
  if (!restoreQueue) {
    restoreQueue = new Queue<RestoreJobData>(RESTORE_QUEUE_NAME, { connection: getRedisConfig() });
  }
  return restoreQueue;
}

export async function addRestoreJob(data: RestoreJobData): Promise<void> {
  const queue = getRestoreQueue();
  await queue.add('restore', data, {
    jobId: data.jobId,
    attempts: 1, // restores are not idempotent — never retry automatically
  });
}

function buildConnectionConfig(conn: StoredConnection): ConnectionConfig {
  return toEngineConfig(conn);
}

export function createRestoreWorker(): Worker<RestoreJobData> {
  const worker = new Worker<RestoreJobData>(
    RESTORE_QUEUE_NAME,
    async (job: Job<RestoreJobData>) => {
      const { jobId, backupId, userId, targetConnectionId, targetDatabase } = job.data;
      const channel = RESTORE_PROGRESS_CHANNEL(userId, jobId);

      logger.info(`Restore worker picked job ${job.id} (restoreId=${jobId}, backupId=${backupId})`);
      await publishProgress(channel, { progress: 0, status: 'RUNNING', stage: 'PREPARING' });

      // The row is created when the restore is requested; a job queued by an
      // older version has none, so create it here to still show progress
      const startedAt = new Date();
      const { count } = await prisma.restore.updateMany({
        where: { id: jobId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'RUNNING', startedAt, stage: 'PREPARING', error: null, progressAt: startedAt },
      });
      if (count === 0 && !(await prisma.restore.findUnique({ where: { id: jobId }, select: { id: true } }))) {
        await createRowForLegacyJob(job.data, startedAt);
      }
      const tracker = startRestoreTracker(jobId, userId);

      let tempPath: string | null = null;
      let stopWatch: () => void = () => undefined;
      try {
        const backup = await prisma.backup.findFirst({
          where: { id: backupId, userId },
        });
        if (!backup) throw new Error(`Backup not found: ${backupId}`);
        if (backup.status !== 'COMPLETED') throw new Error('Backup is not in completed state');

        const connId = targetConnectionId || backup.connectionId;
        if (!connId) throw new Error('Backup has no source connection; a target connection is required');
        const conn = await prisma.connection.findFirst({
          where: { id: connId, userId },
        });
        if (!conn) throw new Error(`Target connection not found: ${connId}`);

        // Resolve a local file: S3/Drive backups are downloaded, encrypted ones decrypted
        const stored = Number(backup.fileSize) || null;
        const { localPath, downloaded } = await ensureLocalBackupFile(userId, backup, {
          onStage: (stage, outputPath) => {
            stopWatch();
            tracker.setStage(stage, stored);
            stopWatch = watchOutputSize(outputPath, (b) => tracker.setBytes(b));
          },
        });
        stopWatch();
        tempPath = downloaded ? localPath : null;

        // Progress = how much of the file the restore tool has read
        tracker.setStage('RESTORING', outputSize(localPath) || null);
        const row = await prisma.restore.findUnique({ where: { id: jobId }, select: { strategy: true } });
        const engine = engineFactory(buildConnectionConfig(conn));
        await engine.restore(localPath, targetDatabase, {
          onBytes: (b) => tracker.setBytes(b),
          strategy: row?.strategy === 'SSH_SERVER' ? 'SSH_SERVER' : 'TUNNEL',
        });
        await tracker.stop();

        if (tempPath) cleanupTempFile(tempPath);

        await prisma.restore.updateMany({
          where: { id: jobId },
          data: { status: 'COMPLETED', stage: null, completedAt: new Date(), progressAt: new Date() },
        });
        await logAudit(userId, 'RESTORE', 'backup', { backupId, targetConnectionId: connId, targetDatabase });

        await publishProgress(channel, { progress: 100, status: 'COMPLETED' });
        logger.info(`✅ Restore completed (restoreId=${jobId})`);

        void notify(userId, {
          event: 'RESTORE_COMPLETED',
          title: '✅ Restore Completed',
          message: `Backup restored successfully to connection ${conn.name}.`,
          details: { 'Backup ID': backupId, 'Target Database': targetDatabase || backup.dbName },
        }).catch((err) => logger.warn('Restore notification failed:', err));
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        stopWatch();
        await tracker.stop();
        if (tempPath) cleanupTempFile(tempPath);

        await prisma.restore.updateMany({
          where: { id: jobId },
          data: { status: 'FAILED', stage: null, error: errMsg.slice(0, 4000), completedAt: new Date() },
        }).catch((err) => logger.warn(`Could not record failed restore ${jobId}:`, err));

        await publishProgress(channel, { progress: 0, status: 'FAILED', error: errMsg });
        logger.error(`❌ Restore failed (restoreId=${jobId}):`, error);

        await logAudit(userId, 'RESTORE_FAILED', 'backup', { backupId, targetConnectionId: targetConnectionId ?? null, error: errMsg });

        void notify(userId, {
          event: 'RESTORE_FAILED',
          title: '❌ Restore Failed',
          message: `Restore job failed with error: ${errMsg}`,
          details: { 'Backup ID': backupId, Error: errMsg },
        }).catch((err) => logger.warn('Restore notification failed:', err));

        throw error;
      }
    },
    {
      connection: getRedisConfig(),
      // A restore cut off by a stop or restart is NOT run again on its own:
      // re-running a half-done, destructive restore must be the user's call.
      // The job fails, and reconcileInterruptedRestores marks its row.
      maxStalledCount: 0,
    }
  );

  worker.on('completed', (job) => logger.info(`Restore job ${job.id} completed`));
  worker.on('failed', (job, err) => logger.error(`Restore job ${job?.id} failed:`, err));
  worker.on('error', (err) => logger.error('Restore worker error:', err));

  return worker;
}

async function createRowForLegacyJob(data: RestoreJobData, startedAt: Date): Promise<void> {
  const backup = await prisma.backup.findFirst({ where: { id: data.backupId, userId: data.userId } });
  const connId = data.targetConnectionId || backup?.connectionId || null;
  const conn = connId ? await prisma.connection.findFirst({ where: { id: connId, userId: data.userId } }) : null;
  let database = data.targetDatabase ?? '';
  if (!database && conn) {
    try { database = toEngineConfig(conn).database; } catch { /* label only */ }
  }
  await prisma.restore.create({
    data: {
      id: data.jobId,
      userId: data.userId,
      backupId: backup?.id ?? null,
      targetConnectionId: conn?.id ?? null,
      backupLabel: backup ? backupLabel(backup) : 'unknown backup',
      targetName: conn?.name ?? 'unknown connection',
      targetDatabase: database || backup?.dbName || '',
      status: 'RUNNING',
      stage: 'PREPARING',
      startedAt,
      progressAt: startedAt,
    },
  }).catch((err) => logger.warn(`Could not create a restore row for job ${data.jobId}:`, err));
}
