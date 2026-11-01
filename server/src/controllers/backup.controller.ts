import { Response, NextFunction } from 'express';
import { randomUUID as uuidv4 } from 'crypto';
import path from 'path';
import fs from 'fs';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { decrypt } from '../services/crypto.service';
import { addBackupJob } from '../queue/backup.queue';
import { verifyBackup } from '../services/verification.service';
import { streamFromS3, deleteBackupArtifact, ensureLocalBackupFile, cleanupTempFile, ensureStorageDir, getStoragePath } from '../services/storage.service';
import { streamFromGdrive } from '../services/gdrive.service';
import { logAudit } from '../services/audit.service';
import { runGlobalRetentionSweep } from '../services/retention.service';
import { startRestoreDrill, cancelStaleDrill } from '../services/restore-drill.service';

const STORAGE_PATH = getStoragePath();
ensureStorageDir(STORAGE_PATH);

export async function getBackups(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { connectionId, page = '1', limit = '20' } = req.query as Record<string, string>;
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;

    const where = {
      userId: req.user!.userId,
      ...(connectionId ? { connectionId } : {}),
    };

    const [backups, total] = await Promise.all([
      prisma.backup.findMany({
        where,
        include: {
          connection: { select: { id: true, name: true, type: true } },
          drills: { take: 1, orderBy: { startedAt: 'desc' } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parsedLimit,
      }),
      prisma.backup.count({ where }),
    ]);

    // Strip server-internal fields — the client never needs the filesystem
    // path or the S3/Drive object key; operations go through backup IDs.
    const withDrill = backups.map(({ drills, filePath: _fp, storageKey: _sk, ...b }) => ({
      ...b,
      lastDrill: drills?.[0] ?? null,
    }));

    res.json({ success: true, data: { backups: withDrill, total, page: parsedPage, limit: parsedLimit } });
  } catch (err) { next(err); }
}

export async function triggerBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { connectionId, snapshotName, notes, format } = req.body;

    const conn = await prisma.connection.findFirst({
      where: { id: connectionId, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Connection not found', 404);

    // Ensure storage dir exists (owner-only permissions)
    ensureStorageDir(STORAGE_PATH);

    // Resolve and validate format
    const defaultFormat = conn.type === 'POSTGRESQL' ? 'CUSTOM' : 'COMPRESSED_SQL';
    const resolvedFormat = format ?? defaultFormat;

    const backup = await prisma.backup.create({
      data: {
        id: uuidv4(),
        userId: req.user!.userId,
        connectionId,
        fileName: 'pending',
        filePath: 'pending',
        dbType: conn.type,
        dbName: decrypt(conn.database),
        status: 'PENDING',
        format: resolvedFormat,
        snapshotName,
        notes,
        startedAt: new Date(),
      },
    });

    // Queue the job (only pass connectionId, decrypt at execution time)
    await addBackupJob({
      backupId: backup.id,
      connectionId,
      outputDir: STORAGE_PATH,
      format: resolvedFormat,
    });

    await logAudit(req.user!.userId, 'TRIGGER', 'backup', { backupId: backup.id, connectionId }, req.ip);

    res.status(202).json({ success: true, data: backup, message: 'Backup job queued' });
  } catch (err) { next(err); }
}

export async function getBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { filePath: _fp, storageKey: _sk, ...backup } = await prisma.backup.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: { connection: { select: { id: true, name: true, type: true } } },
    }) ?? {};
    if (!backup) throw new AppError('Backup not found', 404);
    res.json({ success: true, data: backup });
  } catch (err) { next(err); }
}

export async function deleteBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!backup) throw new AppError('Backup not found', 404);

    // Delete S3 object (if any) and local file/directory
    await deleteBackupArtifact(req.user!.userId, backup);

    await prisma.backup.delete({ where: { id: backup.id } });
    await logAudit(req.user!.userId, 'DELETE', 'backup', { backupId: backup.id, fileName: backup.fileName, storageType: backup.storageType }, req.ip, req.headers['user-agent']);
    res.json({ success: true, message: 'Backup deleted' });
  } catch (err) { next(err); }
}

export async function downloadBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!backup) throw new AppError('Backup not found', 404);

    await logAudit(req.user!.userId, 'DOWNLOAD', 'backup', { backupId: backup.id, fileName: backup.fileName, storageType: backup.storageType }, req.ip, req.headers['user-agent']);

    // S3-stored backup — stream from S3
    if (backup.storageType === 'S3' && backup.storageKey) {
      const stream = await streamFromS3(req.user!.userId, backup.storageKey);
      res.setHeader('Content-Disposition', `attachment; filename="${backup.fileName.replace(/\.enc$/, '')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      stream.pipe(res);
      return;
    }

    // Google Drive-stored backup — stream from Drive
    if (backup.storageType === 'GOOGLE_DRIVE' && backup.storageKey) {
      const stream = await streamFromGdrive(req.user!.userId, backup.storageKey);
      res.setHeader('Content-Disposition', `attachment; filename="${backup.fileName.replace(/\.enc$/, '')}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      stream.pipe(res);
      return;
    }

    // Local backup
    if (!fs.existsSync(backup.filePath)) throw new AppError('Backup file not found on disk', 404);
    res.download(backup.filePath, backup.fileName.replace(/\.enc$/, ''));
  } catch (err) { next(err); }
}

export async function verifyBackupEndpoint(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!backup) throw new AppError('Backup not found', 404);
    if (backup.status !== 'COMPLETED') throw new AppError('Only completed backups can be verified', 400);

    // Works for local backups and S3 backups whose local copy was deleted
    // (downloads to a temp file first)
    const { localPath, downloaded } = await ensureLocalBackupFile(req.user!.userId, backup);
    try {
      const result = await verifyBackup(localPath, backup.dbType, backup.format);

      await prisma.backup.update({
        where: { id: backup.id },
        data: {
          verified: result.valid,
          verifiedAt: new Date(),
          checksum: result.checksum || null,
        },
      });

      await logAudit(req.user!.userId, 'VERIFY', 'backup', { backupId: backup.id, fileName: backup.fileName, valid: result.valid }, req.ip, req.headers['user-agent']);

      res.json({ success: true, data: result });
    } finally {
      if (downloaded) cleanupTempFile(localPath);
    }
  } catch (err) { next(err); }
}

/**
 * Manually enforce retention policies now (all of the user's connections).
 * Same logic as the daily sweep — exposed so users can purge on demand.
 */
export async function runRetention(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const results = await runGlobalRetentionSweep(req.user!.userId);
    const deleted = results.reduce((n, r) => n + r.deleted, 0);
    const freedBytes = Number(results.reduce((n, r) => n + r.freedBytes, 0n));

    await logAudit(req.user!.userId, 'DELETE', 'backup', { action: 'retention-purge', deleted, freedBytes }, req.ip);

    res.json({ success: true, data: { deleted, freedBytes, connections: results.length } });
  } catch (err) { next(err); }
}

/**
 * Kick off a restore drill: restores this backup into a throwaway scratch
 * database on its source server, counts tables/rows, drops the scratch db.
 * Async — poll the backup list (lastDrill) for the result.
 */
export async function drillBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const drillId = await startRestoreDrill(req.user!.userId, req.params.id);
    await logAudit(req.user!.userId, 'DRILL_START', 'backup', { backupId: req.params.id, drillId }, req.ip, req.headers['user-agent']);
    res.status(202).json({ success: true, data: { drillId }, message: 'Restore drill started — the backup will be restored into a scratch database and cleaned up' });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err instanceof Error ? err.message : 'Drill failed to start', 400));
  }
}

export async function cancelDrill(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { drillId } = req.body as { drillId: string };
    await cancelStaleDrill(req.user!.userId, drillId);
    await logAudit(req.user!.userId, 'DRILL_CANCELLED', 'backup', { drillId }, req.ip, req.headers['user-agent']);
    res.json({ success: true, message: 'Drill cancelled' });
  } catch (err) {
    next(err instanceof AppError ? err : new AppError(err instanceof Error ? err.message : 'Cancel failed', 400));
  }
}

/**
 * Restore dry-run — preview what WOULD be restored without touching anything.
 */
export async function restoreDryRun(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!backup) throw new AppError('Backup not found', 404);
    if (backup.status !== 'COMPLETED') throw new AppError('Only completed backups can be previewed', 400);

    const { localPath, downloaded } = await ensureLocalBackupFile(req.user!.userId, backup);
    try {
      const { execFileSync } = await import('child_process');
      const fs = await import('fs');
      const { createGunzip } = await import('zlib');
      const { pipeline } = await import('stream/promises');

      let content = '';
      if (localPath.endsWith('.gz')) {
        const tmpPlain = localPath.replace(/\.gz$/, '');
        await pipeline(fs.createReadStream(localPath), createGunzip(), fs.createWriteStream(tmpPlain));
        content = fs.readFileSync(tmpPlain, 'utf8').slice(0, 5 * 1024 * 1024);
        fs.unlinkSync(tmpPlain);
      } else if (backup.format === 'CUSTOM' || localPath.endsWith('.dump')) {
        try {
          content = execFileSync('pg_restore', ['--list', localPath], { encoding: 'utf8', timeout: 30000 });
        } catch { content = ''; }
      } else {
        content = fs.readFileSync(localPath, 'utf8').slice(0, 5 * 1024 * 1024);
      }

      const tables = new Set<string>();
      let createCount = 0;
      let insertCount = 0;

      for (const line of content.split('\n')) {
        const cm = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[`"']?([\w.]+)[`"']?/i.exec(line);
        if (cm) { tables.add(cm[1]); createCount++; continue; }
        const im = /INSERT INTO\s+[`"']?([\w.]+)[`"']?/i.exec(line);
        if (im) { tables.add(im[1]); insertCount++; }
        const pl = /TABLE DATA\s+(\S+)\s+(\S+)/.exec(line);
        if (pl) { tables.add(pl[1] + '.' + pl[2]); }
      }

      const result = {
        fileName: backup.fileName,
        dbName: backup.dbName,
        fileSizeBytes: Number(backup.fileSize),
        format: backup.format,
        encrypted: backup.fileName.endsWith('.enc'),
        estimatedTables: tables.size,
        estimatedRows: insertCount,
        createStatements: createCount,
        insertStatements: insertCount,
        tableNames: [...tables].sort().slice(0, 50),
        warning: 'This is a preview — actual restore will overwrite the target database',
      };

      await logAudit(req.user!.userId, 'RESTORE_DRY_RUN', 'backup', { backupId: backup.id, tables: tables.size }, req.ip, req.headers['user-agent']);
      res.json({ success: true, data: result });
    } finally {
      if (downloaded) cleanupTempFile(localPath);
    }
  } catch (err) { next(err); }
}
