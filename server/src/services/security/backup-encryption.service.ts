import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { logger } from '../../config/logger';

const BACKUP_ALGORITHM = 'aes-256-gcm';
const BACKUP_IV_LENGTH = 16;
const BACKUP_TAG_LENGTH = 16;

/**
 * Service for encrypting backup files with a separate encryption key.
 * Backup encryption is independent of credential encryption - backups get their own key.
 */
export class BackupEncryptionService {
  private backupKey: Buffer | null = null;

  constructor() {
    this.loadBackupKey();
  }

  /**
   * Load backup encryption key from environment
   */
  private loadBackupKey(): void {
    const keyEnv = process.env.BACKUP_ENCRYPTION_KEY;

    if (!keyEnv) {
      if (process.env.NODE_ENV === 'production') {
        logger.warn('BACKUP_ENCRYPTION_KEY not set. Backups will not be encrypted.');
      }
      return;
    }

    if (keyEnv.length !== 64) {
      throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
    }

    this.backupKey = Buffer.from(keyEnv, 'hex');
  }

  /**
   * Check if backup encryption is enabled
   */
  isEnabled(): boolean {
    return this.backupKey !== null;
  }

  /**
   * Encrypt a backup file
   * Returns the path to the encrypted file
   */
  async encryptBackup(backupPath: string): Promise<string> {
    if (!this.backupKey) {
      throw new Error('Backup encryption is not configured');
    }

    const encryptedPath = `${backupPath}.encrypted`;

    try {
      // Read the backup file
      const data = await fs.readFile(backupPath);

      // Generate random IV
      const iv = crypto.randomBytes(BACKUP_IV_LENGTH);

      // Create cipher
      const cipher = crypto.createCipheriv(BACKUP_ALGORITHM, this.backupKey, iv);

      // Encrypt the data
      const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
      const tag = cipher.getAuthTag();

      // Write encrypted file: iv + tag + encrypted data
      const output = Buffer.concat([iv, tag, encrypted]);
      await fs.writeFile(encryptedPath, output);

      logger.info(`Backup encrypted: ${backupPath} -> ${encryptedPath}`);

      return encryptedPath;
    } catch (error) {
      logger.error('Backup encryption failed:', error);
      throw new Error('Failed to encrypt backup');
    }
  }

  /**
   * Decrypt a backup file
   * Returns the path to the decrypted file
   */
  async decryptBackup(encryptedPath: string): Promise<string> {
    if (!this.backupKey) {
      throw new Error('Backup encryption is not configured');
    }

    const decryptedPath = encryptedPath.replace('.encrypted', '');

    try {
      // Read encrypted file
      const fileBuffer = await fs.readFile(encryptedPath);

      // Extract IV, tag, and encrypted data
      const iv = fileBuffer.subarray(0, BACKUP_IV_LENGTH);
      const tag = fileBuffer.subarray(BACKUP_IV_LENGTH, BACKUP_IV_LENGTH + BACKUP_TAG_LENGTH);
      const encrypted = fileBuffer.subarray(BACKUP_IV_LENGTH + BACKUP_TAG_LENGTH);

      // Create decipher
      const decipher = crypto.createDecipheriv(BACKUP_ALGORITHM, this.backupKey, iv);
      decipher.setAuthTag(tag);

      // Decrypt
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

      // Write decrypted file
      await fs.writeFile(decryptedPath, decrypted);

      logger.info(`Backup decrypted: ${encryptedPath} -> ${decryptedPath}`);

      return decryptedPath;
    } catch (error) {
      logger.error('Backup decryption failed:', error);
      throw new Error('Failed to decrypt backup');
    }
  }

  /**
   * Encrypt data in memory (for streaming)
   */
  encryptStream(data: Buffer): { encrypted: Buffer; iv: Buffer; tag: Buffer } {
    if (!this.backupKey) {
      throw new Error('Backup encryption is not configured');
    }

    const iv = crypto.randomBytes(BACKUP_IV_LENGTH);
    const cipher = crypto.createCipheriv(BACKUP_ALGORITHM, this.backupKey, iv);

    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();

    return { encrypted, iv, tag };
  }

  /**
   * Decrypt data in memory (for streaming)
   */
  decryptStream(encrypted: Buffer, iv: Buffer, tag: Buffer): Buffer {
    if (!this.backupKey) {
      throw new Error('Backup encryption is not configured');
    }

    const decipher = crypto.createDecipheriv(BACKUP_ALGORITHM, this.backupKey, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Generate a new backup encryption key (for key rotation)
   */
  static generateKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}

// Singleton instance
let backupEncryptionService: BackupEncryptionService | null = null;

export function getBackupEncryptionService(): BackupEncryptionService {
  if (!backupEncryptionService) {
    backupEncryptionService = new BackupEncryptionService();
  }
  return backupEncryptionService;
}
