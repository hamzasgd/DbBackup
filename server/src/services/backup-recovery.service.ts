import { Queue, JobType } from 'bullmq';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { notify } from './notification.service';
import { deleteBackupArtifact } from './storage.service';

/**
 * A backup row can outlive its job: when the app stops or restarts mid-dump
 * (deploy, crash, OOM kill) the job is gone or BullMQ gives up on it as
 * stalled, but nothing marks the row, so it shows RUNNING forever.
 *
 * This compares PENDING/RUNNING rows with the jobs the queue still has
 * (active, waiting, delayed…) and fails the orphans with a clear reason. A job
 * BullMQ re-queues after a restart is still in the queue, so it is left alone
 * and simply runs again.
 */

export const INTERRUPTED_MESSAGE =
  'Interrupted: the app stopped or restarted while this backup was running. Start it again.';

/** Rows younger than this are skipped: the job is enqueued just after the row is created. */
const GRACE_MS = 60_000;

const LIVE_STATES: JobType[] = ['active', 'waiting', 'delayed', 'prioritized', 'waiting-children'];

export async function reconcileInterruptedBackups(queue: Queue): Promise<number> {
  const candidates = await prisma.backup.findMany({
    where: {
      status: { in: ['PENDING', 'RUNNING'] },
      createdAt: { lt: new Date(Date.now() - GRACE_MS) },
    },
    select: { id: true, userId: true, dbName: true, status: true, filePath: true },
  });
  if (candidates.length === 0) return 0;

  const jobs = await queue.getJobs(LIVE_STATES);
  const live = new Set(jobs.map((j) => (j?.data as { backupId?: string } | undefined)?.backupId).filter(Boolean));

  let failed = 0;
  for (const b of candidates) {
    if (live.has(b.id)) continue;
    // Only flip rows still PENDING/RUNNING: never overwrite a result that
    // landed between the read above and this write
    const { count } = await prisma.backup.updateMany({
      where: { id: b.id, status: { in: ['PENDING', 'RUNNING'] } },
      data: { status: 'FAILED', error: INTERRUPTED_MESSAGE, completedAt: new Date(), stage: null },
    });
    if (count === 0) continue;
    failed++;
    // The killed dump's partial file (path recorded when it started)
    if (b.filePath && b.filePath !== 'pending') {
      await deleteBackupArtifact(b.userId, { filePath: b.filePath, storageType: 'LOCAL' })
        .catch((err) => logger.warn(`Could not remove partial file of backup ${b.id}:`, err));
    }
    logger.warn(`Backup ${b.id} (${b.dbName}) was ${b.status} with no queue job: marked FAILED (interrupted)`);
    void notify(b.userId, {
      event: 'BACKUP_FAILED',
      title: '❌ Backup Interrupted',
      message: `Backup of "${b.dbName}" stopped because the app stopped or restarted while it was running. Start it again.`,
      details: { 'Backup ID': b.id, Database: b.dbName },
    }).catch(() => undefined);
  }
  return failed;
}
