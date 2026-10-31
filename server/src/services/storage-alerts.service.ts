import fs from 'fs';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { notify } from './notification.service';
import { logAudit } from './audit.service';
import { getStoragePath } from './storage.service';
import { getGdriveAccessToken } from './gdrive.service';

/**
 * Storage threshold alerts — local backup disk, Google Drive quota and
 * (optional) S3 budget. Runs off the heartbeat worker's tick, throttled to
 * once per hour; alerts on crossing the threshold and re-alerts daily while
 * it stays above.
 */

export interface UsageInfo {
  usedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
}

const THRESHOLD = Math.min(100, Math.max(1, parseInt(process.env.STORAGE_ALERT_THRESHOLD_PERCENT ?? '80', 10) || 80));
const RE_ALERT_MS = 24 * 60 * 60 * 1000;
const CHECK_THROTTLE_MS = 60 * 60 * 1000;

let lastCheckAt = 0;
const lastAlertAt = new Map<string, number>(); // provider key → timestamp

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Local backup disk usage (fs.statfs; df fallback for old Node). */
export async function measureLocalUsage(): Promise<UsageInfo | null> {
  const dir = getStoragePath();
  try {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bsize: number; blocks: number; bavail: number } }).statfsSync;
    if (typeof statfs === 'function') {
      const s = statfs(dir);
      const total = s.bsize * s.blocks;
      const available = s.bsize * s.bavail;
      if (total <= 0) return null;
      return { usedBytes: total - available, totalBytes: total, percent: ((total - available) / total) * 100 };
    }
  } catch {
    /* fall through to df */
  }
  try {
    const { execFileSync } = await import('child_process');
    const out = execFileSync('df', ['-k', dir]).toString();
    const parts = out.trim().split('\n')[1].split(/\s+/);
    const total = Number(parts[1]) * 1024;
    const available = Number(parts[3]) * 1024;
    if (!Number.isFinite(total) || total <= 0) return null;
    return { usedBytes: total - available, totalBytes: total, percent: ((total - available) / total) * 100 };
  } catch {
    return null;
  }
}

/** Google Drive account quota (absent limit = unlimited Workspace plan). */
export async function measureGdriveUsage(userId: string): Promise<UsageInfo | null> {
  try {
    const token = await getGdriveAccessToken(userId);
    const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota(limit,usage)', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const { storageQuota } = (await res.json()) as { storageQuota?: { limit?: string; usage?: string } };
    if (!storageQuota?.usage) return null;
    const used = Number(storageQuota.usage);
    const total = storageQuota.limit ? Number(storageQuota.limit) : null;
    return { usedBytes: used, totalBytes: total, percent: total ? (used / total) * 100 : null };
  } catch {
    return null; // Drive not configured
  }
}

/** S3 has no quota — compare stored backup bytes against a user-set budget. */
export async function measureS3Usage(): Promise<UsageInfo | null> {
  const budgetGb = parseFloat(process.env.S3_STORAGE_BUDGET_GB ?? '0');
  if (!Number.isFinite(budgetGb) || budgetGb <= 0) return null;

  const agg = await prisma.backup.aggregate({
    where: { storageType: 'S3', status: 'COMPLETED' },
    _sum: { fileSize: true },
  });
  const used = Number(agg._sum.fileSize ?? 0);
  const total = Math.round(budgetGb * 1024 ** 3);
  return { usedBytes: used, totalBytes: total, percent: (used / total) * 100 };
}

/** All usages for one user (also powers GET /api/storage/usage). */
export async function getStorageUsage(userId: string): Promise<{
  thresholdPercent: number;
  local: UsageInfo | null;
  gdrive: UsageInfo | null;
  s3: UsageInfo | null;
}> {
  const [local, gdrive, s3] = await Promise.all([
    measureLocalUsage(),
    measureGdriveUsage(userId),
    measureS3Usage(),
  ]);
  return { thresholdPercent: THRESHOLD, local, gdrive, s3 };
}

async function alertIfOver(
  userId: string,
  key: string,
  label: string,
  usage: UsageInfo | null,
): Promise<boolean> {
  if (!usage?.percent || usage.percent < THRESHOLD) {
    lastAlertAt.delete(key);
    return false;
  }

  const now = Date.now();
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < RE_ALERT_MS) return false; // already alerted within 24h
  lastAlertAt.set(key, now);

  const totalStr = usage.totalBytes ? ` of ${gb(usage.totalBytes)}` : '';
  const message = `${label} is ${usage.percent.toFixed(0)}% full — ${usage.usedBytes != null ? gb(usage.usedBytes) : '?'} used${totalStr}`;
  await logAudit(userId, 'STORAGE_THRESHOLD', 'storage_settings', {
    provider: key, percent: Math.round(usage.percent), usedBytes: usage.usedBytes, totalBytes: usage.totalBytes,
  });
  void notify(userId, {
    event: 'STORAGE_THRESHOLD',
    title: '⚠️ Storage Almost Full',
    message,
    details: {
      Provider: label,
      Used: usage.usedBytes != null ? gb(usage.usedBytes) : '?',
      Total: usage.totalBytes ? gb(usage.totalBytes) : 'unknown',
      Percent: `${usage.percent.toFixed(0)}%`,
      Threshold: `${THRESHOLD}%`,
    },
  }).catch(() => undefined);

  logger.warn(`📉 ${message} (threshold ${THRESHOLD}%)`);
  return true;
}

/** Periodic check — called from the heartbeat worker, throttled to hourly. */
export async function runStorageChecks(userId: string): Promise<void> {
  const now = Date.now();
  if (now - lastCheckAt < CHECK_THROTTLE_MS) return;
  lastCheckAt = now;

  const [local, gdrive, s3] = await Promise.all([
    measureLocalUsage(),
    measureGdriveUsage(userId),
    measureS3Usage(),
  ]);

  await alertIfOver(userId, 'local', 'Local backup disk', local);
  await alertIfOver(userId, 'gdrive', 'Google Drive', gdrive);
  await alertIfOver(userId, 's3', 'S3 backups budget', s3);
}
