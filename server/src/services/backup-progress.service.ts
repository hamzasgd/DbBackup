import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { publishProgress, BACKUP_PROGRESS_CHANNEL } from './sse.service';

/**
 * Live progress for a running backup. Dump tools don't report a percentage,
 * so the honest signal is the size of the output on disk: it is sampled while
 * the dump runs and turned into a percentage against the size of the
 * connection's last completed backup (when there is one).
 *
 * The tracker writes to the DB and publishes over SSE every few seconds even
 * when nothing changed: `progressAt` is the worker's heartbeat, and
 * `bytesChangedAt` going stale while DUMPING is what the UI calls "no new data".
 */

export type BackupStage = 'DUMPING' | 'VERIFYING' | 'ENCRYPTING' | 'UPLOADING';

/** The dump fills 0-90% of the bar; the post-dump steps take the rest. */
const STAGE_PERCENT: Record<Exclude<BackupStage, 'DUMPING'>, number> = {
  VERIFYING: 91,
  ENCRYPTING: 94,
  UPLOADING: 97,
};

export function estimatePercent(stage: BackupStage, bytes: number, expectedBytes: number | null): number {
  if (stage !== 'DUMPING') return STAGE_PERCENT[stage];
  if (!expectedBytes || expectedBytes <= 0) return 0;
  return Math.max(0, Math.min(90, Math.floor((bytes / expectedBytes) * 90)));
}

/** Size of the connection's last completed backup in the same format, or null. */
export async function expectedBackupBytes(
  connectionId: string | null,
  format: string,
  excludeBackupId: string,
): Promise<bigint | null> {
  if (!connectionId) return null;
  const last = await prisma.backup.findFirst({
    where: {
      connectionId,
      status: 'COMPLETED',
      format: format as never,
      fileSize: { gt: 0 },
      id: { not: excludeBackupId },
    },
    orderBy: { createdAt: 'desc' },
    select: { fileSize: true },
  });
  return last ? BigInt(last.fileSize) : null;
}

export interface ProgressTracker {
  setBytes(bytes: number): void;
  setStage(stage: BackupStage): void;
  /** Writes the latest state now. */
  flush(): Promise<void>;
  /** Stops the heartbeat; no write happens after the returned promise resolves. */
  stop(): Promise<void>;
}

export function startProgressTracker(
  backupId: string,
  expectedBytes: bigint | null,
  intervalMs = 3000,
): ProgressTracker {
  const expected = expectedBytes === null ? null : Number(expectedBytes);
  let stage: BackupStage = 'DUMPING';
  let bytes = 0;
  let bytesChangedAt = new Date();
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();

  const write = async () => {
    if (stopped) return;
    const now = new Date();
    const progress = estimatePercent(stage, bytes, expected);
    try {
      await prisma.backup.update({
        where: { id: backupId },
        data: {
          progress,
          bytesWritten: BigInt(bytes),
          expectedBytes,
          stage,
          progressAt: now,
          bytesChangedAt,
        },
      });
      // Not awaited: a Redis hiccup must not stall the write chain (and with
      // it stop(), which the worker awaits before marking the backup done)
      void publishProgress(BACKUP_PROGRESS_CHANNEL(backupId), {
        status: 'RUNNING',
        progress,
        stage,
        bytesWritten: bytes,
        expectedBytes: expected,
        bytesChangedAt: bytesChangedAt.toISOString(),
        at: now.toISOString(),
      }).catch((err) => logger.warn(`Backup ${backupId} progress publish failed:`, err));
    } catch (err) {
      // Progress is best effort: never let it fail the backup itself
      logger.warn(`Backup ${backupId} progress update failed:`, err);
    }
  };

  // Serialise writes so an older state can never land after a newer one
  const flush = () => {
    inflight = inflight.then(write);
    return inflight;
  };

  const timer = setInterval(() => { void flush(); }, intervalMs);
  timer.unref?.();
  void flush();

  return {
    setBytes(n: number) {
      if (n !== bytes) {
        bytes = n;
        bytesChangedAt = new Date();
      }
    },
    setStage(next: BackupStage) {
      if (next === stage) return;
      stage = next;
      void flush();
    },
    flush,
    async stop() {
      clearInterval(timer);
      await inflight;
      stopped = true;
    },
  };
}
