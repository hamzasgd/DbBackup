import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { prisma } from '../config/database';
import { decrypt } from './crypto.service';
import { logger } from '../config/logger';

/**
 * Google Drive storage backend — REST-only (no extra npm deps).
 * Credentials live in StorageSettings (encrypted): OAuth Client ID/Secret
 * plus a long-lived refresh token authorized for the `drive` scope.
 */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_FOLDER_NAME = 'DbBackups';

export interface GdriveCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

// Short-lived access tokens, cached per user (refresh tokens are rate-limited)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_TTL_MS = 5 * 60 * 1000;

async function refreshAccessToken(creds: GdriveCredentials): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google token refresh failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  return { token: json.access_token, expiresIn: json.expires_in };
}

/** Stored (encrypted) credentials for a user, or null when not configured. */
export async function getGdriveCredentials(userId: string): Promise<GdriveCredentials | null> {
  const s = await prisma.storageSettings.findUnique({ where: { userId } });
  if (!s || !s.gdriveClientId || !s.gdriveClientSecret || !s.gdriveRefreshToken) return null;
  return {
    clientId: decrypt(s.gdriveClientId),
    clientSecret: decrypt(s.gdriveClientSecret),
    refreshToken: decrypt(s.gdriveRefreshToken),
  };
}

export async function getGdriveAccessToken(userId: string): Promise<string> {
  const creds = await getGdriveCredentials(userId);
  if (!creds) throw new Error('Google Drive storage not configured');

  const cached = tokenCache.get(userId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const { token, expiresIn } = await refreshAccessToken(creds);
  tokenCache.set(userId, { token, expiresAt: Date.now() + Math.min(expiresIn, TOKEN_TTL_MS / 1000) * 1000 });
  return token;
}

/**
 * Resolve the target folder: the configured folder id if set, otherwise
 * find-or-create a "DbBackups" folder in the user's Drive root.
 */
export async function ensureGdriveFolder(userId: string): Promise<string> {
  const s = await prisma.storageSettings.findUnique({ where: { userId } });
  if (s?.gdriveFolderId) return s.gdriveFolderId;

  const token = await getGdriveAccessToken(userId);
  const q = encodeURIComponent(
    `name='${DEFAULT_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`,
  );
  const list = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (list.ok) {
    const { files } = (await list.json()) as { files?: { id: string }[] };
    if (files && files.length > 0) return files[0].id;
  }

  const create = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DEFAULT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!create.ok) throw new Error(`Drive folder create failed (${create.status})`);
  const folder = (await create.json()) as { id: string };
  logger.info(`📁  Created Google Drive folder "${DEFAULT_FOLDER_NAME}" (${folder.id})`);
  return folder.id;
}

/**
 * Upload a backup file (or directory as .tar) to Google Drive with a
 * resumable session. Returns the Drive file id as the storage key.
 */
export async function uploadToGdrive(
  userId: string,
  localPath: string,
  fileName: string,
): Promise<{ storageKey: string; folderId: string } | null> {
  const creds = await getGdriveCredentials(userId);
  if (!creds) return null;

  const token = await getGdriveAccessToken(userId);
  const folderId = await ensureGdriveFolder(userId);

  let uploadPath = localPath;
  let tarPath: string | null = null;
  if (fs.statSync(localPath).isDirectory()) {
    const { execFileSync } = await import('child_process');
    tarPath = `${localPath}.tar`;
    execFileSync('tar', ['-cf', tarPath, '-C', path.dirname(localPath), path.basename(localPath)], { stdio: 'pipe' });
    uploadPath = tarPath;
  }

  try {
    // 1. Start a resumable upload session
    const init = await fetch(`${DRIVE_UPLOAD}/files?uploadType=resumable&fields=id,name`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: fileName, parents: [folderId] }),
    });
    if (!init.ok) {
      const text = await init.text().catch(() => '');
      throw new Error(`Drive upload init failed (${init.status}): ${text.slice(0, 300)}`);
    }
    const sessionUrl = init.headers.get('location');
    if (!sessionUrl) throw new Error('Drive upload init returned no session URL');

    // 2. Upload the bytes in a single PUT to the session (Drive handles chunking server-side)
    const size = fs.statSync(uploadPath).size;
    const put = await fetch(sessionUrl, {
      method: 'PUT',
      headers: { 'Content-Length': String(size) },
      body: fs.createReadStream(uploadPath) as unknown as ReadableStream,
      duplex: 'half',
    });
    if (!put.ok) {
      const text = await put.text().catch(() => '');
      throw new Error(`Drive upload failed (${put.status}): ${text.slice(0, 300)}`);
    }

    const file = (await put.json()) as { id: string; name: string };
    logger.info(`☁️  Uploaded to Google Drive: ${file.name} (${file.id})`);

    return { storageKey: file.id, folderId };
  } finally {
    if (tarPath) {
      try { fs.unlinkSync(tarPath); } catch { /* temp tar cleanup is best-effort */ }
    }
  }
}

/** Stream a Drive file to an Express response (for downloads). */
export async function streamFromGdrive(userId: string, fileId: string): Promise<Readable> {
  const token = await getGdriveAccessToken(userId);
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`Drive download failed (${res.status})`);
  return Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream);
}

/** Download a Drive file to a local path. */
export async function downloadFromGdrive(userId: string, fileId: string, destPath: string): Promise<string> {
  const body = await streamFromGdrive(userId, fileId);
  await pipeline(body, fs.createWriteStream(destPath));
  logger.info(`☁️  Downloaded from Google Drive: ${fileId} -> ${destPath}`);
  return destPath;
}

/** Delete a Drive file (404 treated as already deleted). */
export async function deleteFromGdrive(userId: string, fileId: string): Promise<void> {
  const token = await getGdriveAccessToken(userId);
  const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    throw new Error(`Drive delete failed (${res.status})`);
  }
  logger.info(`☁️  Deleted from Google Drive: ${fileId}`);
}

/**
 * Verify credentials (passed in, not stored) by refreshing the token and
 * reading the account's storage quota.
 */
export async function testGdriveConnection(
  creds: GdriveCredentials,
): Promise<{ success: boolean; error?: string; detail?: string }> {
  try {
    const { token } = await refreshAccessToken(creds);
    const about = await fetch(`${DRIVE_API}/about?fields=user(displayName),storageQuota(limit,usage)`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!about.ok) return { success: false, error: `Drive API access failed (${about.status})` };
    const json = (await about.json()) as {
      user?: { displayName?: string };
      storageQuota?: { limit?: string; usage?: string };
    };
    const usageGb = json.storageQuota?.usage ? (Number(json.storageQuota.usage) / 1024 ** 3).toFixed(1) : '?';
    const limitGb = json.storageQuota?.limit ? (Number(json.storageQuota.limit) / 1024 ** 3).toFixed(0) : '?';
    return {
      success: true,
      detail: `${json.user?.displayName ?? 'Account'} — ${usageGb} GB / ${limitGb} GB used`,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
