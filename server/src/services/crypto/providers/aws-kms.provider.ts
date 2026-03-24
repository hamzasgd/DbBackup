import { CryptoProvider } from '../crypto.provider';
import { logger } from '../../../config/logger';

// Dynamic import to avoid requiring AWS SDK when not used
// Using any types since dynamic import loses type information
let KMSClient: any = null;
let EncryptCommand: any = null;
let DecryptCommand: any = null;

async function loadAWSSDK(): Promise<void> {
  if (KMSClient) return;

  try {
    const kms = await import('@aws-sdk/client-kms');
    KMSClient = kms.KMSClient;
    EncryptCommand = kms.EncryptCommand;
    DecryptCommand = kms.DecryptCommand;
  } catch (error) {
    throw new Error('AWS KMS provider requires @aws-sdk/client-kms package. Install it with: npm install @aws-sdk/client-kms');
  }
}

/**
 * AWS KMS Crypto Provider
 * Requires @aws-sdk/client-kms package
 */
export class AWSKMSCryptoProvider implements CryptoProvider {
  readonly name = 'aws-kms';
  private client: any = null;
  private keyId: string;
  private initialized: boolean = false;

  constructor() {
    this.keyId = process.env.AWS_KMS_KEY_ID || '';

    if (!this.keyId) {
      throw new Error('AWS_KMS_KEY_ID environment variable is required for AWS KMS provider');
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await loadAWSSDK();

    if (!KMSClient || !EncryptCommand || !DecryptCommand) {
      throw new Error('AWS KMS SDK not properly loaded');
    }

    this.client = new KMSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
    this.initialized = true;
  }

  async encrypt(plaintext: string): Promise<string> {
    await this.ensureInitialized();

    try {
      const command = new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(plaintext, 'utf8'),
      });

      const response = await this.client.send(command);

      return Buffer.from(response.CiphertextBlob!).toString('base64');
    } catch (error) {
      logger.error('AWS KMS encryption failed:', error);
      throw new Error('Encryption failed');
    }
  }

  async decrypt(ciphertext: string): Promise<string> {
    await this.ensureInitialized();

    try {
      const command = new DecryptCommand({
        CiphertextBlob: Buffer.from(ciphertext, 'base64'),
      });

      const response = await this.client.send(command);

      return Buffer.from(response.Plaintext!).toString('utf8');
    } catch (error) {
      logger.error('AWS KMS decryption failed:', error);
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
