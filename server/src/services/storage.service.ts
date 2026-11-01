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
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../config/database';
import { decrypt } from './crypto.service';
import { logger } from '../config/logger';
import { assertSafeEndpoint, parseSafeEndpoint, UnsafeEndpointError } from '../utils/endpoint-guard';
import { uploadToGdrive, downloadFromGdrive, deleteFromGdrive } from './gdrive.service';
import { isEncryptedFile, decryptBackupFile } from './backup-crypto.service';

export type StorageProviderType = 'LOCAL' | 'S3' | 'GOOGLE_DRIVE';

export interface StorageUploadResult {
  storageKey: string;
  provider: StorageProviderType;
}

/**
 * Upload a backup artifact to the user's configured remote storage
 * (S3 or Google Drive). Returns null when no remote provider is active.
 */
export async function uploadBackupFile(
  userId: string,
  localPath: string,
  fileName: string,
): Promise<StorageUploadResult | null> {
  const settings = await prisma.storageSettings.findUnique({ where: { userId } });
  if (!settings) return null;

  if (settings.provider === 'S3') {
    return uploadToS3(userId, localPath, fileName);
  }
  if (settings.provider === 'GOOGLE_DRIVE') {
    const uploaded = await uploadToGdrive(userId, localPath, fileName);
    if (!uploaded) return null;

    // Honor deleteLocal the same way the S3 path does
    if (settings.deleteLocal) {
      try {
        if (fs.statSync(localPath).isDirectory()) {
          fs.rmSync(localPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(localPath);
        }
        logger.info(`🗑️  Deleted local copy: ${localPath}`);
      } catch (err) {
        logger.warn(`Failed to delete local copy: ${err}`);
      }
    }

    return { storageKey: uploaded.storageKey, provider: 'GOOGLE_DRIVE' };
  }
  return null;
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
  if (settings.endpoint) parseSafeEndpoint(settings.endpoint);
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

  if (backup.storageType === 'GOOGLE_DRIVE' && backup.storageKey) {
    try {
      await deleteFromGdrive(userId, backup.storageKey);
    } catch (err) {
      logger.warn(`Failed to delete Google Drive file ${backup.storageKey}:`, err);
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
    if (isEncryptedFile(backup.filePath)) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbackup-decrypt-'));
      return maybeDecrypt(userId, backup.filePath, tempDir);
    }
    return { localPath: backup.filePath, downloaded: false };
  }
  if (!backup.storageKey || (backup.storageType !== 'S3' && backup.storageType !== 'GOOGLE_DRIVE')) {
    throw new Error('Backup file not found on disk');
  }

  const name = backup.fileName || path.basename(backup.storageKey);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbackup-restore-'));
  const destPath = path.join(tempDir, name.endsWith('.tar') || name.includes('.') ? name : `${name}.dump`);
  if (backup.storageType === 'GOOGLE_DRIVE') {
    await downloadFromGdrive(userId, backup.storageKey, destPath);
  } else {
    await downloadFromS3(userId, backup.storageKey, destPath);
  }
  return maybeDecrypt(userId, destPath, tempDir);
}

/**
 * At-rest encryption: local artifacts may be .enc files. Decrypt into the same
 * temp dir so every consumer (restore / verify / download) gets plaintext and
 * the existing cleanup removes it.
 */
async function maybeDecrypt(userId: string, filePath: string, tempDir: string): Promise<{ localPath: string; downloaded: boolean }> {
  if (!isEncryptedFile(filePath)) {
    return { localPath: filePath, downloaded: filePath.startsWith(tempDir) };
  }

  const settings = await prisma.storageSettings.findUnique({ where: { userId } });
  const candidates = [
    settings?.backupPassphrase,
    ...(Array.isArray(settings?.backupPassphraseHistory) ? (settings!.backupPassphraseHistory as string[]) : []),
  ].filter((p): p is string => Boolean(p));
  if (candidates.length === 0) {
    throw new Error('Backup file is encrypted but no backup passphrase is configured');
  }

  const plainPath = path.join(tempDir, path.basename(filePath).replace(/\.enc$/, ''));
  let lastErr: unknown = null;
  let decrypted = false;
  for (const candidate of candidates) {
    try {
      await decryptBackupFile(filePath, plainPath, decrypt(candidate));
      decrypted = true;
      break;
    } catch (err) {
      lastErr = err; // wrong passphrase (old rotation) — try the next one
    }
  }
  if (!decrypted) {
    throw new Error(`Could not decrypt backup with any known passphrase: ${lastErr instanceof Error ? lastErr.message : lastErr}`);
  }
  // If the encrypted copy was itself a temp download, drop it; if it was the
  // local artifact on disk, leave it (that's the at-rest copy).
  if (filePath.startsWith(os.tmpdir())) {
    try { fs.unlinkSync(filePath); } catch { /* best effort */ }
  }
  logger.info(`🔒 Decrypted backup artifact for use: ${path.basename(plainPath)}`);
  return { localPath: plainPath, downloaded: true };
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
 * Create (or tighten) the local backup storage directory with owner-only
 * permissions. Backup dumps contain full database contents — the directory
 * must never be readable by other users on the host (or a static-file server
 * running as another user).
 */
export function ensureStorageDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const mode = fs.statSync(dir).mode & 0o777;
    if (mode !== 0o700) fs.chmodSync(dir, 0o700);
  } catch (err) {
    logger.warn(`Could not verify permissions on backup dir ${dir}:`, err);
  }
}

/** Resolve the configured local backup dir (env override or <cwd>/backups). */
export function getStoragePath(): string {
  return process.env.BACKUP_STORAGE_PATH || path.join(process.cwd(), 'backups');
}

/**
 * Test S3 connection by trying to HeadObject on the bucket root, then verify
 * the bucket is NOT publicly accessible (anonymous probe + policy checks).
 */
export async function testS3Connection(settings: {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string | null;
}): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    if (settings.endpoint) await assertSafeEndpoint(settings.endpoint);
  } catch (err) {
    if (err instanceof UnsafeEndpointError) return { success: false, error: err.message };
    throw err;
  }
  const s3 = buildS3Client(settings);
  try {
    await s3.send(new HeadObjectCommand({ Bucket: settings.bucket, Key: '.dbbackup-test' }));
  } catch (err: unknown) {
    // 404 means the bucket is accessible (object just doesn't exist)
    if (err && typeof err === 'object' && '$metadata' in err) {
      const meta = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
      if (meta?.httpStatusCode !== 404) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const warning = await checkS3PublicAccess(s3, settings);
  return { success: true, warning };
}

/**
 * Privacy probe for an S3 bucket. Backup dumps must never be fetchable
 * without authentication, so the test connection warns when:
 *  - anonymous HTTP access to the bucket succeeds (public listing), or
 *  - the bucket policy grants public access, or
 *  - Block Public Access is not fully enabled.
 */
async function checkS3PublicAccess(
  s3: S3Client,
  settings: { bucket: string; region: string; endpoint?: string | null },
): Promise<string | undefined> {
  const problems: string[] = [];

  // 1. Anonymous probe — an UNSIGNED bucket listing through the SDK (no credentials sent);
  //    if it succeeds the bucket (and likely its objects) are world-readable.
  try {
    const anonymous = new S3Client({
      region: settings.region,
      ...(settings.endpoint ? { endpoint: settings.endpoint, forcePathStyle: true } : {}),
      // Replace SigV4 with a "no auth" scheme so no Authorization header is added
      httpAuthSchemes: [{
        schemeId: 'smithy.api#noAuth',
        identityProvider: () => async () => ({}),
        signer: { sign: async (request: unknown) => request },
      }] as never,
      httpAuthSchemeProvider: (() => [{ schemeId: 'smithy.api#noAuth' }]) as never,
      maxAttempts: 1,
      requestHandler: { requestTimeout: 5000, connectionTimeout: 5000 },
    });
    try {
      await anonymous.send(new ListObjectsV2Command({ Bucket: settings.bucket, MaxKeys: 1 }));
      problems.push('anonymous listing of the bucket succeeded — objects may be world-readable');
    } finally {
      anonymous.destroy();
    }
  } catch {
    /* AccessDenied / network issues on the probe are not conclusive — ignore */
  }

  // 2. Bucket policy status (requires s3:GetBucketPolicyStatus)
  try {
    const { PolicyStatus } = await s3.send(new GetBucketPolicyStatusCommand({ Bucket: settings.bucket }));
    if (PolicyStatus?.IsPublic === true) {
      problems.push('bucket policy grants public access');
    }
  } catch {
    /* permission not granted for the check — skip */
  }

  // 3. Block Public Access configuration (requires s3:GetPublicAccessBlock)
  try {
    const { PublicAccessBlockConfiguration: conf } = await s3.send(
      new GetPublicAccessBlockCommand({ Bucket: settings.bucket }),
    );
    const off = [
      !conf?.BlockPublicAcls && 'BlockPublicAcls',
      !conf?.IgnorePublicAcls && 'IgnorePublicAcls',
      !conf?.BlockPublicPolicy && 'BlockPublicPolicy',
      !conf?.RestrictPublicBuckets && 'RestrictPublicBuckets',
    ].filter((v): v is string => Boolean(v));
    if (off.length > 0) {
      problems.push(`Block Public Access not fully enabled (off: ${off.join(', ')})`);
    }
  } catch {
    /* permission not granted for the check — skip */
  }

  if (problems.length === 0) return undefined;
  return `⚠️ Bucket privacy: ${problems.join('; ')}. Enable "Block all public access" on the bucket.`;
}
