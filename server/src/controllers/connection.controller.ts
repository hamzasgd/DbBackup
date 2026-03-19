import { Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { encrypt, decrypt, encryptIfPresent, decryptIfPresent } from '../services/crypto.service';
import { engineFactory } from '../services/engines/engine.factory';
import { logAudit } from '../services/audit.service';

function encryptConnection(data: {
  host: string; username: string; password: string; database: string;
  sslCa?: string; sslCert?: string; sslKey?: string;
  sshHost?: string; sshUsername?: string; sshPrivateKey?: string; sshPassphrase?: string;
}) {
  return {
    host: encrypt(data.host),
    username: encrypt(data.username),
    password: encrypt(data.password),
    database: encrypt(data.database),
    sslCa: encryptIfPresent(data.sslCa),
    sslCert: encryptIfPresent(data.sslCert),
    sslKey: encryptIfPresent(data.sslKey),
    sshHost: encryptIfPresent(data.sshHost),
    sshUsername: encryptIfPresent(data.sshUsername),
    sshPrivateKey: encryptIfPresent(data.sshPrivateKey),
    sshPassphrase: encryptIfPresent(data.sshPassphrase),
  };
}

function decryptConnection(conn: Record<string, unknown>) {
  return {
    ...conn,
    host: decrypt(conn.host as string),
    username: decrypt(conn.username as string),
    password: '••••••••',
    database: decrypt(conn.database as string),
    sslCa: decryptIfPresent(conn.sslCa as string),
    sslCert: decryptIfPresent(conn.sslCert as string),
    sslKey: decryptIfPresent(conn.sslKey as string),
    sshHost: decryptIfPresent(conn.sshHost as string),
    sshUsername: decryptIfPresent(conn.sshUsername as string),
    sshPrivateKey: undefined, // never expose private keys
    sshPassphrase: undefined,
  };
}

export async function getConnections(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const connections = await prisma.connection.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' },
    });
    const decrypted = connections.map(decryptConnection);
    res.json({ success: true, data: decrypted });
  } catch (err) { next(err); }
}

export async function getConnection(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const conn = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Connection not found', 404);
    res.json({ success: true, data: decryptConnection(conn as Record<string, unknown>) });
  } catch (err) { next(err); }
}

export async function createConnection(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { name, type, host, port, username, password, database, sslEnabled, sshEnabled, ...rest } = req.body;
    const encrypted = encryptConnection({ host, username, password, database, ...rest });

    const conn = await prisma.connection.create({
      data: {
        id: uuidv4(),
        name, type, port: parseInt(port, 10),
        sslEnabled: !!sslEnabled,
        sshEnabled: !!sshEnabled,
        sshPort: rest.sshPort ? parseInt(rest.sshPort, 10) : 22,
        userId: req.user!.userId,
        ...encrypted,
      },
    });

    await logAudit(req.user!.userId, 'CREATE', 'connection', { connectionId: conn.id, name }, req.ip);

    res.status(201).json({ success: true, data: decryptConnection(conn as Record<string, unknown>) });
  } catch (err) { next(err); }
}

export async function updateConnection(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const existing = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!existing) throw new AppError('Connection not found', 404);

    const { name, type, host, port, username, password, database, sslEnabled, sshEnabled, ...rest } = req.body;
    const encrypted = encryptConnection({
      host: host || decrypt(existing.host),
      username: username || decrypt(existing.username),
      password: password || decrypt(existing.password),
      database: database || decrypt(existing.database),
      ...rest,
    });

    const updated = await prisma.connection.update({
      where: { id: req.params.id },
      data: {
        name, type, port: parseInt(port, 10),
        sslEnabled: !!sslEnabled,
        sshEnabled: !!sshEnabled,
        sshPort: rest.sshPort ? parseInt(rest.sshPort, 10) : 22,
        ...encrypted,
      },
    });

    await logAudit(req.user!.userId, 'UPDATE', 'connection', { connectionId: updated.id, name }, req.ip);

    res.json({ success: true, data: decryptConnection(updated as Record<string, unknown>) });
  } catch (err) { next(err); }
}

export async function deleteConnection(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const existing = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!existing) throw new AppError('Connection not found', 404);
    await prisma.connection.delete({ where: { id: req.params.id } });

    await logAudit(req.user!.userId, 'DELETE', 'connection', { connectionId: existing.id, name: existing.name }, req.ip);

    res.json({ success: true, message: 'Connection deleted' });
  } catch (err) { next(err); }
}

export async function testConnection(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const conn = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Connection not found', 404);

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

    const result = await engine.testConnection();
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getDbInfo(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const conn = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Connection not found', 404);

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

    const info = await engine.getDbInfo();
    res.json({ success: true, data: info });
  } catch (err) { next(err); }
}
