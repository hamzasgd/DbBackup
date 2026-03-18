import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { prisma } from '../config/database';
import { addBackupJob } from './backup.queue';
import { decrypt, decryptIfPresent } from '../services/crypto.service';
import { logger } from '../config/logger';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import parser from 'cron-parser';

function getNextRunAt(cronExpression: string): Date | null {
  try {
    return parser.parseExpression(cronExpression, { currentDate: new Date() }).next().toDate();
  } catch {
    return null;
  }
}

export const SCHEDULE_QUEUE_NAME = 'schedules';

let scheduleQueue: Queue;

export function getScheduleQueue(): Queue {
  if (!scheduleQueue) {
    scheduleQueue = new Queue(SCHEDULE_QUEUE_NAME, { connection: getRedisConfig() });
  }
  return scheduleQueue;
}

export async function addScheduleJob(schedule: { id: string; cronExpression: string }): Promise<void> {
  const queue = getScheduleQueue();
  await queue.upsertJobScheduler(
    schedule.id,
    { pattern: schedule.cronExpression },
    {
      name: 'scheduled-backup',
      data: { scheduleId: schedule.id },
      opts: { attempts: 3 },
    }
  );
}

export async function removeScheduleJob(scheduleId: string): Promise<void> {
  const queue = getScheduleQueue();
  await queue.removeJobScheduler(scheduleId);
}

export function createScheduleWorker(): Worker {
  const worker = new Worker(
    SCHEDULE_QUEUE_NAME,
    async (job: Job) => {
      const { scheduleId } = job.data;
      logger.info(`Schedule worker picked job ${job.id} (scheduleId=${scheduleId})`);

      const schedule = await prisma.schedule.findUnique({
        where: { id: scheduleId },
        include: { connection: true },
      });

      if (!schedule || !schedule.isActive) return;

      const conn = schedule.connection;
      const outputDir = process.env.BACKUP_STORAGE_PATH || path.join(process.cwd(), 'backups');

      const defaultFormat = conn.type === 'POSTGRESQL' ? 'CUSTOM' : 'COMPRESSED_SQL';

      // Create backup record in DB BEFORE queuing the job
      const backupId = uuidv4();
      await prisma.backup.create({
        data: {
          id: backupId,
          connectionId: conn.id,
          fileName: 'pending',
          filePath: 'pending',
          dbType: conn.type,
          dbName: decrypt(conn.database),
          status: 'PENDING',
          format: defaultFormat,
          snapshotName: `scheduled-${schedule.name}`,
          startedAt: new Date(),
        },
      });

      await addBackupJob({
        backupId,
        connectionId: conn.id,
        outputDir,
        format: defaultFormat,
        config: {
          type: conn.type,
          host: decrypt(conn.host),
          port: conn.port,
          username: decrypt(conn.username),
          password: decrypt(conn.password),
          database: decrypt(conn.database),
          sslEnabled: conn.sslEnabled,
          sshEnabled: conn.sshEnabled,
          sshHost: decryptIfPresent(conn.sshHost) || undefined,
          sshPort: conn.sshPort || 22,
          sshUsername: decryptIfPresent(conn.sshUsername) || undefined,
          sshPrivateKey: decryptIfPresent(conn.sshPrivateKey) || undefined,
          sshPassphrase: decryptIfPresent(conn.sshPassphrase) || undefined,
        },
      });

      await prisma.schedule.update({
        where: { id: scheduleId },
        data: { lastRunAt: new Date(), nextRunAt: getNextRunAt(schedule.cronExpression) },
      });

      logger.info(`Scheduled backup triggered for connection ${conn.name}`);
    },
    { connection: getRedisConfig() }
  );

  worker.on('active', (job) => logger.info(`Schedule job ${job.id} is active`));
  worker.on('completed', (job) => logger.info(`Schedule job ${job.id} completed`));
  worker.on('failed', (job, err) => logger.error(`Schedule job ${job?.id} failed:`, err));
  worker.on('stalled', (jobId) => logger.warn(`Schedule job ${jobId} stalled`));
  worker.on('error', (err) => logger.error('Schedule worker error:', err));

  return worker;
}
