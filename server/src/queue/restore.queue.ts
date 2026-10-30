import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { prisma } from '../config/database';
import { engineFactory } from '../services/engines/engine.factory';
import { ConnectionConfig } from '../services/engines/base.engine';
import { logger } from '../config/logger';
import { publishProgress, RESTORE_PROGRESS_CHANNEL } from '../services/sse.service';
import { notify } from '../services/notification.service';
import { ensureLocalBackupFile, cleanupTempFile } from '../services/storage.service';
import { decrypt, decryptIfPresent } from '../services/crypto.service';
import { logAudit } from '../services/audit.service';

export const RESTORE_QUEUE_NAME = 'restores';

export interface RestoreJobData {
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
    attempts: 1, // restores are not idempotent — never retry automatically
  });
}

function buildConnectionConfig(conn: {
  type: string;
  port: number;
  sslEnabled: boolean;
  sshEnabled: boolean;
  sshPort: number | null;
  host: string;
  username: string;
  password: string | null;
  database: string;
  sshHost: string | null;
  sshUsername: string | null;
  sshPrivateKey: string | null;
  sshPassphrase: string | null;
}): ConnectionConfig {
  return {
    type: conn.type as ConnectionConfig['type'],
    host: decrypt(conn.host),
    port: conn.port,
    username: decrypt(conn.username),
    password: conn.password ? decrypt(conn.password) : undefined,
    database: decrypt(conn.database),
    sslEnabled: conn.sslEnabled,
    sshEnabled: conn.sshEnabled,
    sshHost: decryptIfPresent(conn.sshHost) || undefined,
    sshPort: conn.sshPort || 22,
    sshUsername: decryptIfPresent(conn.sshUsername) || undefined,
    sshPrivateKey: decryptIfPresent(conn.sshPrivateKey) || undefined,
    sshPassphrase: decryptIfPresent(conn.sshPassphrase) || undefined,
  };
}

export function createRestoreWorker(): Worker<RestoreJobData> {
  const worker = new Worker<RestoreJobData>(
    RESTORE_QUEUE_NAME,
    async (job: Job<RestoreJobData>) => {
      const { jobId, backupId, userId, targetConnectionId, targetDatabase } = job.data;
      const channel = RESTORE_PROGRESS_CHANNEL(userId, jobId);

      logger.info(`Restore worker picked job ${job.id} (restoreId=${jobId}, backupId=${backupId})`);
      await publishProgress(channel, { progress: 0, status: 'RUNNING' });

      let tempPath: string | null = null;
      try {
        const backup = await prisma.backup.findFirst({
          where: { id: backupId, connection: { userId } },
        });
        if (!backup) throw new Error(`Backup not found: ${backupId}`);
        if (backup.status !== 'COMPLETED') throw new Error('Backup is not in completed state');

        const connId = targetConnectionId || backup.connectionId;
        const conn = await prisma.connection.findFirst({
          where: { id: connId, userId },
        });
        if (!conn) throw new Error(`Target connection not found: ${connId}`);

        // Resolve a local file: S3 backups are downloaded to a temp dir first
        const { localPath, downloaded } = await ensureLocalBackupFile(userId, backup);
        tempPath = downloaded ? localPath : null;

        const engine = engineFactory(buildConnectionConfig(conn));
        await engine.restore(localPath, targetDatabase);

        if (tempPath) cleanupTempFile(tempPath);

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
        if (tempPath) cleanupTempFile(tempPath);

        await publishProgress(channel, { progress: 0, status: 'FAILED', error: errMsg });
        logger.error(`❌ Restore failed (restoreId=${jobId}):`, error);

        void notify(userId, {
          event: 'RESTORE_FAILED',
          title: '❌ Restore Failed',
          message: `Restore job failed with error: ${errMsg}`,
          details: { 'Backup ID': backupId, Error: errMsg },
        }).catch((err) => logger.warn('Restore notification failed:', err));

        throw error;
      }
    },
    { connection: getRedisConfig() }
  );

  worker.on('completed', (job) => logger.info(`Restore job ${job.id} completed`));
  worker.on('failed', (job, err) => logger.error(`Restore job ${job?.id} failed:`, err));
  worker.on('error', (err) => logger.error('Restore worker error:', err));

  return worker;
}
