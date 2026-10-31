import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { runHeartbeatChecks } from '../services/heartbeat.service';
import { runStorageChecks } from '../services/storage-alerts.service';
import { runBackupWatchdog } from '../services/backup-watchdog.service';
import { prisma } from '../config/database';
import { logger } from '../config/logger';

export const HEARTBEAT_QUEUE_NAME = 'db-heartbeat';

const INTERVAL_MINUTES = Math.max(1, parseInt(process.env.HEARTBEAT_INTERVAL_MINUTES ?? '5', 10) || 5);
const PATTERN = `*/${INTERVAL_MINUTES} * * * *`;
const SCHEDULER_ID = 'db-heartbeat-monitor';

let heartbeatQueue: Queue;

export function getHeartbeatQueue(): Queue {
  if (!heartbeatQueue) {
    heartbeatQueue = new Queue(HEARTBEAT_QUEUE_NAME, { connection: getRedisConfig() });
  }
  return heartbeatQueue;
}

export async function scheduleHeartbeatChecks(): Promise<void> {
  const queue = getHeartbeatQueue();
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: PATTERN },
    { name: 'db-heartbeat', data: {}, opts: { attempts: 1 } },
  );
  logger.info(`💓  DB heartbeat scheduled (every ${INTERVAL_MINUTES} min)`);
}

export function createHeartbeatWorker(): Worker {
  const worker = new Worker(
    HEARTBEAT_QUEUE_NAME,
    async (job: Job) => {
      const summary = await runHeartbeatChecks();
      if (summary.checked > 0) {
        logger.info(`💓  Heartbeat: ${summary.up} up / ${summary.down} down (${summary.checked} checked)`);
      }

      // Storage threshold alerts (self-throttled to hourly)
      const users = await prisma.user.findMany({ select: { id: true } });
      for (const u of users) {
        await runStorageChecks(u.id).catch((err) => logger.warn('Storage check failed:', err));
        await runBackupWatchdog(u.id).catch((err) => logger.warn('Backup watchdog failed:', err));
      }
    },
    { connection: getRedisConfig() },
  );

  worker.on('failed', (job, err) => logger.error(`Heartbeat job ${job?.id} failed:`, err));
  worker.on('error', (err) => logger.error('Heartbeat worker error:', err));

  return worker;
}
