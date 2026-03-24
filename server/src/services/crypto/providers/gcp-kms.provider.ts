import { CryptoProvider } from '../crypto.provider';
import { logger } from '../../../config/logger';

// Dynamic import to avoid requiring GCP SDK when not used
let KeyManagementServiceClient: any = null;

async function loadGCPSDK(): Promise<void> {
  if (KeyManagementServiceClient) return;

  try {
    const { KeyManagementServiceClient: Client } = await import('@google-cloud/kms');
    KeyManagementServiceClient = Client;
  } catch (error) {
    throw new Error('GCP KMS provider requires @google-cloud/kms package. Install it with: npm install @google-cloud/kms');
  }
}

/**
 * GCP Cloud KMS Crypto Provider
 * Requires @google-cloud/kms package
 */
export class GCPCryptoProvider implements CryptoProvider {
  readonly name = 'gcp-kms';
  private client: any = null;
  private projectId: string;
  private location: string;
  private keyRing: string;
  private keyName: string;
  private initialized: boolean = false;

  constructor() {
    this.projectId = process.env.GCP_PROJECT_ID || '';

    if (!this.projectId) {
      throw new Error('GCP_PROJECT_ID environment variable is required for GCP KMS provider');
    }

    this.location = process.env.GCP_KMS_LOCATION || 'global';
    this.keyRing = process.env.GCP_KMS_KEY_RING || 'dbbackup';
    this.keyName = process.env.GCP_KMS_KEY_NAME || 'dbbackup-encryption';
  }

  private getFullKeyName(): string {
    return this.client.cryptoKeyPath(this.projectId, this.location, this.keyRing, this.keyName);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await loadGCPSDK();

    if (!KeyManagementServiceClient) {
      throw new Error('GCP KMS SDK not properly loaded');
    }

    this.client = new KeyManagementServiceClient();
    this.initialized = true;
  }

  async encrypt(plaintext: string): Promise<string> {
    await this.ensureInitialized();

    try {
      const [result] = await this.client.encrypt({
        name: this.getFullKeyName(),
        plaintext: Buffer.from(plaintext, 'utf8'),
      });

      return Buffer.from(result.ciphertext as Uint8Array).toString('base64');
    } catch (error) {
      logger.error('GCP KMS encryption failed:', error);
      throw new Error('Encryption failed');
    }
  }

  async decrypt(ciphertext: string): Promise<string> {
    await this.ensureInitialized();

    try {
      const [result] = await this.client.decrypt({
        name: this.getFullKeyName(),
        ciphertext: Buffer.from(ciphertext, 'base64'),
      });

      return Buffer.from(result.plaintext as Uint8Array).toString('utf8');
    } catch (error) {
      logger.error('GCP KMS decryption failed:', error);
      throw new Error('Decryption failed');
    }
  }

  async encryptIfPresent(value: string | null | undefined): Promise<string | null> {
    if (!value) return null;
    return this.encrypt(value);
  }

  async decryptIfPresent(value: string | null | undefined): Promise<string | null> {
    if (!value) return null;
    return this.decrypt(value);
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      const test = 'health-check';
      const encrypted = await this.encrypt(test);
      const decrypted = await this.decrypt(encrypted);
      return decrypted === test;
    } catch {
      return false;
    }
  }
}
