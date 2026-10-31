import fs from 'fs';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

/**
 * At-rest encryption for backup artifacts.
 *
 * File format:  [magic "DBB1" 4B][salt 16B][iv 12B][ciphertext...][GCM tag 16B]
 * Key derivation: scrypt(passphrase, salt) — 32-byte AES-256-GCM key.
 * GCM gives authenticated encryption: tampered/corrupted files fail to decrypt.
 *
 * Works fully streaming, so multi-GB dumps never load into memory.
 */

const MAGIC = Buffer.from('DBB1', 'ascii');
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function isEncryptedFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(MAGIC.length);
      const read = fs.readSync(fd, buf, 0, MAGIC.length, 0);
      return read === MAGIC.length && buf.equals(MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function isEncryptedName(fileName: string): boolean {
  return fileName.endsWith('.enc');
}

/** Encrypt src → dest (streaming). The passphrase is never stored in the file. */
export async function encryptBackupFile(srcPath: string, destPath: string, passphrase: string): Promise<void> {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  // Header first (magic + salt + iv), then streamed ciphertext, tag appended at the end
  const header = new Readable({ read() { this.push(MAGIC); this.push(salt); this.push(iv); this.push(null); } });
  await pipeline(header, fs.createWriteStream(destPath));

  await pipeline(fs.createReadStream(srcPath), cipher, fs.createWriteStream(destPath, { flags: 'a' }));
  fs.appendFileSync(destPath, cipher.getAuthTag());
}

/** Decrypt an encrypted backup back to plaintext. Throws on wrong passphrase or tampering. */
export async function decryptBackupFile(srcPath: string, destPath: string, passphrase: string): Promise<void> {
  const stat = fs.statSync(srcPath);
  if (stat.size < HEADER_LEN + TAG_LEN) throw new Error('File too small to be an encrypted backup');

  const fd = fs.openSync(srcPath, 'r');
  try {
    const header = Buffer.alloc(HEADER_LEN);
    fs.readSync(fd, header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not a DbBackup encrypted file');

    const tag = Buffer.alloc(TAG_LEN);
    fs.readSync(fd, tag, 0, TAG_LEN, stat.size - TAG_LEN);

    const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
    const iv = header.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
    const key = deriveKey(passphrase, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag); // authenticates the whole stream at final()

    const ciphertext = fs.createReadStream(srcPath, { start: HEADER_LEN, end: stat.size - TAG_LEN - 1 });
    await pipeline(ciphertext, decipher, fs.createWriteStream(destPath));
  } finally {
    fs.closeSync(fd);
  }
}

/** Streaming SHA-256 of a file (for round-trip verification). */
export async function sha256File(filePath: string): Promise<string> {
  const { pipeline } = await import('stream/promises');
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}
