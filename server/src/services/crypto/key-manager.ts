import crypto from 'crypto';
import { logger } from '../../config/logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

interface KeyVersion {
  id: string;
  key: Buffer;
  createdAt: Date;
  isPrimary: boolean;
}

interface EncryptedValue {
  version: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

/**
 * Key Manager with support for key rotation.
 * Supports multiple active keys with version prefixes for migrations.
 */
export class KeyManager {
  private keys: Map<string, KeyVersion> = new Map();
  private primaryKeyId!: string;

  constructor() {
    this.loadKeys();
  }

  private loadKeys(): void {
    // Load primary key
    const primaryKey = process.env.ENCRYPTION_KEY_PRIMARY;
    if (primaryKey) {
      this.addKey('primary', primaryKey, true);
    }

    // Load legacy key for decryption during rotation
    const legacyKey = process.env.ENCRYPTION_KEY;
    if (legacyKey) {
      this.addKey('legacy', legacyKey, false);
    }

    // Load additional keys for rotation
    let index = 1;
    while (true) {
      const keyEnv = process.env[`ENCRYPTION_KEY_V${index}`];
      if (!keyEnv) break;
      this.addKey(`v${index}`, keyEnv, false);
      index++;
    }

    if (this.keys.size === 0) {
      throw new Error('No encryption keys configured. Set ENCRYPTION_KEY or ENCRYPTION_KEY_PRIMARY environment variable.');
    }

    this.primaryKeyId = this.keys.has('primary') ? 'primary' : (this.keys.keys().next().value ?? 'legacy');
    logger.info(`KeyManager initialized with ${this.keys.size} key(s), primary: ${this.primaryKeyId}`);
  }

  private addKey(id: string, hexKey: string, isPrimary: boolean): void {
    if (hexKey.length !== 64) {
      throw new Error(`Encryption key ${id} must be 64 hex characters (32 bytes)`);
    }

    this.keys.set(id, {
      id,
      key: Buffer.from(hexKey, 'hex'),
      createdAt: new Date(),
      isPrimary,
    });
  }

  private getKey(version: string): KeyVersion | undefined {
    return this.keys.get(version);
  }

  getPrimaryKey(): Buffer {
    const key = this.keys.get(this.primaryKeyId);
    if (!key) {
      throw new Error(`Primary key ${this.primaryKeyId} not found`);
    }
    return key.key;
  }

  /**
   * Encrypt with the primary key and add version prefix
   */
  encrypt(plaintext: string): string {
    const encrypted = this.encryptWithKey(plaintext, this.getPrimaryKey());
    return `${this.primaryKeyId}:${encrypted}`;
  }

  /**
   * Decrypt, using the appropriate key based on version prefix
   */
  decrypt(ciphertext: string): string {
    const [version, data] = ciphertext.split(':');

    if (!data) {
      // No version prefix - treat as legacy (unversioned) format
      return this.decryptLegacy(ciphertext);
    }

    const keyVersion = this.keys.get(version);
    if (!keyVersion) {
      throw new Error(`Unknown key version: ${version}`);
    }

    return this.decryptWithKey(data, keyVersion.key);
  }

  /**
   * Encrypt with a specific key
   */
  private encryptWithKey(plaintext: string, key: Buffer): string {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const derivedKey = crypto.pbkdf2Sync(key, salt, ITERATIONS, KEY_LENGTH, 'sha512');

    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const encryptedValue: EncryptedValue = {
      version: '', // Filled by caller
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    };

    return Buffer.from(JSON.stringify(encryptedValue)).toString('base64');
  }

  /**
   * Decrypt with a specific key
   */
  private decryptWithKey(encryptedData: string, key: Buffer): string {
    const parsed = JSON.parse(Buffer.from(encryptedData, 'base64').toString('utf8')) as EncryptedValue;

    const salt = Buffer.from(parsed.salt, 'base64');
    const iv = Buffer.from(parsed.iv, 'base64');
    const tag = Buffer.from(parsed.tag, 'base64');
    const encrypted = Buffer.from(parsed.data, 'base64');

    const derivedKey = crypto.pbkdf2Sync(key, salt, ITERATIONS, KEY_LENGTH, 'sha512');
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);

    return decipher.update(encrypted) + decipher.final('utf8');
  }

  /**
   * Decrypt legacy (unversioned) format
   */
  private decryptLegacy(ciphertext: string): string {
    const buffer = Buffer.from(ciphertext, 'base64');

    const salt = buffer.subarray(0, SALT_LENGTH);
    const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

    // Try legacy key
    const legacyKey = this.keys.get('legacy');
    if (!legacyKey) {
      throw new Error('Legacy encryption key not found');
    }

    const derivedKey = crypto.pbkdf2Sync(legacyKey.key, salt, ITERATIONS, KEY_LENGTH, 'sha512');
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAuthTag(tag);

    return decipher.update(encrypted) + decipher.final('utf8');
  }

  /**
   * Get all key versions (for admin purposes)
   */
  getKeyVersions(): { id: string; createdAt: Date; isPrimary: boolean }[] {
    return Array.from(this.keys.values()).map(k => ({
      id: k.id,
      createdAt: k.createdAt,
      isPrimary: k.id === this.primaryKeyId,
    }));
  }

  /**
   * Check if a ciphertext uses the primary key
   */
  needsReEncryption(ciphertext: string): boolean {
    const [version] = ciphertext.split(':');
    return version !== this.primaryKeyId;
  }
}

// Singleton instance
let keyManager: KeyManager | null = null;

export function getKeyManager(): KeyManager {
  if (!keyManager) {
    keyManager = new KeyManager();
  }
  return keyManager;
}

/**
 * Legacy-compatible encryption functions
 */
export function encrypt(plaintext: string): string {
  return getKeyManager().encrypt(plaintext);
}

export function decrypt(ciphertext: string): string {
  return getKeyManager().decrypt(ciphertext);
}

export function encryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null;
  return encrypt(value);
}

export function decryptIfPresent(value: string | null | undefined): string | null {
  if (!value) return null;
  return decrypt(value);
}
