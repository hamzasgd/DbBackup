import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../config/database';
import { decrypt } from './crypto.service';
import { logger } from '../config/logger';

export interface StorageUploadResult {
  storageKey: string;
  provider: 'LOCAL' | 'S3';
}

// Cache S3 clients by credentials fingerprint to avoid creating new clients per operation
const s3Cache = new Map<string, { client: S3Client; createdAt: number }>();
const S3_CLIENT_TTL = 10 * 60 * 1000; // 10 minutes

function buildS3Client(settings: {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | null;
}): S3Client {
  const decryptedKey = decrypt(settings.accessKeyId);
  const cacheKey = crypto.createHash('sha256')
    .update(`${settings.region}:${decryptedKey}:${settings.endpoint ?? ''}`)
    .digest('hex');
  const cached = s3Cache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < S3_CLIENT_TTL) {
    return cached.client;
  }

  const client = new S3Client({
    region: settings.region,
    credentials: {
      accessKeyId: decryptedKey,
      secretAccessKey: decrypt(settings.secretAccessKey),
    },
    ...(settings.endpoint
      ? { endpoint: settings.endpoint, forcePathStyle: true }
      : {}),
  });

  s3Cache.set(cacheKey, { client, createdAt: Date.now() });
  return client;
}

/**
 * Upload a backup file (or directory as .tar) to S3.
 * Returns the storage key used.
 */
export async function uploadToS3(
  userId: string,
  localPath: string,
  fileName: string,
): Promise<StorageUploadResult | null> {
  const settings = await prisma.storageSettings.findUnique({ where: { userId } });
  if (!settings || settings.provider !== 'S3') return null;
  if (!settings.bucket || !settings.region || !settings.accessKeyId || !settings.secretAccessKey) {
    logger.warn('S3 upload skipped: incomplete settings');
    return null;
  }

  const s3 = buildS3Client({
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
  });

  const prefix = settings.prefix ? `${settings.prefix.replace(/\/$/, '')}/` : '';
  const storageKey = `${prefix}${fileName}`;

  const stat = fs.statSync(localPath);
  let body: Readable;

  if (stat.isDirectory()) {
    // Tar up the directory for upload
    const { execFileSync } = await import('child_process');
    const tarPath = `${localPath}.tar`;
    execFileSync('tar', ['-cf', tarPath, '-C', path.dirname(localPath), path.basename(localPath)], { stdio: 'pipe' });
    body = fs.createReadStream(tarPath);
    // Clean up tar after upload in a callback
    body.on('end', () => { try { fs.unlinkSync(tarPath); } catch (err) { logger.debug('Failed to delete temp tar:', err); } });
  } else {
    body = fs.createReadStream(localPath);
  }

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: settings.bucket,
      Key: storageKey,
      Body: body,
    },
    queueSize: 4,
    partSize: 10 * 1024 * 1024, // 10MB parts
  });

  upload.on('httpUploadProgress', (progress) => {
    if (progress.loaded && progress.total) {
      logger.debug(`S3 upload ${fileName}: ${Math.round((progress.loaded / progress.total) * 100)}%`);
    }
  });

  await upload.done();
  logger.info(`☁️  Uploaded to S3: ${storageKey}`);

  // Optionally delete local copy
  if (settings.deleteLocal) {
    try {
      if (stat.isDirectory()) {
        fs.rmSync(localPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(localPath);
      }
      logger.info(`🗑️  Deleted local copy: ${localPath}`);
    } catch (err) {
      logger.warn(`Failed to delete local copy: ${err}`);
    }
  }

  return { storageKey, provider: 'S3' };
}

/**
 * Stream an S3 object to an Express response (for download).
 */
export async function streamFromS3(
  userId: string,
  storageKey: string,
): Promise<Readable> {
  const settings = await prisma.storageSettings.findUnique({ where: { userId } });
  if (!settings || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
    throw new Error('S3 storage not configured');
  }

  const s3 = buildS3Client({
    region: settings.region!,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
  });

  const { Body } = await s3.send(new GetObjectCommand({ Bucket: settings.bucket, Key: storageKey }));
  if (!Body) throw new Error('S3 returned empty body');
  return Body as Readable;
}

/**
 * Generate a presigned download URL (valid 15 min) for S3-stored backups.
 */
export async function getPresignedUrl(userId: string, storageKey: string): Promise<string> {
  const settings = await prisma.storageSettings.findUnique({ where: { userId } });
  if (!settings || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) {
    throw new Error('S3 storage not configured');
  }

  const s3 = buildS3Client({
    region: settings.region!,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
  });

  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: settings.bucket, Key: storageKey }),
    { expiresIn: 900 },
  );
}

/**
 * Delete an object from S3.
 */
export async function deleteFromS3(userId: string, storageKey: string): Promise<void> {
  const settings = await prisma.storageSettings.findUnique({ where: { userId } });
  if (!settings || !settings.bucket || !settings.accessKeyId || !settings.secretAccessKey) return;

  const s3 = buildS3Client({
    region: settings.region!,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
  });

  await s3.send(new DeleteObjectCommand({ Bucket: settings.bucket, Key: storageKey }));
  logger.info(`☁️  Deleted from S3: ${storageKey}`);
}

/**
 * Download an S3 object to a local file.
 */
export async function downloadFromS3(userId: string, storageKey: string, destPath: string): Promise<string> {
  const body = await streamFromS3(userId, storageKey);
  await pipeline(body, fs.createWriteStream(destPath));
  logger.info(`☁️  Downloaded from S3: ${storageKey} -> ${destPath}`);
  return destPath;
}

/** Minimal shape of a Backup record needed for artifact cleanup */
export interface BackupArtifact {
  storageType?: string | null;
  storageKey?: string | null;
  filePath: string;
}

/**
 * Delete every artifact of a backup: the S3 object (if S3-stored) and the local
 * file/directory. Used by manual delete and retention cleanup so S3 objects
 * are never orphaned.
 */
export async function deleteBackupArtifact(userId: string, backup: BackupArtifact): Promise<void> {
  if (backup.storageType === 'S3' && backup.storageKey) {
    try {
      await deleteFromS3(userId, backup.storageKey);
    } catch (err) {
      logger.warn(`Failed to delete S3 object ${backup.storageKey}:`, err);
    }
  }

  if (!backup.filePath || backup.filePath === 'pending') return;
  try {
    const stat = fs.statSync(backup.filePath);
    if (stat.isDirectory()) {
      fs.rmSync(backup.filePath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(backup.filePath);
    }
  } catch (err) {
    logger.debug('Failed to delete local backup file:', err);
  }
}

/**
 * Resolve a locally-readable path for a backup file.
 * Falls back to downloading from S3 into a temp dir when the local copy is gone
 * (e.g. deleteLocal=true). Caller is responsible for deleting the returned
 * temp file when `downloaded` is true.
 */
export async function ensureLocalBackupFile(
  userId: string,
  backup: BackupArtifact & { fileName?: string | null },
): Promise<{ localPath: string; downloaded: boolean }> {
  if (backup.filePath && backup.filePath !== 'pending' && fs.existsSync(backup.filePath)) {
    return { localPath: backup.filePath, downloaded: false };
  }
  if (backup.storageType !== 'S3' || !backup.storageKey) {
    throw new Error('Backup file not found on disk');
  }

  const name = backup.fileName || path.basename(backup.storageKey);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbackup-restore-'));
  const destPath = path.join(tempDir, name.endsWith('.tar') || name.includes('.') ? name : `${name}.dump`);
  await downloadFromS3(userId, backup.storageKey, destPath);
  return { localPath: destPath, downloaded: true };
}

/** Remove the temp dir produced by ensureLocalBackupFile */
export function cleanupTempFile(tempPath: string): void {
  try {
    fs.rmSync(path.dirname(tempPath), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * Test S3 connection by trying to HeadObject on the bucket root.
 */
export async function testS3Connection(settings: {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | null;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const s3 = buildS3Client(settings);
    await s3.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: '.dbbackup-test' }));
    return { success: true };
  } catch (err: unknown) {
    // 404 means the bucket is accessible (object just doesn't exist)
    if (err && typeof err === 'object' && '$metadata' in err) {
      const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
      if (meta?.httpStatusCode === 404) return { success: true };
    }
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
