import { CryptoProvider } from '../crypto.provider';
import { logger } from '../../../config/logger';

/**
 * HashiCorp Vault Crypto Provider
 * Uses Vault Transit secrets engine for encryption/decryption
 */
export class HashiCorpVaultCryptoProvider implements CryptoProvider {
  readonly name = 'hashicorp-vault';
  private vaultUrl: string;
  private token: string;
  private keyName: string;
  private mountPath: string;

  constructor() {
    this.vaultUrl = process.env.VAULT_ADDR || 'http://localhost:8200';
    this.token = process.env.VAULT_TOKEN || '';
    this.keyName = process.env.VAULT_KEY_NAME || 'dbbackup-encryption';
    this.mountPath = process.env.VAULT_MOUNT_PATH || 'transit';

    if (!this.token) {
      throw new Error('VAULT_TOKEN environment variable is required for HashiCorp Vault provider');
    }
  }

  private async makeRequest(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = `${this.vaultUrl}/v1/${path}`;
    const options: RequestInit = {
      method,
      headers: {
        'X-Vault-Token': this.token,
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json() as { data?: Record<string, unknown>; errors?: unknown[] };

    if (response.ok && data.data) {
      return data.data as Record<string, unknown>;
    } else if (data.errors) {
      throw new Error(`Vault error: ${JSON.stringify(data.errors)}`);
    } else {
      throw new Error(`Vault request failed: ${response.statusText}`);
    }
  }

  async encrypt(plaintext: string): Promise<string> {
    try {
      const plaintextBase64 = Buffer.from(plaintext).toString('base64');
      const result = await this.makeRequest('POST', `${this.mountPath}/encrypt/${this.keyName}`, {
        plaintext: plaintextBase64,
      });

      return result.ciphertext as string;
    } catch (error) {
      logger.error('Vault encryption failed:', error);
      throw new Error('Encryption failed');
    }
  }

  async decrypt(ciphertext: string): Promise<string> {
    try {
      const result = await this.makeRequest('POST', `${this.mountPath}/decrypt/${this.keyName}`, {
        ciphertext,
      });

      const plaintextBase64 = result.plaintext as string;
      return Buffer.from(plaintextBase64, 'base64').toString('utf8');
    } catch (error) {
      logger.error('Vault decryption failed:', error);
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
      const response = await fetch(`${this.vaultUrl}/v1/sys/health`, {
        headers: { 'X-Vault-Token': this.token },
      });
      const data = await response.json() as { initialized?: boolean; sealed?: boolean };
      return response.ok && data.initialized === true && data.sealed === false;
    } catch {
      return false;
    }
  }
}
