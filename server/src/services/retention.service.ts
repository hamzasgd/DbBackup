import fs from 'fs';
import path from 'path';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { notify } from './notification.service';

export interface RetentionResult {
  connectionId: string;
  deleted: number;
  freedBytes: bigint;
}

function deleteBackupFile(filePath: string): void {
  if (!filePath || filePath === 'pending') return;
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      fs.rmSync(filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    logger.debug('Failed to delete backup file:', err);
  }
}

/**
 * Enforce retention for a single connection based on its schedule settings.
 * Deletes backups older than `retentionDays` AND/OR keeps only the last `retentionCount`.
 */
export async function enforceRetentionForConnection(
  connectionId: string,
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
      select: { id: true, filePath: true, fileSize: true },
    });
    old.forEach((b: { id: string; filePath: string; fileSize: bigint }) => toDelete.add(b.id));
  }

  // Rule 2: keep only last N
  if (retentionCount && retentionCount > 0) {
    const all = await prisma.backup.findMany({
      where: { connectionId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, filePath: true, fileSize: true },
    });
    all.slice(retentionCount).forEach((b: { id: string; filePath: string; fileSize: bigint }) => toDelete.add(b.id));
  }

  if (toDelete.size === 0) {
    return { connectionId, deleted: 0, freedBytes: 0n };
  }

  const records = await prisma.backup.findMany({
    where: { id: { in: [...toDelete] } },
    select: { id: true, filePath: true, fileSize: true },
  });

  let freedBytes = 0n;
  for (const r of records) {
    deleteBackupFile(r.filePath);
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
        'Connection ID': connectionId,
      },
    });
  }

  return { connectionId, deleted: toDelete.size, freedBytes };
}

/**
 * Run retention across ALL connections for a given user (daily sweep).
 */
export async function runGlobalRetentionSweep(userId: string): Promise<RetentionResult[]> {
  const schedules = await prisma.schedule.findMany({
    where: { connection: { userId } },
    select: {
      connectionId: true,
      retentionDays: true,
      retentionCount: true,
    },
  });

  const results: RetentionResult[] = [];
  for (const s of schedules) {
    const result = await enforceRetentionForConnection(
      s.connectionId,
      s.retentionDays,
      s.retentionCount,
      userId,
    );
    results.push(result);
  }
  return results;
}
