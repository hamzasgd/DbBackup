import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { publishProgress, RESTORE_PROGRESS_CHANNEL } from './sse.service';

/**
 * Live progress for a running restore. Restore tools don't report a
 * percentage, but the honest signal is how much of the backup file has been
 * read: the tools read it only as fast as the database takes the data in.
 *
 * Every few seconds the tracker writes the latest state to the `restores` row
 * and publishes it over SSE, even when nothing changed: `progressAt` is the
 * worker's heartbeat, so the UI can tell a slow restore from a dead one.
 */

export type RestoreStage = 'PREPARING' | 'DOWNLOADING' | 'DECRYPTING' | 'RESTORING';

export interface RestoreTracker {
  /** Start a step: bytes go back to 0 and count up towards `totalBytes` (null = unknown). */
  setStage(stage: RestoreStage, totalBytes: number | null): void;
  setBytes(bytes: number): void;
  /** Stops the heartbeat; no write happens after the returned promise resolves. */
  stop(): Promise<void>;
}

export function startRestoreTracker(restoreId: string, userId: string, intervalMs = 3000): RestoreTracker {
  let stage: RestoreStage = 'PREPARING';
  let bytes = 0;
  let total: number | null = null;
  let stageStartedAt = new Date();
  let stopped = false;
  let inflight: Promise<void> = Promise.resolve();
  const channel = RESTORE_PROGRESS_CHANNEL(userId, restoreId);

  const write = async () => {
    if (stopped) return;
    const now = new Date();
    try {
      // updateMany: a missing row (deleted user) must not throw every 3 seconds
      await prisma.restore.updateMany({
        where: { id: restoreId, status: 'RUNNING' },
        data: {
          stage,
          bytesRead: BigInt(bytes),
          totalBytes: total === null ? null : BigInt(total),
          stageStartedAt,
          progressAt: now,
        },
      });
      // Not awaited: a Redis hiccup must not stall the chain (stop() waits on it)
      void publishProgress(channel, {
        status: 'RUNNING',
        stage,
        bytesRead: bytes,
        totalBytes: total,
        stageStartedAt: stageStartedAt.toISOString(),
        at: now.toISOString(),
      }).catch((err) => logger.warn(`Restore ${restoreId} progress publish failed:`, err));
    } catch (err) {
      // Progress is best effort: it must never fail the restore itself
      logger.warn(`Restore ${restoreId} progress update failed:`, err);
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
    setStage(next: RestoreStage, totalBytes: number | null) {
      stage = next;
      total = totalBytes !== null && totalBytes > 0 ? totalBytes : null;
      bytes = 0;
      stageStartedAt = new Date();
      void flush();
    },
    setBytes(n: number) {
      bytes = n;
    },
    async stop() {
      clearInterval(timer);
      await inflight;
      stopped = true;
    },
  };
}
