import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { decrypt, decryptIfPresent } from '../services/crypto.service';
import { addMigrationJob } from '../queue/migration.queue';
import { ConnectionConfig } from '../services/engines/base.engine';
import { verifyMigrationConsistency } from '../services/migration-verification.service';

const decryptConn = (conn: any): ConnectionConfig => {
  return {
    type: conn.type as ConnectionConfig['type'],
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
  };
}

export async function getMigrations(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;

    const [migrations, total] = await Promise.all([
      prisma.migration.findMany({
        where: {
          sourceConnection: { userId: req.user!.userId },
        },
        include: {
          sourceConnection: { select: { id: true, name: true, type: true } },
          targetConnection: { select: { id: true, name: true, type: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parsedLimit,
      }),
      prisma.migration.count({ where: { sourceConnection: { userId: req.user!.userId } } }),
    ]);

    res.json({ success: true, data: { migrations, total, page: parsedPage, limit: parsedLimit } });
  } catch (err) { next(err); }
}

export async function getMigration(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const migration = await prisma.migration.findFirst({
      where: { id: req.params.id, sourceConnection: { userId: req.user!.userId } },
      include: {
        sourceConnection: { select: { id: true, name: true, type: true } },
        targetConnection: { select: { id: true, name: true, type: true } },
      },
    });
    if (!migration) throw new AppError('Migration not found', 404);
    res.json({ success: true, data: migration });
  } catch (err) { next(err); }
}

export async function createMigration(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { sourceConnectionId, targetConnectionId, tables, batchSize, notes } = req.body;

    if (sourceConnectionId === targetConnectionId) {
      throw new AppError('Source and target connections must be different', 400);
    }

    const [srcConn, dstConn] = await Promise.all([
      prisma.connection.findFirst({ where: { id: sourceConnectionId, userId: req.user!.userId } }),
      prisma.connection.findFirst({ where: { id: targetConnectionId, userId: req.user!.userId } }),
    ]);

    if (!srcConn) throw new AppError('Source connection not found', 404);
    if (!dstConn) throw new AppError('Target connection not found', 404);

    const migration = await prisma.migration.create({
      data: {
        id: uuidv4(),
        sourceConnectionId,
        targetConnectionId,
        tableCount: tables?.length ?? 0,
        notes,
        status: 'PENDING',
        startedAt: new Date(),
      },
      include: {
        sourceConnection: { select: { id: true, name: true, type: true } },
        targetConnection: { select: { id: true, name: true, type: true } },
      },
    });

    await addMigrationJob({
      migrationId: migration.id,
      sourceConfig: decryptConn(srcConn),
      targetConfig: decryptConn(dstConn),
      tables,
      batchSize: batchSize ?? 500,
    });

    res.status(202).json({ success: true, data: migration, message: 'Migration job queued' });
  } catch (err) { next(err); }
}

export async function deleteMigration(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const migration = await prisma.migration.findFirst({
      where: { id: req.params.id, sourceConnection: { userId: req.user!.userId } },
    });
    if (!migration) throw new AppError('Migration not found', 404);
    if (migration.status === 'RUNNING') throw new AppError('Cannot delete a running migration', 409);
    await prisma.migration.delete({ where: { id: migration.id } });
    res.json({ success: true, message: 'Migration deleted' });
  } catch (err) { next(err); }
}

export async function verifyMigration(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const migration = await prisma.migration.findFirst({
      where: { id: req.params.id, sourceConnection: { userId: req.user!.userId } },
      include: {
        sourceConnection: true,
        targetConnection: true,
      },
    });

    if (!migration) throw new AppError('Migration not found', 404);
    if (migration.status !== 'COMPLETED') {
      throw new AppError('Only completed migrations can be verified', 409);
    }

    const sourceConfig = decryptConn(migration.sourceConnection);
    const targetConfig = decryptConn(migration.targetConnection);
    const bodyTables = Array.isArray(req.body?.tables)
      ? req.body.tables.filter((t: unknown) => typeof t === 'string' && t.trim().length > 0)
      : undefined;

    const verification = await verifyMigrationConsistency(sourceConfig, targetConfig, bodyTables);

    res.json({
      success: true,
      data: verification,
      message: verification.ok
        ? 'Verification passed: schema, rows, and index signatures match.'
        : 'Verification found mismatches. Review details.',
    });
  } catch (err) { next(err); }
}
