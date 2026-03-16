import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { decrypt, decryptIfPresent } from '../services/crypto.service';
import { addBackupJob } from '../queue/backup.queue';
import { verifyBackup } from '../services/verification.service';
import { streamFromS3 } from '../services/storage.service';

const STORAGE_PATH = process.env.BACKUP_STORAGE_PATH || path.join(process.cwd(), 'backups');

export async function getBackups(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { connectionId, page = '1', limit = '20' } = req.query as Record<string, string>;
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;

    const where = {
      connection: { userId: req.user!.userId },
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

    // Ensure storage dir exists
    if (!fs.existsSync(STORAGE_PATH)) {
      fs.mkdirSync(STORAGE_PATH, { recursive: true });
    }

    // Resolve and validate format
    const defaultFormat = conn.type === 'POSTGRESQL' ? 'CUSTOM' : 'COMPRESSED_SQL';
    const resolvedFormat = format ?? defaultFormat;

    const backup = await prisma.backup.create({
      data: {
        id: uuidv4(),
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

    // Queue the job
    await addBackupJob({
      backupId: backup.id,
      connectionId,
      outputDir: STORAGE_PATH,
      format: resolvedFormat,
      config: {
        type: conn.type,
        host: decrypt(conn.host),
        port: conn.port,
        username: decrypt(conn.username),
        password: decrypt(conn.password),
        database: decrypt(conn.database),
        sslEnabled: conn.sslEnabled,
        sshEnabled: conn.sshEnabled,
        sshHost: decryptIfPresent(conn.sshHost) || undefined,
        sshPort: conn.sshPort || 22,
        sshUsername: decryptIfPresent(conn.sshUsername) || undefined,
        sshPrivateKey: decryptIfPresent(conn.sshPrivateKey) || undefined,
        sshPassphrase: decryptIfPresent(conn.sshPassphrase) || undefined,
      },
    });

    res.status(202).json({ success: true, data: backup, message: 'Backup job queued' });
  } catch (err) { next(err); }
}

export async function getBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, connection: { userId: req.user!.userId } },
      include: { connection: { select: { id: true, name: true, type: true } } },
    });
    if (!backup) throw new AppError('Backup not found', 404);
    res.json({ success: true, data: backup });
  } catch (err) { next(err); }
}

export async function deleteBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, connection: { userId: req.user!.userId } },
    });
    if (!backup) throw new AppError('Backup not found', 404);

    // Delete file (or directory for PostgreSQL DIRECTORY format)
    if (fs.existsSync(backup.filePath)) {
      const stat = fs.statSync(backup.filePath);
      if (stat.isDirectory()) {
        fs.rmSync(backup.filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(backup.filePath);
      }
    }

    await prisma.backup.delete({ where: { id: backup.id } });
    res.json({ success: true, message: 'Backup deleted' });
  } catch (err) { next(err); }
}

export async function downloadBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, connection: { userId: req.user!.userId } },
    });
    if (!backup) throw new AppError('Backup not found', 404);

    // S3-stored backup — stream from S3
    if (backup.storageType === 'S3' && backup.storageKey) {
      const stream = await streamFromS3(req.user!.userId, backup.storageKey);
      res.setHeader('Content-Disposition', `attachment; filename="${backup.fileName}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      stream.pipe(res);
      return;
    }

    // Local backup
    if (!fs.existsSync(backup.filePath)) throw new AppError('Backup file not found on disk', 404);
    res.download(backup.filePath, backup.fileName);
  } catch (err) { next(err); }
}

export async function verifyBackupEndpoint(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const backup = await prisma.backup.findFirst({
      where: { id: req.params.id, connection: { userId: req.user!.userId } },
    });
    if (!backup) throw new AppError('Backup not found', 404);
    if (backup.status !== 'COMPLETED') throw new AppError('Only completed backups can be verified', 400);
    if (!fs.existsSync(backup.filePath)) throw new AppError('Backup file not found on disk', 404);

    const result = await verifyBackup(backup.filePath, backup.dbType, backup.format);

    await prisma.backup.update({
      where: { id: backup.id },
      data: {
        verified: result.valid,
        verifiedAt: new Date(),
        checksum: result.checksum || null,
      },
    });

    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}
