import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
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
        include: { connection: { select: { id: true, name: true, type: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parsedLimit,
      }),
      prisma.backup.count({ where }),
    ]);

    res.json({ success: true, data: { backups, total, page: parsedPage, limit: parsedLimit } });
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
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      include: { connection: { select: { id: true, name: true, type: true } } },
    });
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
