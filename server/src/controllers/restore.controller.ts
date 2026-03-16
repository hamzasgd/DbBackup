import { Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { decrypt, decryptIfPresent } from '../services/crypto.service';
import { engineFactory } from '../services/engines/engine.factory';

export async function restoreBackup(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { backupId, targetConnectionId, targetDatabase } = req.body;

    const backup = await prisma.backup.findFirst({
      where: { id: backupId, connection: { userId: req.user!.userId } },
    });
    if (!backup) throw new AppError('Backup not found', 404);
    if (backup.status !== 'COMPLETED') throw new AppError('Backup is not in completed state', 400);

    const connId = targetConnectionId || backup.connectionId;
    const conn = await prisma.connection.findFirst({
      where: { id: connId, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Target connection not found', 404);

    const engine = engineFactory({
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
    });

    await engine.restore(backup.filePath, targetDatabase);
    res.json({ success: true, message: 'Database restored successfully' });
  } catch (err) { next(err); }
}
