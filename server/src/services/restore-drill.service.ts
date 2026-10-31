import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { logger } from '../config/logger';
import { notify } from './notification.service';
import { logAudit } from './audit.service';
import { decrypt, decryptIfPresent } from './crypto.service';
import { engineFactory } from './engines/engine.factory';
import { ConnectionConfig } from './engines/base.engine';
import { ensureLocalBackupFile, cleanupTempFile } from './storage.service';

/**
 * Restore drill — the backup community's #1 gap: untested restores.
 * Restores a backup into a THROWAWAY scratch database on the same server,
 * counts tables/rows, drops the scratch database and records the outcome.
 * A backup that passed a drill is proven restorable, not just archived.
 *
 * Runs as a background async job (status tracked in RestoreDrill rows).
 */

export async function startRestoreDrill(userId: string, backupId: string): Promise<string> {
  const backup = await prisma.backup.findFirst({ where: { id: backupId, userId } });
  if (!backup) throw new Error('Backup not found');
  if (backup.status !== 'COMPLETED') throw new Error('Only completed backups can be drilled');
  if (backup.dbType !== 'MYSQL' && backup.dbType !== 'MARIADB' && backup.dbType !== 'POSTGRESQL') {
    throw new Error('Restore drills currently support MySQL/MariaDB/PostgreSQL backups');
  }

  // One running drill per backup at a time
  const running = await prisma.restoreDrill.findFirst({ where: { backupId, status: 'RUNNING' } });
  if (running) throw new Error('A drill is already running for this backup');

  const drill = await prisma.restoreDrill.create({
    data: { id: uuidv4(), userId, backupId, status: 'RUNNING' },
  });

  // Fire-and-forget: single-process app, status tracked in DB
  void runDrill(drill.id, userId, backupId).catch((err) =>
    logger.error('Restore drill crashed:', err),
  );
  return drill.id;
}

async function runDrill(drillId: string, userId: string, backupId: string): Promise<void> {
  const scratchDb = `dbbackup_drill_${Date.now().toString(36)}`;
  let tempPath: string | null = null;

  try {
    const backup = (await prisma.backup.findUnique({ where: { id: backupId } }))!;
    if (!backup.connectionId) throw new Error('This backup has no source connection (connection was deleted) — drills need a live connection');
    const conn = await prisma.connection.findUnique({ where: { id: backup.connectionId } });
    if (!conn) throw new Error('Source connection no longer exists');

    const config: ConnectionConfig = {
      type: conn.type as ConnectionConfig['type'],
      host: decrypt(conn.host),
      port: conn.port,
      username: decrypt(conn.username),
      password: conn.password ? decrypt(conn.password) : undefined,
      database: decrypt(conn.database),
      sslEnabled: conn.sslEnabled,
      sshEnabled: conn.sshEnabled,
      sshHost: decryptIfPresent(conn.sshHost) || undefined,
      sshPort: conn.sshPort || 22,
      sshUsername: decryptIfPresent(conn.sshUsername) || undefined,
      sshPrivateKey: decryptIfPresent(conn.sshPrivateKey) || undefined,
      sshPrivateKeyPath: conn.sshPrivateKeyPath ?? undefined,
      sshPassphrase: decryptIfPresent(conn.sshPassphrase) || undefined,
    };
    const engine = engineFactory(config);

    // 1. Resolve a local plaintext copy (downloads from S3/Drive, decrypts .enc)
    const { localPath, downloaded } = await ensureLocalBackupFile(userId, {
      filePath: backup.filePath,
      fileName: backup.fileName,
      storageType: backup.storageType,
      storageKey: backup.storageKey,
    });
    tempPath = downloaded ? localPath : null;

    // 2. Scratch database, restore into it, count, drop
    await engine.createDatabase(scratchDb);
    let tables = 0;
    let rows = 0n;
    try {
      await engine.restore(localPath, scratchDb);
      const counts = await engine.countAllTables(scratchDb);
      tables = counts.tables;
      rows = counts.rows;
    } finally {
      await engine.dropDatabase(scratchDb).catch((err) =>
        logger.warn(`Drill cleanup: failed to drop ${scratchDb}:`, err),
      );
    }

    await prisma.restoreDrill.update({
      where: { id: drillId },
      data: { status: 'PASSED', tablesRestored: tables, rowsRestored: rows, finishedAt: new Date() },
    });
    await logAudit(userId, 'DRILL_PASSED', 'backup', { backupId, tables, rows: Number(rows) });
    logger.info(`🧪  Restore drill PASSED for ${backup.fileName}: ${tables} tables, ${Number(rows)} rows`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.restoreDrill.update({
      where: { id: drillId },
      data: { status: 'FAILED', error: message.slice(0, 500), finishedAt: new Date() },
    }).catch(() => undefined);
    await logAudit(userId, 'DRILL_FAILED', 'backup', { backupId, error: message.slice(0, 200) }).catch(() => undefined);
    void notify(userId, {
      event: 'DRILL_FAILED',
      title: '🧪 Restore Drill FAILED',
      message: `A backup failed its automated restore test: ${message.slice(0, 200)}`,
      details: { Backup: backupId.slice(0, 8), Error: message.slice(0, 200) },
    }).catch(() => undefined);
    logger.error(`🧪  Restore drill FAILED: ${message}`);
  } finally {
    if (tempPath) cleanupTempFile(tempPath);
  }
}

/**
 * Cancel a stuck RUNNING drill (e.g. after a server crash/restart).
 */
export async function cancelStaleDrill(userId: string, drillId: string): Promise<void> {
  const drill = await prisma.restoreDrill.findFirst({ where: { id: drillId, userId } });
  if (!drill) throw new Error('Drill not found');
  if (drill.status !== 'RUNNING') throw new Error('Only RUNNING drills can be cancelled');
  await prisma.restoreDrill.update({
    where: { id: drillId },
    data: { status: 'FAILED', error: 'Cancelled by user', finishedAt: new Date() },
  });
}

/**
 * Boot cleanup: if the server crashed/restart mid-drill, RUNNING rows are
 * orphaned forever. Mark anything still RUNNING from a previous process
 * as FAILED so the UI doesn't hang on 'Drilling…'.
 */
export async function cleanupOrphanedDrills(): Promise<void> {
  const result = await prisma.restoreDrill.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'FAILED', error: 'Interrupted by server restart', finishedAt: new Date() },
  });
  if (result.count > 0) {
    logger.info(`🧪  Cleaned up ${result.count} orphaned drill(s) from a previous run`);
  }
}
