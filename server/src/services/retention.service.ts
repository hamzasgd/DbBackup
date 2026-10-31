import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { notify } from './notification.service';
import { deleteBackupArtifact } from './storage.service';

export interface RetentionResult {
  connectionId: string | null;
  deleted: number;
  freedBytes: bigint;
}

/**
 * Enforce retention for a single connection based on its schedule settings.
 * Deletes backups older than `retentionDays` AND/OR keeps only the last `retentionCount`.
 * `connectionId: null` targets backups detached from deleted connections (env default policy).
 */
export async function enforceRetentionForConnection(
  connectionId: string | null,
  retentionDays: number,
  retentionCount: number | null,
  userId: string,
): Promise<RetentionResult> {
  const toDelete = new Set<string>();

  // Rule 1: by age
  if (retentionDays > 0) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const old = await prisma.backup.findMany({
      where: {
        connectionId,
        status: 'COMPLETED',
        createdAt: { lt: cutoff },
      },
      select: { id: true },
    });
    old.forEach((b: { id: string }) => toDelete.add(b.id));
  }

  // Rule 2: keep only last N
  if (retentionCount && retentionCount > 0) {
    const all = await prisma.backup.findMany({
      where: { connectionId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    all.slice(retentionCount).forEach((b: { id: string }) => toDelete.add(b.id));
  }

  if (toDelete.size === 0) {
    return { connectionId, deleted: 0, freedBytes: 0n };
  }

  const records = await prisma.backup.findMany({
    where: { id: { in: [...toDelete] } },
    select: { id: true, filePath: true, fileSize: true, storageType: true, storageKey: true },
  });

  let freedBytes = 0n;
  for (const r of records) {
    // Deletes the S3 object (if any) AND the local file
    await deleteBackupArtifact(userId, r).catch((err) =>
      logger.warn(`Artifact cleanup failed for backup ${r.id}:`, err),
    );
    freedBytes += BigInt(r.fileSize);
  }

  await prisma.backup.deleteMany({ where: { id: { in: [...toDelete] } } });

  logger.info(
    `🗑️  Retention: deleted ${toDelete.size} backup(s) for connection ${connectionId}`,
  );

  // Notify if any were deleted
  if (toDelete.size > 0 && userId) {
    const freedMB = Number(freedBytes / 1_048_576n);
    void notify(userId, {
      event: 'RETENTION_CLEANUP',
      title: 'Retention Policy Applied',
      message: `Auto-deleted ${toDelete.size} old backup(s) to enforce retention policy.`,
      details: {
        'Backups Deleted': toDelete.size,
        'Space Freed': `${freedMB} MB`,
        'Connection ID': connectionId ?? 'no connection (deleted)',
      },
    });
  }

  return { connectionId, deleted: toDelete.size, freedBytes };
}

/**
 * Fallback policy for connections without any schedule.
 * Configurable via DEFAULT_RETENTION_DAYS / DEFAULT_RETENTION_COUNT (0 or unset = rule disabled).
 */
function envDefaultRetention(): { retentionDays: number; retentionCount: number | null } {
  const days = parseInt(process.env.DEFAULT_RETENTION_DAYS ?? '30', 10);
  const count = parseInt(process.env.DEFAULT_RETENTION_COUNT ?? '0', 10);
  return {
    retentionDays: Number.isFinite(days) && days > 0 ? days : 0,
    retentionCount: Number.isFinite(count) && count > 0 ? count : null,
  };
}

/**
 * Effective retention policy for a connection.
 * When multiple schedules exist, the strictest rule of each kind wins
 * (smallest retentionDays / smallest retentionCount) so no schedule's
 * policy is silently ignored.
 */
export async function getRetentionPolicy(
  connectionId: string | null,
): Promise<{ retentionDays: number; retentionCount: number | null }> {
  // Detached backups (connection deleted) fall back to the env default policy
  if (!connectionId) return envDefaultRetention();

  const schedules = await prisma.schedule.findMany({
    where: { connectionId },
    select: { retentionDays: true, retentionCount: true },
  });

  if (schedules.length === 0) {
    return envDefaultRetention();
  }

  const days = schedules.map((s) => s.retentionDays).filter((d) => d > 0);
  const counts = schedules
    .map((s) => s.retentionCount)
    .filter((c): c is number => typeof c === 'number' && c > 0);

  return {
    retentionDays: days.length ? Math.min(...days) : 0,
    retentionCount: counts.length ? Math.min(...counts) : null,
  };
}

/**
 * Run retention across ALL connections that have completed backups (daily sweep).
 * Covers scheduled connections (schedule policy) and manual-only connections (env defaults).
 */
export async function runGlobalRetentionSweep(userId?: string): Promise<RetentionResult[]> {
  // Group by connectionId; NULL connectionId (backups kept after their
  // connection was deleted) forms one group governed by the env default policy.
  const connections = await prisma.backup.findMany({
    where: { status: 'COMPLETED', ...(userId ? { userId } : {}) },
    select: { connectionId: true, userId: true },
    distinct: ['connectionId'],
  });

  const results: RetentionResult[] = [];
  for (const { connectionId, userId: ownerId } of connections) {
    const policy = await getRetentionPolicy(connectionId);
    if (policy.retentionDays <= 0 && !policy.retentionCount) continue;
    try {
      const result = await enforceRetentionForConnection(
        connectionId,
        policy.retentionDays,
        policy.retentionCount,
        ownerId,
      );
      if (result.deleted > 0) {
        const { logAudit } = await import('./audit.service');
        await logAudit(ownerId, 'RETENTION_SWEEP', 'backup', {
          connectionId: connectionId ?? null,
          deleted: result.deleted,
          freedBytes: Number(result.freedBytes),
        });
      }
      results.push(result);
    } catch (err) {
      logger.warn(`Retention sweep failed for connection ${connectionId ?? 'detached'}:`, err);
    }
  }
  return results;
}
