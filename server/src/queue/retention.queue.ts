import { Queue, Worker, Job } from 'bullmq';
import { getRedisConfig } from '../config/redis';
import { runGlobalRetentionSweep } from '../services/retention.service';
import { logger } from '../config/logger';

export const RETENTION_QUEUE_NAME = 'retention';

// Daily sweep, offset from the common 02:00 backup window; override via RETENTION_SWEEP_CRON
const SWEEP_PATTERN = process.env.RETENTION_SWEEP_CRON || '30 3 * * *';
const SWEEP_SCHEDULER_ID = 'retention-daily-sweep';

let retentionQueue: Queue;

export function getRetentionQueue(): Queue {
  if (!retentionQueue) {
    retentionQueue = new Queue(RETENTION_QUEUE_NAME, { connection: getRedisConfig() });
  }
  return retentionQueue;
}

export async function scheduleRetentionSweep(): Promise<void> {
  const queue = getRetentionQueue();
  await queue.upsertJobScheduler(
    SWEEP_SCHEDULER_ID,
    { pattern: SWEEP_PATTERN },
    {
      name: 'retention-sweep',
      data: {},
      opts: { attempts: 1 },
    }
  );
  logger.info(`🗓️  Retention sweep scheduled (cron: ${SWEEP_PATTERN})`);
}

export function createRetentionWorker(): Worker {
  const worker = new Worker(
    RETENTION_QUEUE_NAME,
    async (job: Job) => {
      logger.info(`Retention sweep started (job ${job.id})`);
      const results = await runGlobalRetentionSweep();
      const deleted = results.reduce((sum, r) => sum + r.deleted, 0);
      logger.info(
        `🗑️  Retention sweep finished: ${deleted} backup(s) deleted across ${results.length} connection(s)`,
      );
    },
    { connection: getRedisConfig() }
  );

  worker.on('failed', (job, err) => logger.error(`Retention sweep job ${job?.id} failed:`, err));
  worker.on('error', (err) => logger.error('Retention worker error:', err));

  return worker;
}
