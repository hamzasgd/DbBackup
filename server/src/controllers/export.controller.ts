import { Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { decrypt, decryptIfPresent } from '../services/crypto.service';
import { exportMySQL, exportPostgres, ExportFormat } from '../services/export.service';
import { SSHTunnel } from '../services/ssh.service';

export async function exportTableData(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  let tunnel: SSHTunnel | null = null;
  try {
    const { id } = req.params;
    const { tables, format = 'json' } = req.body as { tables: string[]; format: ExportFormat };

    if (!tables || tables.length === 0) {
      throw new AppError('At least one table is required', 400);
    }
    if (!['json', 'csv', 'sql'].includes(format)) {
      throw new AppError('Format must be one of: json, csv, sql', 400);
    }

    const conn = await prisma.connection.findFirst({
      where: { id, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Connection not found', 404);

    const config = {
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
    };

    if (config.sshEnabled) {
      tunnel = new SSHTunnel(config);
      await tunnel.connect();
    }

    if (conn.type === 'POSTGRESQL') {
      await exportPostgres(config, tables, format, res);
    } else {
      await exportMySQL(config, tables, format, res);
    }
  } catch (err) {
    if (!res.headersSent) next(err);
  } finally {
    tunnel?.close();
  }
}
