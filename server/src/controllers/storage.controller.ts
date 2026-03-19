import { Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { AuthRequest } from '../middleware/auth.middleware';
import { encrypt } from '../services/crypto.service';
import { testS3Connection } from '../services/storage.service';
import { logAudit } from '../services/audit.service';

export async function getStorageSettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await prisma.storageSettings.findUnique({
      where: { userId: req.user!.userId },
    });
    if (settings) {
      res.json({
        success: true, data: {
          ...settings,
          accessKeyId: settings.accessKeyId ? '••••••••' : null,
          secretAccessKey: settings.secretAccessKey ? '••••••••' : null,
        },
      });
    } else {
      res.json({ success: true, data: null });
    }
  } catch (err) { next(err); }
}

export async function upsertStorageSettings(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { provider, bucket, region, accessKeyId, secretAccessKey, endpoint, prefix, deleteLocal } = req.body;

    const data: Record<string, unknown> = {};
    if (provider !== undefined) data.provider = provider;
    if (bucket !== undefined) data.bucket = bucket;
    if (region !== undefined) data.region = region;
    if (endpoint !== undefined) data.endpoint = endpoint || null;
    if (prefix !== undefined) data.prefix = prefix || null;
    if (deleteLocal !== undefined) data.deleteLocal = deleteLocal;
    if (accessKeyId && accessKeyId !== '••••••••') data.accessKeyId = encrypt(accessKeyId);
    if (secretAccessKey && secretAccessKey !== '••••••••') data.secretAccessKey = encrypt(secretAccessKey);

    const settings = await prisma.storageSettings.upsert({
      where: { userId: req.user!.userId },
      create: { userId: req.user!.userId, ...data },
      update: data,
    });

    await logAudit(req.user!.userId, 'UPDATE', 'storage_settings', { provider, bucket, region }, req.ip);

    res.json({
      success: true, data: {
        ...settings,
        accessKeyId: settings.accessKeyId ? '••••••••' : null,
        secretAccessKey: settings.secretAccessKey ? '••••••••' : null,
      },
    });
  } catch (err) { next(err); }
}

export async function testStorageConnection(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { region, bucket, accessKeyId, secretAccessKey, endpoint } = req.body as {
      region: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint?: string;
    };

    const result = await testS3Connection({
      region,
      bucket,
      accessKeyId: encrypt(accessKeyId), // testS3Connection will decrypt
      secretAccessKey: encrypt(secretAccessKey),
      endpoint: endpoint || null,
    });

    res.json({ success: result.success, message: result.error ?? 'Connection successful' });
  } catch (err) { next(err); }
}
