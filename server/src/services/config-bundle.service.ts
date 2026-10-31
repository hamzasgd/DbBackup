import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { logAudit } from './audit.service';
import { notify } from './notification.service';
import crypto from 'crypto';

/**
 * Config bundle — "backup DbBackup itself". Exports ALL connections,
 * schedules, notification settings and storage settings as a single
 * encrypted JSON file. On a fresh server, import restores everything
 * in one step (encrypted with the backup passphrase so it's safe to
 * store anywhere, including S3/Drive).
 *
 * Format: [magic "DBBUNDLE"][salt 16][iv 12][ciphertext][GCM tag 16]
 */

const MAGIC = Buffer.from('DBBUNDLE', 'ascii');

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export async function exportBundle(userId: string, passphrase: string): Promise<Buffer> {
  // Gather everything
  const [connections, schedules, notifSettings, storageSettings, mcpKeys] = await Promise.all([
    prisma.connection.findMany({ where: { userId } }),
    prisma.schedule.findMany({ where: { connection: { userId } } }),
    prisma.notificationSettings.findUnique({ where: { userId } }),
    prisma.storageSettings.findUnique({ where: { userId } }),
    prisma.mcpApiKey.findMany({ where: { userId, revokedAt: null } }),
  ]);

  // Strip fields that shouldn't be in the bundle
  const cleanConnections = connections.map((c) => { const { id: _i, userId: _u, createdAt: _c, updatedAt: _up, ...rest } = c as Record<string, unknown>; return rest; });
  const cleanSchedules = schedules.map((s) => { const { id: _i, connectionId, createdAt: _c, updatedAt: _up, lastRunAt: _l, nextRunAt: _n, ...rest } = s as Record<string, unknown>; return { ...rest, _originalConnectionId: connectionId }; });
  const cleanNotif = notifSettings ? Object.fromEntries(Object.entries(notifSettings).filter(([k]) => !['id', 'userId', 'createdAt', 'updatedAt'].includes(k))) : null;
  const cleanStorage = storageSettings ? Object.fromEntries(Object.entries(storageSettings).filter(([k]) => !['id', 'userId', 'createdAt', 'updatedAt'].includes(k))) : null;
  const cleanMcpKeys = mcpKeys.map(({ id, userId: _u, keyHash, keyPrefix, createdAt, lastUsedAt, ...rest }) => ({ ...rest, _note: 'keyHash not exportable — recreate keys manually' }));

  const bundle = {
    version: 1,
    exportedAt: new Date().toISOString(),
    connections: cleanConnections,
    schedules: cleanSchedules,
    notificationSettings: cleanNotif,
    storageSettings: cleanStorage,
    mcpKeys: cleanMcpKeys,
  };

  // Encrypt
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(bundle, null, 2);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const result = Buffer.concat([MAGIC, salt, iv, encrypted, tag]);
  await logAudit(userId, 'BUNDLE_EXPORT', 'settings', { connections: cleanConnections.length, schedules: cleanSchedules.length }, undefined);
  logger.info(`📦  Config bundle exported: ${cleanConnections.length} connections, ${cleanSchedules.length} schedules (${result.length} bytes encrypted)`);

  return result;
}

export async function importBundle(userId: string, data: Buffer, passphrase: string): Promise<{ connections: number; schedules: number }> {
  // Parse and decrypt
  if (data.length < MAGIC.length + 16 + 12 + 16) throw new Error('File too small to be a config bundle');
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a DbBackup config bundle');

  const salt = data.subarray(MAGIC.length, MAGIC.length + 16);
  const iv = data.subarray(MAGIC.length + 16, MAGIC.length + 28);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(MAGIC.length + 28, data.length - 16);

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');

  const bundle = JSON.parse(plaintext) as {
    connections: Array<Record<string, unknown>>;
    schedules: Array<Record<string, unknown> & { _originalConnectionId?: string }>;
    notificationSettings?: Record<string, unknown>;
    storageSettings?: Record<string, unknown>;
  };

  // Import connections (create new, map old IDs to new)
  const idMap = new Map<string, string>();
  let connCount = 0;
  for (const conn of bundle.connections ?? []) {
    const newId = uuidv4();
    const oldId = String(conn.id ?? '');
    if (oldId) idMap.set(oldId, newId);
    await prisma.connection.create({
      data: {
        id: newId,
        userId,
        name: String(conn.name ?? 'imported'),
        type: String(conn.type ?? 'MYSQL') as never,
        host: String(conn.host ?? ''),
        port: Number(conn.port ?? 3306),
        username: String(conn.username ?? ''),
        password: String(conn.password ?? ''),
        database: String(conn.database ?? ''),
        sslEnabled: Boolean(conn.sslEnabled),
        sshEnabled: Boolean(conn.sshEnabled),
        heartbeatEnabled: Boolean(conn.heartbeatEnabled),
        expectedBackupHours: conn.expectedBackupHours ? Number(conn.expectedBackupHours) : null,
        ...Object.fromEntries(Object.entries(conn).filter(([k]) => !['id', 'userId', 'createdAt', 'updatedAt', 'heartbeats', 'type'].includes(k))),
      },
    });
    connCount++;
  }

  // Import schedules (remap connectionId)
  let schedCount = 0;
  for (const sched of bundle.schedules ?? []) {
    const mappedConnId = sched._originalConnectionId ? idMap.get(sched._originalConnectionId) : null;
    if (!mappedConnId) continue; // schedule references a connection that wasn't imported
    await prisma.schedule.create({
      data: {
        id: uuidv4(),
        connectionId: mappedConnId,
        name: String(sched.name ?? 'imported'),
        frequency: String(sched.frequency ?? 'DAILY') as never,
        cronExpression: String(sched.cronExpression ?? '0 3 * * *'),
        isActive: Boolean(sched.isActive ?? true),
        retentionDays: Number(sched.retentionDays ?? 30),
        retentionCount: sched.retentionCount ? Number(sched.retentionCount) : null,
        ...Object.fromEntries(Object.entries(sched).filter(([k]) => !['id', 'userId', 'connectionId', 'createdAt', 'updatedAt', 'lastRunAt', 'nextRunAt', '_originalConnectionId', 'frequency'].includes(k))),
      },
    });
    schedCount++;
  }

  // Import notification settings
  if (bundle.notificationSettings) {
    const ns = bundle.notificationSettings;
    await prisma.notificationSettings.upsert({
      where: { userId },
      create: { userId, ...ns } as never,
      update: ns as never,
    });
  }

  await logAudit(userId, 'BUNDLE_IMPORT', 'settings', { connections: connCount, schedules: schedCount });
  logger.info(`📦  Config bundle imported: ${connCount} connections, ${schedCount} schedules`);

  void notify;
  return { connections: connCount, schedules: schedCount };
}
