/**
 * Abstract crypto provider interface.
 * Implementations: Local, AWS KMS, Azure Key Vault, HashiCorp Vault
 */
export interface CryptoProvider {
  /** Provider name for logging/debugging */
  readonly name: string;

  /** Encrypt plaintext string */
  encrypt(plaintext: string): Promise<string>;

  /** Decrypt ciphertext string */
  decrypt(ciphertext: string): Promise<string>;

  /** Encrypt only if value is present (convenience method) */
  encryptIfPresent(value: string | null | undefined): Promise<string | null>;

  /** Decrypt only if value is present (convenience method) */
  decryptIfPresent(value: string | null | undefined): Promise<string | null>;

  /** Check if provider is healthy and accessible */
  healthCheck(): Promise<boolean>;
}

/**
 * Factory function to create the appropriate crypto provider
 */
export function createCryptoProvider(): CryptoProvider {
  const provider = process.env.CRYPTO_PROVIDER?.toLowerCase() || 'local';

  switch (provider) {
    case 'aws-kms':
    case 'aws':
      // Lazy load to avoid requiring AWS SDK in all environments
      return createAWSKMSProvider();
    case 'azure-keyvault':
    case 'azure':
      return createAzureKeyVaultProvider();
    case 'gcp-kms':
    case 'gcp':
      return createGCPKMSProvider();
    case 'vault':
    case 'hashicorp-vault':
      return createHashiCorpVaultProvider();
    case 'local':
    default:
      if (process.env.NODE_ENV === 'production') {
        console.warn('WARNING: Using local crypto provider in production. Consider using a managed KMS.');
      }
      return createLocalCryptoProvider();
  }
}

// Provider creators (lazy loaded)
function createLocalCryptoProvider(): CryptoProvider {
  // Lazy import to avoid circular dependency
  const { KeyManager } = require('./key-manager');
  const km = new KeyManager();

  return {
    name: 'local',
    async encrypt(plaintext: string): Promise<string> {
      return km.encrypt(plaintext);
    },
    async decrypt(ciphertext: string): Promise<string> {
      return km.decrypt(ciphertext);
    },
    async encryptIfPresent(value: string | null | undefined): Promise<string | null> {
      if (!value) return null;
      return km.encrypt(value);
    },
    async decryptIfPresent(value: string | null | undefined): Promise<string | null> {
      if (!value) return null;
      return km.decrypt(value);
    },
    async healthCheck(): Promise<boolean> {
      try {
        // Test encryption/decryption
        const test = 'health-check';
        const encrypted = km.encrypt(test);
        const decrypted = km.decrypt(encrypted);
        return decrypted === test;
      } catch {
        return false;
      }
    },
  };
}

function createAWSKMSProvider(): CryptoProvider {
  // Dynamically import to avoid requiring AWS SDK when not used
  const { AWSKMSCryptoProvider } = require('./providers/aws-kms.provider');
  return new AWSKMSCryptoProvider();
}

function createAzureKeyVaultProvider(): CryptoProvider {
  const { AzureKeyVaultCryptoProvider } = require('./providers/azure-keyvault.provider');
  return new AzureKeyVaultCryptoProvider();
}

function createGCPKMSProvider(): CryptoProvider {
  const { GCPCryptoProvider } = require('./providers/gcp-kms.provider');
  return new GCPCryptoProvider();
}

function createHashiCorpVaultProvider(): CryptoProvider {
  const { HashiCorpVaultCryptoProvider } = require('./providers/vault.provider');
  return new HashiCorpVaultCryptoProvider();
}
