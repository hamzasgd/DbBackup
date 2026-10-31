import { Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';
import { encrypt, decrypt } from '../services/crypto.service';
import { testS3Connection } from '../services/storage.service';
import { testGdriveConnection } from '../services/gdrive.service';
import { getStorageUsage } from '../services/storage-alerts.service';
import { logAudit } from '../services/audit.service';

const SECRET_MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

function maskedSettings(settings: Record<string, unknown>) {
  return {
    ...settings,
    accessKeyId: settings.accessKeyId ? SECRET_MASK : null,
    secretAccessKey: settings.secretAccessKey ? SECRET_MASK : null,
    gdriveClientSecret: settings.gdriveClientSecret ? SECRET_MASK : null,
    gdriveRefreshToken: settings.gdriveRefreshToken ? SECRET_MASK : null,
    backupPassphrase: settings.backupPassphrase ? SECRET_MASK : null,
  };
}

export async function getStorageSettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await prisma.storageSettings.findUnique({
      where: { userId: req.user!.userId },
    });
    if (settings) {
      res.json({ success: true, data: maskedSettings(settings as unknown as Record<string, unknown>) });
    } else {
      res.json({ success: true, data: null });
    }
  } catch (err) { next(err); }
}

export async function upsertStorageSettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const {
      provider, bucket, region, accessKeyId, secretAccessKey, endpoint, prefix, deleteLocal,
      gdriveClientId, gdriveClientSecret, gdriveRefreshToken, gdriveFolderId,
      backupEncryptionEnabled, backupPassphrase, currentBackupPassphrase,
    } = req.body;

    const data: Record<string, unknown> = {};
    if (provider !== undefined) data.provider = provider;
    if (bucket !== undefined) data.bucket = bucket;
    if (region !== undefined) data.region = region;
    if (endpoint !== undefined) data.endpoint = endpoint || null;
    if (prefix !== undefined) data.prefix = prefix || null;
    if (deleteLocal !== undefined) data.deleteLocal = deleteLocal;
    if (accessKeyId && accessKeyId !== SECRET_MASK) data.accessKeyId = encrypt(accessKeyId);
    if (secretAccessKey && secretAccessKey !== SECRET_MASK) data.secretAccessKey = encrypt(secretAccessKey);
    if (gdriveClientId !== undefined) data.gdriveClientId = gdriveClientId || null;
    if (gdriveClientSecret && gdriveClientSecret !== SECRET_MASK) data.gdriveClientSecret = encrypt(gdriveClientSecret);
    if (gdriveRefreshToken && gdriveRefreshToken !== SECRET_MASK) data.gdriveRefreshToken = encrypt(gdriveRefreshToken);
    if (gdriveFolderId !== undefined) data.gdriveFolderId = gdriveFolderId || null;

    // ── Backup passphrase safety ──
    // Changing the passphrase requires the current one and moves the old one
    // into a history list, so .enc backups from before the rotation remain
    // decryptable (no data loss on rotation).
    const existingSettings = await prisma.storageSettings.findUnique({ where: { userId: req.user!.userId } });
    const changingPassphrase = Boolean(backupPassphrase) && backupPassphrase !== SECRET_MASK
      && existingSettings?.backupPassphrase
      && decrypt(existingSettings.backupPassphrase) !== backupPassphrase;

    if (changingPassphrase) {
      if (!currentBackupPassphrase || decrypt(existingSettings!.backupPassphrase!) !== currentBackupPassphrase) {
        res.status(400).json({ success: false, message: 'Current backup passphrase is required (and must match) to set a new one' });
        return;
      }
      const history = Array.isArray(existingSettings!.backupPassphraseHistory)
        ? (existingSettings!.backupPassphraseHistory as string[])
        : [];
      history.push(existingSettings!.backupPassphrase!); // stored encrypted already
      data.backupPassphraseHistory = history;
      data.backupPassphrase = encrypt(backupPassphrase as string);
    } else if (backupPassphrase && backupPassphrase !== SECRET_MASK) {
      data.backupPassphrase = encrypt(backupPassphrase); // first-time set
    }

    if (backupEncryptionEnabled !== undefined) {
      // Refuse to "enable" encryption without any usable passphrase — backups
      // would silently stay plaintext while looking encrypted.
      const willHavePassphrase = Boolean(
        data.backupPassphrase ?? existingSettings?.backupPassphrase
      );
      if (backupEncryptionEnabled && !willHavePassphrase) {
        res.status(400).json({ success: false, message: 'Set a backup passphrase before enabling encryption at rest' });
        return;
      }
      data.backupEncryptionEnabled = !!backupEncryptionEnabled;
    }

    const settings = await prisma.storageSettings.upsert({
      where: { userId: req.user!.userId },
      create: { userId: req.user!.userId, ...data },
      update: data,
    });

    await logAudit(req.user!.userId, 'UPDATE', 'storage_settings', { provider }, req.ip);

    res.json({
      success: true,
      data: maskedSettings(settings as unknown as Record<string, unknown>),
    });
  } catch (err) { next(err); }
}

export async function testStorageConnection(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = req.body as Record<string, string | undefined>;

    if (body.provider === 'GOOGLE_DRIVE') {
      // Prefer freshly typed credentials; fall back to stored ones for re-tests
      const stored = await prisma.storageSettings.findUnique({ where: { userId: req.user!.userId } });
      const clientId = body.gdriveClientId?.trim()
        || (stored?.gdriveClientId ? decrypt(stored.gdriveClientId) : '');
      const clientSecret = body.gdriveClientSecret && body.gdriveClientSecret !== SECRET_MASK
        ? body.gdriveClientSecret
        : (stored?.gdriveClientSecret ? decrypt(stored.gdriveClientSecret) : '');
      const refreshToken = body.gdriveRefreshToken && body.gdriveRefreshToken !== SECRET_MASK
        ? body.gdriveRefreshToken
        : (stored?.gdriveRefreshToken ? decrypt(stored.gdriveRefreshToken) : '');

      const result = await testGdriveConnection({ clientId, clientSecret, refreshToken });
      await logAudit(req.user!.userId, 'TEST', 'storage_settings', { provider: 'GOOGLE_DRIVE', success: result.success }, req.ip, req.headers['user-agent']);
      res.json({ success: result.success, message: result.error ?? `${result.detail ?? 'Google Drive connection successful'} — uploads are private to your account` });
      return;
    }

    const { region, bucket, accessKeyId, secretAccessKey, endpoint } = body as {
      region: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint?: string;
    };

    const result = await testS3Connection({
      region,
      bucket,
      accessKeyId: encrypt(accessKeyId), // testS3Connection will decrypt
      secretAccessKey: encrypt(secretAccessKey),
      endpoint: endpoint || null,
    });

    await logAudit(req.user!.userId, 'TEST', 'storage_settings', { provider: 'S3', bucket, success: result.success, publicAccessWarning: result.warning ?? false }, req.ip, req.headers['user-agent']);
    const okMsg = result.warning ? `Connection successful — ${result.warning}` : 'Connection successful';
    res.json({ success: result.success, message: result.error ?? okMsg });
  } catch (err) { next(err); }
}

export async function storageUsage(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const usage = await getStorageUsage(req.user!.userId);
    res.json({ success: true, data: usage });
  } catch (err) { next(err); }
}
