import { Response, NextFunction } from 'express';
import { randomUUID as uuidv4 } from 'crypto';
import { prisma } from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../middleware/auth.middleware';
import { encrypt, decrypt, encryptIfPresent, decryptIfPresent } from '../services/crypto.service';
import { engineFactory } from '../services/engines/engine.factory';
import { logAudit, logAuditReq } from '../services/audit.service';
import { deleteBackupArtifact } from '../services/storage.service';
import { logger } from '../config/logger';
import { getHeartbeatSummary } from '../services/heartbeat.service';
import { toEngineConfig } from '../services/engines/connection-config';
import { isTlsUnverified } from '../services/engines/tls';

function encryptConnection(data: {
  host: string; username: string; password: string; database: string;
  sslCa?: string; sslCert?: string; sslKey?: string;
  sshHost?: string; sshUsername?: string; sshPrivateKey?: string; sshPassphrase?: string;
  sshPrivateKeyPath?: string;
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
  const heartbeats = conn.heartbeats as { status: string; latencyMs: number | null; checkedAt: Date }[] | undefined;
  return {
    ...conn,
    heartbeats: undefined,
    latestHeartbeat: heartbeats && heartbeats.length > 0 ? heartbeats[0] : null,
    host: decrypt(conn.host as string),
    username: decrypt(conn.username as string),
    password: '••••••••',
    database: decrypt(conn.database as string),
    sslCa: decryptIfPresent(conn.sslCa as string),
    sslCert: decryptIfPresent(conn.sslCert as string),
    sslKey: undefined, // client TLS private key: never sent back, like the SSH key
    hasSslKey: !!conn.sslKey,
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
      include: { heartbeats: { take: 1, orderBy: { checkedAt: 'desc' } } },
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
        heartbeatEnabled: !!rest.heartbeatEnabled,
        expectedBackupHours: rest.expectedBackupHours ?? null,
        sshPrivateKeyPath: rest.sshPrivateKeyPath || null,
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

    // Only encrypt new values, keep existing encrypted values as-is
    const encrypted = {
      host: host ? encrypt(host) : existing.host,
      username: username ? encrypt(username) : existing.username,
      password: password ? encrypt(password) : existing.password,
      database: database ? encrypt(database) : existing.database,
      sslCa: rest.sslCa !== undefined ? encryptIfPresent(rest.sslCa) : existing.sslCa,
      sslCert: rest.sslCert !== undefined ? encryptIfPresent(rest.sslCert) : existing.sslCert,
      // Not sent back to the edit form (secret), so an empty value means "keep"
      sslKey: rest.sslKey ? encryptIfPresent(rest.sslKey) : (rest.sslCert === '' || rest.sslCert === null ? null : existing.sslKey),
      sshHost: rest.sshHost !== undefined ? encryptIfPresent(rest.sshHost) : existing.sshHost,
      sshUsername: rest.sshUsername !== undefined ? encryptIfPresent(rest.sshUsername) : existing.sshUsername,
      // sshPrivateKey/sshPassphrase are never sent back by the edit form (never
      // exposed), so an untouched field arrives as '' — !== undefined would wipe
      // the stored secret. Only overwrite when a new value is actually provided.
      sshPrivateKey: rest.sshPrivateKey ? encryptIfPresent(rest.sshPrivateKey) : existing.sshPrivateKey,
      sshPassphrase: rest.sshPassphrase ? encryptIfPresent(rest.sshPassphrase) : existing.sshPassphrase,
    };

    // A different SSH server (host or port) means the pinned host key no longer applies
    const newSshPort = rest.sshPort ? parseInt(rest.sshPort, 10) : 22;
    const sshTargetChanged =
      (rest.sshHost !== undefined && (rest.sshHost || null) !== (decryptIfPresent(existing.sshHost) || null)) ||
      newSshPort !== (existing.sshPort ?? 22);

    const updated = await prisma.connection.update({
      where: { id: req.params.id },
      data: {
        name, type, port: parseInt(port, 10),
        ...(sshTargetChanged ? { sshHostKey: null } : {}),
        sslEnabled: !!sslEnabled,
        sshEnabled: !!sshEnabled,
        heartbeatEnabled: rest.heartbeatEnabled !== undefined ? !!rest.heartbeatEnabled : existing.heartbeatEnabled,
        expectedBackupHours: rest.expectedBackupHours !== undefined ? (rest.expectedBackupHours || null) : existing.expectedBackupHours,
        sshPrivateKeyPath: rest.sshPrivateKeyPath !== undefined ? (rest.sshPrivateKeyPath || null) : existing.sshPrivateKeyPath,
        sshPort: newSshPort,
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

    // ?deleteBackups=true → also delete backup files (local + S3) and rows.
    // Otherwise backup rows survive (connectionId set to NULL by the schema)
    // and stay downloadable/restoreable.
    const deleteBackups = req.query.deleteBackups === 'true';

    if (deleteBackups) {
      const backups = await prisma.backup.findMany({
        where: { connectionId: existing.id },
        select: { id: true, filePath: true, fileSize: true, storageType: true, storageKey: true },
      });
      for (const b of backups) {
        await deleteBackupArtifact(existing.userId, b).catch((err) =>
          logger.warn(`Artifact cleanup failed for backup ${b.id} during connection delete:`, err),
        );
      }
    }

    await prisma.connection.delete({ where: { id: req.params.id } });

    await logAudit(
      req.user!.userId,
      'DELETE',
      'connection',
      { connectionId: existing.id, name: existing.name, backupsDeleted: deleteBackups },
      req.ip,
    );

    res.json({ success: true, message: deleteBackups ? 'Connection and its backups deleted' : 'Connection deleted (backups kept)' });
  } catch (err) { next(err); }
}

export async function testConnection(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const conn = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Connection not found', 404);

    const engine = engineFactory(toEngineConfig(conn));

    const result = await engine.testConnection();
    await logAuditReq(req, req.user!.userId, 'TEST', 'connection', {
      connectionId: conn.id, name: conn.name, success: result.success, version: result.version,
    });
    const warning = result.success && isTlsUnverified(toEngineConfig(conn))
      ? 'SSL is on but no CA certificate is set: the connection is encrypted, but the server\'s identity is not verified. Add the CA certificate to verify it.'
      : undefined;
    res.json({ success: true, data: { ...result, ...(warning ? { warning } : {}) } });
  } catch (err) { next(err); }
}

export async function getDbInfo(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const conn = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
    });
    if (!conn) throw new AppError('Connection not found', 404);

    const engine = engineFactory(toEngineConfig(conn));

    const info = await engine.getDbInfo();
    res.json({ success: true, data: info });
  } catch (err) { next(err); }
}

export async function getHeartbeat(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const conn = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: { id: true, heartbeatEnabled: true },
    });
    if (!conn) throw new AppError('Connection not found', 404);

    const summary = await getHeartbeatSummary(conn.id);
    res.json({ success: true, data: { enabled: conn.heartbeatEnabled, ...summary } });
  } catch (err) { next(err); }
}

// ─── Config bundle (backup DbBackup itself) ─────────────────────────────────
import { exportBundle, importBundle } from '../services/config-bundle.service';

export async function exportConfigBundle(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { passphrase } = req.body as { passphrase: string };
    if (!passphrase || passphrase.length < 8) throw new AppError('Passphrase (min 8 chars) is required to encrypt the bundle', 400);
    const data = await exportBundle(req.user!.userId, passphrase);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="dbbackup-config-bundle-${new Date().toISOString().slice(0, 10)}.dbbundle"`);
    res.send(data);
  } catch (err) { next(err); }
}

export async function importConfigBundle(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { passphrase } = req.body as { passphrase: string };
    if (!passphrase) throw new AppError('Passphrase is required to decrypt the bundle', 400);
    // The file comes as raw body (Content-Type: application/octet-stream)
    const data = Buffer.from(req.body);
    const result = await importBundle(req.user!.userId, data, passphrase);
    res.json({ success: true, data: result, message: `Imported ${result.connections} connections and ${result.schedules} schedules` });
  } catch (err) { next(err); }
}

/** Forget the pinned SSH host key; the next connect pins whatever key the server presents. */
export async function resetSshHostKey(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const conn = await prisma.connection.findFirst({
      where: { id: req.params.id, userId: req.user!.userId },
      select: { id: true, name: true, sshHostKey: true },
    });
    if (!conn) throw new AppError('Connection not found', 404);
    await prisma.connection.update({ where: { id: conn.id }, data: { sshHostKey: null } });
    await logAuditReq(req, req.user!.userId, 'SSH_HOST_KEY_RESET', 'connection', {
      connectionId: conn.id, name: conn.name, previousFingerprint: conn.sshHostKey,
    });
    res.json({ success: true, message: 'SSH host key forgotten. The next connection will pin the key the server presents.' });
  } catch (err) { next(err); }
}
