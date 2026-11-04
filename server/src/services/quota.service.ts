import { prisma } from '../config/database';

/** Per-user storage quota. Usage = sum of COMPLETED backup fileSize (all
 * providers). Quota lives on User.storageQuotaBytes (BigInt, bytes);
 * null = unlimited. */

const BYTES_PER_GB = 1024 * 1024 * 1024;

export interface QuotaUsage {
  usedBytes: bigint;
  quotaBytes: bigint | null;
  /** 0-100 (rounded); null when the user has no quota (unlimited). */
  percent: number | null;
}

export async function getQuotaUsage(userId: string): Promise<QuotaUsage> {
  const [sum, user] = await Promise.all([
    prisma.backup.aggregate({
      where: { userId, status: 'COMPLETED' },
      _sum: { fileSize: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { storageQuotaBytes: true },
    }),
  ]);
  const usedBytes = sum._sum.fileSize ?? BigInt(0);
  const quotaBytes = user?.storageQuotaBytes ?? null;
  const percent = quotaBytes && quotaBytes > BigInt(0)
    ? Math.round(Number(usedBytes * BigInt(100)) / Number(quotaBytes))
    : null;
  return { usedBytes, quotaBytes, percent };
}

/** Formats bytes as a human string without pulling in client helpers. */
function fmtBytes(n: bigint | number): string {
  const v = Number(n);
  if (v >= BYTES_PER_GB) return `${(v / BYTES_PER_GB).toFixed(2)} GB`;
  if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

/** Verdict for admitting one new backup file. Callers: triggerBackup (pre-check
 * with fileSize 0 = "already over?") and the backup worker (real dump size). */
export async function assertQuotaAllowsFile(
  userId: string,
  fileSize: bigint | number
): Promise<{ ok: true } | { ok: false; message: string }> {
  const incoming = typeof fileSize === 'bigint' ? fileSize : BigInt(Math.max(0, Math.round(fileSize)));
  const { usedBytes, quotaBytes } = await getQuotaUsage(userId);
  if (quotaBytes === null) return { ok: true };
  const newUsed = usedBytes + incoming;
  if (newUsed <= quotaBytes) return { ok: true };
  const message =
    `Storage quota exceeded: this backup needs ${fmtBytes(incoming)}, ` +
    `you are using ${fmtBytes(usedBytes)} of your ${fmtBytes(quotaBytes)} quota. ` +
    `Delete old backups or ask the administrator for more space.`;
  return { ok: false, message };
}
