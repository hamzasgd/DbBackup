# DbBackup Security Improvement Plan

## Executive Summary

This plan addresses security vulnerabilities and hardening measures for the DbBackup application, focusing on credential protection, access control, and audit capabilities.

---

## 1. Encryption Key Management

### Problem Statement

The current implementation uses a single `ENCRYPTION_KEY` environment variable that:
- Must be 64 hex characters (32 bytes)
- Is used directly for all encryption operations
- Has no rotation mechanism
- If compromised, exposes all stored database credentials

### Risk Assessment

| Scenario | Impact | Likelihood |
|----------|--------|------------|
| Developer accidentally commits key | HIGH | MEDIUM |
| Server breach exposes env vars | HIGH | LOW |
| Key leaked in logs/dumps | HIGH | LOW |
| Insider threat | HIGH | MEDIUM |

### Recommended Improvements

#### 1.1 Key Rotation Mechanism - **HIGH PRIORITY**

**Implementation:**

```typescript
// server/src/services/crypto.service.ts

// Support multiple active keys for rotation
interface KeyVersion {
  id: string;
  key: Buffer;
  createdAt: Date;
  isPrimary: boolean;
}

class KeyManager {
  private keys: Map<string, KeyVersion> = new Map();
  private primaryKeyId: string;

  constructor() {
    // Load keys from environment: ENCRYPTION_KEY_PRIMARY, ENCRYPTION_KEY_V1, etc.
    this.loadKeys();
  }

  private loadKeys(): void {
    const primary_key = process.env.ENCRYPTION_KEY_PRIMARY;
    if (primary_key) {
      this.addKey('primary', primary_key, true);
    }
    
    // Legacy key support during rotation
    const legacyKey = process.env.ENCRYPTION_KEY;
    if (legacyKey) {
      this.addKey('legacy', legacyKey, false);
    }
  }

  getPrimaryKey(): Buffer {
    return this.keys.get(this.primaryKeyId)!.key;
  }

  // Encrypt with primary key
  encrypt(plaintext: string): string {
    const keyVersion = this.primaryKeyId;
    const encrypted = this.encryptWithKey(plaintext, this.getPrimaryKey());
    return `${keyVersion}:${encrypted}`;
  }

  // Decrypt with appropriate key based on version prefix
  decrypt(ciphertext: string): string {
    const [version, data] = ciphertext.split(':');
    const keyVersion = this.keys.get(version);
    if (!keyVersion) {
      throw new Error(`Unknown key version: ${version}`);
    }
    return this.decryptWithKey(data, keyVersion.key);
  }
}
```

**Migration Path:**
1. Add `ENCRYPTION_KEY_PRIMARY` environment variable
2. Keep `ENCRYPTION_KEY` as fallback for existing encrypted data
3. New encryptions use primary key with version prefix
4. Decryptions detect version and use appropriate key
5. Background job re-encrypts legacy data with primary key
6. Remove legacy key after all data migrated

**Complexity:** MEDIUM - Requires careful migration but low risk

---

#### 1.2 Hardware Security Module (HSM) / Cloud KMS - **MEDIUM PRIORITY**

For production deployments, consider using managed key services:

| Provider | Service | Benefit |
|----------|---------|---------|
| AWS | KMS | Automatic key rotation, audit logging |
| Azure | Key Vault | HSM-backed keys, access policies |
| GCP | Cloud KMS | Integrated with IAM |
| Self-hosted | HashiCorp Vault | Multi-cloud, secret leasing |

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Application                                │
│  ┌─────────────────────┐                                            │
│  │   CryptoProvider    │                                            │
│  │   (Interface)       │                                            │
│  └──────────┬──────────┘                                            │
│             │                                                        │
│  ┌──────────▼──────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  LocalCryptoProvider│  │ AWSKMSProvider  │  │ VaultProvider   │  │
│  │  (Development)      │  │ (AWS Deploy)    │  │ (Self-hosted)   │  │
│  └─────────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**Implementation:**

##### 1.2.1 Crypto Provider Interface

```typescript
// server/src/services/crypto/crypto.provider.ts

/**
 * Abstract crypto provider interface
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
      return new AWSKMSCryptoProvider();
    case 'azure-keyvault':
    case 'azure':
      return new AzureKeyVaultCryptoProvider();
    case 'gcp-kms':
    case 'gcp':
      return new GCPCryptoProvider();
    case 'vault':
    case 'hashicorp-vault':
      return new HashiCorpVaultCryptoProvider();
    case 'local':
    default:
      if (process.env.NODE_ENV === 'production') {
        console.warn('WARNING: Using local crypto provider in production. Consider using a managed KMS.');
      }
      return new LocalCryptoProvider();
  }
}
```

##### 1.2.2 AWS KMS Provider

```typescript
// server/src/services/crypto/providers/aws-kms.provider.ts

import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { CryptoProvider } from '../crypto.provider';
import { logger } from '../../config/logger';

export class AWSKMSCryptoProvider implements CryptoProvider {
  readonly name = 'aws-kms';
  private client: KMSClient;
  private keyId: string;

  constructor() {
    this.client = new KMSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
    this.keyId = process.env.AWS_KMS_KEY_ID || '';
    
    if (!this.keyId) {
      throw new Error('AWS_KMS_KEY_ID environment variable is required for AWS KMS provider');
    }
  }

  async encrypt(plaintext: string): Promise<string> {
    try {
      const command = new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: Buffer.from(plaintext, 'utf8'),
      });

      const response = await this.client.send(command);
      
      // Return base64-encoded ciphertext blob
      return Buffer.from(response.CiphertextBlob!).toString('base64');
    } catch (error) {
      logger.error('AWS KMS encryption failed:', error);
      throw new Error('Encryption failed');
    }
  }

  async decrypt(ciphertext: string): Promise<string> {
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
      // Try to encrypt/decrypt a test value
      const test = 'health-check';
      const encrypted = await this.encrypt(test);
      const decrypted = await this.decrypt(encrypted);
      return decrypted === test;
    } catch {
      return false;
    }
  }
}
```

**AWS KMS Setup:**

```bash
# 1. Create KMS key
aws kms create-key --description "DbBackup encryption key" --tags TagKey=Application,TagValue=DbBackup

# 2. Note the KeyId from response and set environment variables
export AWS_KMS_KEY_ID="alias/dbbackup-encryption"
export AWS_REGION="us-east-1"
export CRYPTO_PROVIDER="aws-kms"

# 3. IAM policy for the application
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:GenerateDataKey"
      ],
      "Resource": "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012"
    }
  ]
}
```

##### 1.2.3 HashiCorp Vault Provider

```typescript
// server/src/services/crypto/providers/vault.provider.ts

import Vault from 'hashicorp-vault-js';
import { CryptoProvider } from '../crypto.provider';
import { logger } from '../../config/logger';

export class HashiCorpVaultCryptoProvider implements CryptoProvider {
  readonly name = 'hashicorp-vault';
  private vault: Vault;
  private keyName: string;
  private mountPath: string;

  constructor() {
    this.vault = new Vault({
      api: {
        url: process.env.VAULT_ADDR || 'http://localhost:8200',
      },
      auth: {
        token: process.env.VAULT_TOKEN,
        // Or use AppRole for production
        roleId: process.env.VAULT_ROLE_ID,
        secretId: process.env.VAULT_SECRET_ID,
      },
    });
    
    this.keyName = process.env.VAULT_KEY_NAME || 'dbbackup-encryption';
    this.mountPath = process.env.VAULT_MOUNT_PATH || 'transit';
  }

  async encrypt(plaintext: string): Promise<string> {
    try {
      // Use Vault Transit secrets engine
      const response = await this.vault.transit.encrypt(
        this.mountPath,
        this.keyName,
        Buffer.from(plaintext).toString('base64')
      );

      return response.data.ciphertext;
    } catch (error) {
      logger.error('Vault encryption failed:', error);
      throw new Error('Encryption failed');
    }
  }

  async decrypt(ciphertext: string): Promise<string> {
    try {
      const response = await this.vault.transit.decrypt(
        this.mountPath,
        this.keyName,
        ciphertext
      );

      return Buffer.from(response.data.plaintext, 'base64').toString('utf8');
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
      const response = await this.vault.health();
      return response.data.initialized && !response.data.sealed;
    } catch {
      return false;
    }
  }
}
```

**Vault Setup:**

```bash
# 1. Enable Transit secrets engine
vault secrets enable transit

# 2. Create encryption key
vault write -f transit/keys/dbbackup-encryption type=aes256-gcm96

# 3. Create policy for application
vault policy write dbbackup-policy - <<EOF
path "transit/encrypt/dbbackup-encryption" {
  capabilities = ["update"]
}
path "transit/decrypt/dbbackup-encryption" {
  capabilities = ["update"]
}
EOF

# 4. Create AppRole for application
vault auth enable approle
vault write auth/approle/role/dbbackup policies=dbbackup-policy
vault read auth/approle/role/dbbackup/role-id
vault write -f auth/approle/role/dbbackup/secret-id

# 5. Set environment variables
export VAULT_ADDR="https://vault.example.com:8200"
export VAULT_ROLE_ID="your-role-id"
export VAULT_SECRET_ID="your-secret-id"
export VAULT_KEY_NAME="dbbackup-encryption"
export CRYPTO_PROVIDER="vault"
```

##### 1.2.4 Azure Key Vault Provider

```typescript
// server/src/services/crypto/providers/azure-keyvault.provider.ts

import { DefaultAzureCredential } from '@azure/identity';
import { CryptographyClient, KeyClient } from '@azure/keyvault-keys';
import { CryptoProvider } from '../crypto.provider';
import { logger } from '../../config/logger';

export class AzureKeyVaultCryptoProvider implements CryptoProvider {
  readonly name = 'azure-keyvault';
  private cryptoClient: CryptographyClient;
  private keyName: string;

  constructor() {
    const vaultUrl = process.env.AZURE_KEYVAULT_URL;
    if (!vaultUrl) {
      throw new Error('AZURE_KEYVAULT_URL environment variable is required');
    }

    this.keyName = process.env.AZURE_KEYVAULT_KEY_NAME || 'dbbackup-encryption';
    
    const credential = new DefaultAzureCredential();
    const keyClient = new KeyClient(vaultUrl, credential);
    
    // Get key and create crypto client
    this.initializeCryptoClient(keyClient);
  }

  private async initializeCryptoClient(keyClient: KeyClient): Promise<void> {
    const key = await keyClient.getKey(this.keyName);
    this.cryptoClient = keyClient.getCryptographyClient(key.name, key.properties.version);
  }

  async encrypt(plaintext: string): Promise<string> {
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
      const test = 'health-check';
      const encrypted = await this.encrypt(test);
      const decrypted = await this.decrypt(encrypted);
      return decrypted === test;
    } catch {
      return false;
    }
  }
}
```

##### 1.2.5 Migration Strategy

When migrating from local encryption to KMS:

```typescript
// server/src/services/crypto/migration.service.ts

export class CryptoMigrationService {
  private oldProvider: CryptoProvider;
  private newProvider: CryptoProvider;

  async migrateAllCredentials(): Promise<{ success: number; failed: number }> {
    const connections = await prisma.connection.findMany();
    let success = 0;
    let failed = 0;

    for (const conn of connections) {
      try {
        // Decrypt with old provider
        const decrypted = {
          host: await this.oldProvider.decrypt(conn.host),
          username: await this.oldProvider.decrypt(conn.username),
          password: await this.oldProvider.decrypt(conn.password),
          database: await this.oldProvider.decrypt(conn.database),
        };

        // Re-encrypt with new provider
        const reEncrypted = {
          host: await this.newProvider.encrypt(decrypted.host),
          username: await this.newProvider.encrypt(decrypted.username),
          password: await this.newProvider.encrypt(decrypted.password),
          database: await this.newProvider.encrypt(decrypted.database),
        };

        // Update in database
        await prisma.connection.update({
          where: { id: conn.id },
          data: reEncrypted,
        });

        success++;
      } catch (error) {
        logger.error(`Failed to migrate connection ${conn.id}:`, error);
        failed++;
      }
    }

    return { success, failed };
  }
}
```

**Complexity:** HIGH - Requires infrastructure changes

---

## 2. Credential Access Auditing

### Problem Statement

Currently, credentials are decrypted without any audit trail. There's no way to know:
- Who accessed credentials
- When they were accessed
- How often they're being accessed
- If there's suspicious access patterns

### Recommended Improvements

#### 2.1 Credential Access Logging - **HIGH PRIORITY**

**Implementation:**

```typescript
// server/src/services/credential-audit.service.ts

interface CredentialAccessLog {
  id: string;
  connectionId: string;
  userId: string;
  action: 'DECRYPT' | 'TEST' | 'BACKUP' | 'RESTORE' | 'SYNC';
  ipAddress: string;
  timestamp: Date;
  success: boolean;
}

class CredentialAuditService {
  async logAccess(
    connectionId: string,
    userId: string,
    action: CredentialAccessLog['action'],
    req: Request
  ): Promise<void> {
    await prisma.credentialAccessLog.create({
      data: {
        connectionId,
        userId,
        action,
        ipAddress: req.ip,
        timestamp: new Date(),
        success: true,
      },
    });
  }

  async detectAnomalousAccess(connectionId: string): Promise<boolean> {
    // Check for unusual access patterns
    const recentAccesses = await prisma.credentialAccessLog.findMany({
      where: {
        connectionId,
        timestamp: { gte: new Date(Date.now() - 3600000) }, // Last hour
      },
    });

    // Alert if more than 100 accesses in an hour
    return recentAccesses.length > 100;
  }
}
```

**Database Schema Addition:**

```prisma
model CredentialAccessLog {
  id           String   @id @default(uuid())
  connectionId String
  connection   Connection @relation(fields: [connectionId], references: [id], onDelete: Cascade)
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  action       String   // DECRYPT, TEST, BACKUP, RESTORE, SYNC
  ipAddress    String?
  timestamp    DateTime @default(now())
  success      Boolean  @default(true)

  @@index([connectionId, timestamp])
  @@map("credential_access_logs")
}
```

**Complexity:** LOW - Simple logging with database table

---

#### 2.2 Access Rate Limiting - **MEDIUM PRIORITY**

Prevent credential scraping attacks:

```typescript
// server/src/middleware/credential-rate-limit.ts

const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per window per user
  keyGenerator: (req) => `cred:${req.user!.userId}`,
  handler: (req, res) => {
    logger.warn(`Credential rate limit exceeded for user ${req.user!.userId}`);
    res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many credential requests' }
    });
  },
});
```

**Complexity:** LOW - Standard rate limiting pattern

---

## 3. Memory Security

### Problem Statement

Decrypted credentials exist in memory and could be exposed through:
- Memory dumps
- Heap snapshots
- Debugger attachment
- Swap file

### Recommended Improvements

#### 3.1 Secure Memory Handling - **MEDIUM PRIORITY**

**Implementation:**

```typescript
// server/src/services/secure-credentials.ts

class SecureCredential {
  private buffer: Buffer;
  private length: number;

  constructor(value: string) {
    // Allocate buffer and copy value
    this.length = Buffer.byteLength(value, 'utf8');
    this.buffer = Buffer.alloc(this.length);
    this.buffer.write(value, 'utf8');
  }

  // Use credential for a single operation, then clear
  async use<T>(fn: (value: string) => Promise<T>): Promise<T> {
    const value = this.buffer.toString('utf8', 0, this.length);
    try {
      return await fn(value);
    } finally {
      // Overwrite buffer with zeros
      this.buffer.fill(0);
      value = ''; // Clear reference
    }
  }

  // Clear immediately after use
  destroy(): void {
    if (this.buffer) {
      this.buffer.fill(0);
      this.buffer = Buffer.alloc(0);
    }
  }
}
```

**Complexity:** MEDIUM - Requires refactoring credential usage patterns

---

#### 3.2 Prevent Credential Logging - **LOW PRIORITY**

Add safeguards to prevent accidental logging:

```typescript
// server/src/config/logger.ts

// Redact sensitive fields from logs
const sensitiveFields = ['password', 'sshPrivateKey', 'sshPassphrase', 'sslKey'];

function redactSensitive(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;
  
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (sensitiveFields.some(f => key.toLowerCase().includes(f.toLowerCase()))) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object') {
      result[key] = redactSensitive(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
```

**Complexity:** LOW - Simple middleware addition

---

## 4. Backup Security

### Problem Statement

Database backups contain encrypted credentials. If both the backup and encryption key are compromised, all credentials are exposed.

### Recommended Improvements

#### 4.1 Separate Key Storage - **MEDIUM PRIORITY**

Store encryption keys separately from database:

| Option | Description | Security |
|--------|-------------|----------|
| Environment variables | Current approach | LOW |
| Secret file | Mounted volume | MEDIUM |
| Cloud KMS | Managed service | HIGH |
| HSM | Hardware module | HIGHEST |

**Implementation:**

```yaml
# docker-compose.yml
services:
  app:
    environment:
      - ENCRYPTION_KEY_PRIMARY_FILE=/run/secrets/encryption_key
    secrets:
      - encryption_key

secrets:
  encryption_key:
    file: ./secrets/encryption_key.txt
```

**Complexity:** LOW - Configuration change only

---

#### 4.2 Backup Encryption - **MEDIUM PRIORITY**

Encrypt database backups with a separate key:

```typescript
// server/src/services/backup-encryption.service.ts

class BackupEncryptionService {
  private backupKey: Buffer;

  constructor() {
    // Separate key for backup encryption
    this.backupKey = this.loadBackupKey();
  }

  async encryptBackup(backupPath: string): Promise<string> {
    // Encrypt backup with backup-specific key
    // Store backup key in KMS or separate location
  }
}
```

**Complexity:** MEDIUM - Requires key management infrastructure

---

## 5. Connection Security

### Problem Statement

Database connections may be vulnerable to:
- Man-in-the-middle attacks
- Credential interception
- Network sniffing

### Recommended Improvements

#### 5.1 Enforce SSL/TLS - **MEDIUM PRIORITY**

```typescript
// server/src/services/engines/connection-validator.ts

function validateSSLConfiguration(config: ConnectionConfig): void {
  if (!config.sslEnabled) {
    logger.warn(`Connection ${config.id} does not have SSL enabled`);
    
    // Optionally enforce SSL for production
    if (process.env.NODE_ENV === 'production' && process.env.ENFORCE_SSL === 'true') {
      throw new Error('SSL is required for database connections in production');
    }
  }
}
```

**Complexity:** LOW - Configuration validation

---

#### 5.2 SSH Tunnel Hardening - **LOW PRIORITY**

```typescript
// server/src/services/ssh.service.ts

// Add SSH key validation
function validateSSHKey(privateKey: string): boolean {
  // Check key format
  if (!privateKey.includes('BEGIN OPENSSH PRIVATE KEY') && 
      !privateKey.includes('BEGIN RSA PRIVATE KEY')) {
    return false;
  }
  
  // Check minimum key size (2048 bits for RSA)
  // This is a basic check; proper validation would parse the key
  return privateKey.length >= 1600;
}
```

**Complexity:** LOW - Input validation

---

## Implementation Priority Matrix

| Task | Priority | Complexity | Dependencies | Impact |
|------|----------|------------|--------------|--------|
| 1.1 Key Rotation | HIGH | MEDIUM | None | HIGH |
| 2.1 Credential Access Logging | HIGH | LOW | None | HIGH |
| 2.2 Access Rate Limiting | MEDIUM | LOW | None | MEDIUM |
| 3.1 Secure Memory Handling | MEDIUM | MEDIUM | None | MEDIUM |
| 3.2 Prevent Credential Logging | LOW | LOW | None | LOW |
| 4.1 Separate Key Storage | MEDIUM | LOW | None | MEDIUM |
| 4.2 Backup Encryption | MEDIUM | MEDIUM | 4.1 | MEDIUM |
| 5.1 Enforce SSL/TLS | MEDIUM | LOW | None | MEDIUM |
| 5.2 SSH Tunnel Hardening | LOW | LOW | None | LOW |
| 1.2 HSM/Cloud KMS | MEDIUM | HIGH | None | HIGH |

---

## Recommended Implementation Order

### Phase 1: Immediate Security Improvements
1. **2.1 Credential Access Logging** - Add audit trail
2. **3.2 Prevent Credential Logging** - Redact sensitive data
3. **4.1 Separate Key Storage** - Move keys to secrets

### Phase 2: Key Management
4. **1.1 Key Rotation** - Enable key rotation mechanism
5. **2.2 Access Rate Limiting** - Prevent scraping

### Phase 3: Hardening
6. **5.1 Enforce SSL/TLS** - Production SSL requirement
7. **3.1 Secure Memory Handling** - Reduce memory exposure
8. **5.2 SSH Tunnel Hardening** - Validate SSH keys

### Phase 4: Advanced Security
9. **4.2 Backup Encryption** - Separate backup keys
10. **1.2 HSM/Cloud KMS** - Managed key services

---

## Architecture Diagram

```mermaid
graph TB
    subgraph Current State
        ENV[Environment Variables]
        DB[(Database)]
        APP[Application]
        ENV --> APP
        DB --> APP
    end
    
    subgraph Target State
        SECRETS[Docker Secrets / K8s Secrets]
        KMS[Cloud KMS / Vault]
        AUDIT[(Audit Logs)]
        APP2[Application]
        DB2[(Database)]
        
        SECRETS --> APP2
        KMS --> APP2
        DB2 --> APP2
        APP2 --> AUDIT
    end
    
    Current State --> Target State
```

---

## Questions for Discussion

1. **Compliance Requirements**: Are there specific compliance requirements (SOC2, HIPAA, PCI-DSS) that need to be addressed?

2. **Infrastructure**: Is the application deployed on AWS, Azure, GCP, or self-hosted? This affects KMS recommendations.

3. **Key Rotation Policy**: What is the desired key rotation frequency? (30 days, 90 days, annual)

4. **Audit Retention**: How long should credential access logs be retained?

5. **Production Timeline**: When do these security improvements need to be in production?
