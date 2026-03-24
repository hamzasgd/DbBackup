import { CryptoProvider } from '../crypto.provider';
import { logger } from '../../../config/logger';

// Dynamic import to avoid requiring Azure SDK when not used
let DefaultAzureCredential: any = null;
let KeyClient: any = null;

async function loadAzureSDK(): Promise<void> {
  if (DefaultAzureCredential) return;

  try {
    const azure = await import('@azure/identity');
    const keyvault = await import('@azure/keyvault-keys');
    DefaultAzureCredential = azure.DefaultAzureCredential;
    KeyClient = keyvault.KeyClient;
  } catch (error) {
    throw new Error('Azure Key Vault provider requires @azure/identity and @azure/keyvault-keys packages. Install them with: npm install @azure/identity @azure/keyvault-keys');
  }
}

/**
 * Azure Key Vault Crypto Provider
 * Requires @azure/identity and @azure/keyvault-keys packages
 */
export class AzureKeyVaultCryptoProvider implements CryptoProvider {
  readonly name = 'azure-keyvault';
  private cryptoClient: any = null;
  private keyName: string;
  private initialized: boolean = false;

  constructor() {
    const vaultUrl = process.env.AZURE_KEYVAULT_URL;

    if (!vaultUrl) {
      throw new Error('AZURE_KEYVAULT_URL environment variable is required for Azure Key Vault provider');
    }

    this.keyName = process.env.AZURE_KEYVAULT_KEY_NAME || 'dbbackup-encryption';
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    await loadAzureSDK();

    if (!DefaultAzureCredential || !KeyClient) {
      throw new Error('Azure SDK not properly loaded');
    }

    const credential = new DefaultAzureCredential();
    const keyClient = new KeyClient(process.env.AZURE_KEYVAULT_URL!, credential);
    const key = await keyClient.getKey(this.keyName);
    this.cryptoClient = keyClient.getCryptographyClient(key.name, key.properties.version);
    this.initialized = true;
  }

  async encrypt(plaintext: string): Promise<string> {
    await this.ensureInitialized();

    try {
      const result = await this.cryptoClient.encrypt({
        algorithm: 'RSA-OAEP-256',
        plaintext: Buffer.from(plaintext, 'utf8'),
      });

      return Buffer.from(result.result).toString('base64');
    } catch (error) {
      logger.error('Azure Key Vault encryption failed:', error);
      throw new Error('Encryption failed');
    }
  }

  async decrypt(ciphertext: string): Promise<string> {
    await this.ensureInitialized();

    try {
      const result = await this.cryptoClient.decrypt({
        algorithm: 'RSA-OAEP-256',
        ciphertext: Buffer.from(ciphertext, 'base64'),
      });

      return Buffer.from(result.result).toString('utf8');
    } catch (error) {
      logger.error('Azure Key Vault decryption failed:', error);
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
