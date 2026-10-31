import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { notify } from './notification.service';
import { logAudit } from './audit.service';

/**
 * Missed-backup watchdog (the healthchecks.io "dead-man switch" pattern):
 * if a connection expects a completed backup every N hours and the newest
 * completed backup is older than that, alert — once on entering the stale
 * state and at most daily while it stays stale. Runs off the heartbeat
 * worker's tick, throttled to hourly.
 */

const RE_ALERT_MS = 24 * 60 * 60 * 1000;
const CHECK_THROTTLE_MS = 60 * 60 * 1000;

let lastCheckAt = 0;
const lastAlertAt = new Map<string, number>(); // connectionId → ts

export async function runBackupWatchdog(userId: string): Promise<void> {
  const now = Date.now();
  if (now - lastCheckAt < CHECK_THROTTLE_MS) return;
  lastCheckAt = now;

  const conns = await prisma.connection.findMany({
    where: { expectedBackupHours: { not: null }, userId },
    select: { id: true, name: true, expectedBackupHours: true, createdAt: true },
  });

  for (const conn of conns) {
    const hours = conn.expectedBackupHours;
    if (!hours || hours <= 0) continue;

    const lastCompleted = await prisma.backup.findFirst({
      where: { connectionId: conn.id, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, fileName: true },
    });

    // Stale = newest completed backup (or the connection itself) older than the window
    const reference = lastCompleted?.createdAt ?? conn.createdAt;
    const ageHours = (now - new Date(reference).getTime()) / 3_600_000;

    if (ageHours <= hours) {
      lastAlertAt.delete(conn.id);
      continue;
    }

    if (now - (lastAlertAt.get(conn.id) ?? 0) < RE_ALERT_MS) continue;
    lastAlertAt.set(conn.id, now);

    const last = lastCompleted
      ? `last successful backup was ${Math.floor(ageHours)}h ago (${lastCompleted.fileName})`
      : 'this connection has NO completed backup yet';

    await logAudit(userId, 'BACKUP_STALE', 'connection', {
      connectionId: conn.id, name: conn.name, ageHours: Math.round(ageHours), expectedHours: hours,
    });
    void notify(userId, {
      event: 'BACKUP_STALE',
      title: '⏰ Missed Backup Alert',
      message: `Connection "${conn.name}" expected a backup every ${hours}h — ${last}.`,
      details: { Connection: conn.name, Expected: `every ${hours}h`, 'Last backup': lastCompleted ? `${Math.floor(ageHours)}h ago` : 'never' },
    }).catch(() => undefined);

    logger.warn(`⏰  Watchdog: ${conn.name} stale (${Math.floor(ageHours)}h > ${hours}h)`);
  }
}
