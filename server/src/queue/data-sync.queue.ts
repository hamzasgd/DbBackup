import { Queue, Worker, Job } from 'bullmq';
import { assertWritable } from '../services/write-protection';
import { getRedisConfig } from '../config/redis';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { notify } from '../services/notification.service';
import { toEngineConfig } from '../services/engines/connection-config';
import { mysqlDataSync, DataSyncStopped, type TableReport, type DataSyncProgress } from '../services/data-sync/mysql-data-sync';

export const DATA_SYNC_QUEUE_NAME = 'data-sync';

export interface DataSyncJobData {
  /** The data_sync_runs row */
  runId: string;
  userId: string;
}

let queue: Queue<DataSyncJobData>;

export function getDataSyncQueue(): Queue<DataSyncJobData> {
  if (!queue) queue = new Queue<DataSyncJobData>(DATA_SYNC_QUEUE_NAME, { connection: getRedisConfig() });
  return queue;
}

export async function addDataSyncJob(data: DataSyncJobData): Promise<void> {
  // Writes data: never retried on its own
  await getDataSyncQueue().add('data-sync', data, { jobId: data.runId, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
}

const PROGRESS_MS = 3000;

function summary(results: TableReport[]): string {
  const n = (s: TableReport['status']) => results.filter((r) => r.status === s).length;
  const rows = results.reduce((a, r) => a + r.inserted + r.updated + r.deleted, 0);
  return `${rows.toLocaleString()} rows differ · ${n('SAME')} tables same · ${n('SKIPPED') + n('ERROR')} skipped or failed`;
}

export function createDataSyncWorker(): Worker<DataSyncJobData> {
  const worker = new Worker<DataSyncJobData>(
    DATA_SYNC_QUEUE_NAME,
    async (job: Job<DataSyncJobData>) => {
      const { runId, userId } = job.data;
      const run = await prisma.dataSyncRun.findFirst({ where: { id: runId, userId } });
      if (!run || (run.status !== 'PENDING' && run.status !== 'RUNNING')) return;
      if (run.cancelRequested) {
        await prisma.dataSyncRun.update({ where: { id: runId }, data: { status: 'CANCELLED', completedAt: new Date() } });
        return;
      }

      const results: TableReport[] = [];
      let progress: DataSyncProgress | null = null;
      let cancel = false;
      const write = async () => {
        const row = await prisma.dataSyncRun.update({
          where: { id: runId },
          data: {
            currentTable: progress?.table ?? null,
            tablesDone: results.length,
            tablesTotal: progress?.tableCount ?? null,
            rowsChecked: BigInt(progress?.rowsChecked ?? 0),
            rowsEstimate: progress ? BigInt(progress.rowsEstimate) : null,
            results: results as never,
            progressAt: new Date(),
          },
          select: { cancelRequested: true },
        }).catch((err) => { logger.warn(`Data sync ${runId} progress update failed:`, err); return null; });
        if (row?.cancelRequested) cancel = true;
      };
      let inflight: Promise<void> = Promise.resolve();
      const timer = setInterval(() => { inflight = inflight.then(write); }, PROGRESS_MS);
      timer.unref?.();

      await prisma.dataSyncRun.update({ where: { id: runId }, data: { status: 'RUNNING', startedAt: new Date(), progressAt: new Date() } });
      const stopTimer = async () => { clearInterval(timer); await inflight; };

      try {
        const [source, target] = await Promise.all([
          prisma.connection.findFirst({ where: { id: run.sourceConnectionId ?? '', userId } }),
          prisma.connection.findFirst({ where: { id: run.targetConnectionId ?? '', userId } }),
        ]);
        if (!source || !target) throw new Error('The source or target connection was deleted');
        if (run.mode === 'APPLY') assertWritable(target, 'sync changes into it (Compare still works)');

        logger.info(`Data sync ${runId} (${run.mode} ${run.method}${run.since ? ` since ${run.since.toISOString()}` : ''}, ${run.parallel} at a time): ${run.sourceName} → ${run.targetName}`);
        const reports = await mysqlDataSync(toEngineConfig(source), toEngineConfig(target), {
          apply: run.mode === 'APPLY',
          tables: run.tables,
          parallel: run.parallel,
          quick: run.method === 'QUICK' && run.since ? { since: run.since.toISOString().replace('T', ' ').replace('Z', '') } : undefined,
          onStart: ({ sourceTime }) => {
            const t = new Date(`${sourceTime.replace(' ', 'T')}Z`);
            if (!Number.isNaN(t.getTime())) {
              void prisma.dataSyncRun.update({ where: { id: runId }, data: { sourceTime: t } }).catch(() => undefined);
            }
          },
          onProgress: (p) => { progress = p; },
          onTable: (r) => {
            results.push(r);
            if ((r.ms ?? 0) >= 10_000) {
              const secs = (r.ms ?? 0) / 1000;
              logger.info(`Data sync ${runId}: ${r.table} ${r.rows.toLocaleString()} rows in ${secs.toFixed(0)}s (${Math.round(r.rows / secs).toLocaleString()} rows/s)`);
            }
          },
          shouldStop: () => cancel,
        });
        await stopTimer();
        await prisma.dataSyncRun.update({
          where: { id: runId },
          data: {
            status: 'COMPLETED', completedAt: new Date(), progressAt: new Date(), currentTable: null,
            tablesDone: reports.length, results: reports as never,
            rowsChecked: BigInt((progress as DataSyncProgress | null)?.rowsChecked ?? 0),
            // Every row is counted by now
            rowsEstimate: BigInt((progress as DataSyncProgress | null)?.rowsChecked ?? 0),
          },
        });
        logger.info(`Data sync ${runId} finished: ${summary(reports)}`);
        void notify(userId, {
          event: 'SYNC_COMPLETED',
          title: run.mode === 'APPLY' ? '✅ Data sync finished' : '✅ Data comparison finished',
          message: `${run.sourceName} → ${run.targetName}: ${summary(reports)}`,
          details: { Source: `${run.sourceName} (${run.sourceDatabase})`, Target: `${run.targetName} (${run.targetDatabase})` },
        }).catch(() => undefined);
      } catch (err) {
        await stopTimer();
        // A query cancelled by Stop (MySQL error 1317) also means stopped
        const stopped = err instanceof DataSyncStopped || (cancel && (err as { errno?: number })?.errno === 1317);
        const message = err instanceof Error ? err.message : String(err);
        await prisma.dataSyncRun.update({
          where: { id: runId },
          data: {
            status: stopped ? 'CANCELLED' : 'FAILED', completedAt: new Date(), currentTable: null,
            error: stopped ? null : message.slice(0, 4000), results: results as never,
          },
        }).catch(() => undefined);
        if (stopped) { logger.info(`Data sync ${runId} stopped by the user`); return; }
        logger.error(`Data sync ${runId} failed:`, err);
        void notify(userId, {
          event: 'SYNC_FAILED',
          title: '❌ Data sync failed',
          message: `${run.sourceName} → ${run.targetName}: ${message.slice(0, 300)}`,
          details: { Source: run.sourceName, Target: run.targetName },
        }).catch(() => undefined);
        throw err;
      }
    },
    // One at a time; a run cut off by a restart is marked failed, not re-run
    { connection: getRedisConfig(), concurrency: 1, maxStalledCount: 0 },
  );
  worker.on('error', (err) => logger.error('Data sync worker error:', err));
  return worker;
}
