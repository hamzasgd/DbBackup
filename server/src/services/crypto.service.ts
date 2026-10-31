/**
 * Credential encryption — thin facade over the KeyManager
 * (server/src/services/crypto/key-manager.ts).
 *
 * Format: versioned ciphertext `<keyVersion>:<base64 JSON envelope>`
 * (AES-256-GCM). Legacy unversioned blobs still decrypt, so existing
 * rows keep working across upgrades and key rotations.
 *
 * Key sources (first match wins):
 *   1. KMS_WRAPPED_MASTER_KEY  — master key unwrapped from AWS KMS at boot,
 *      memory-only. Kill switch: revoke IAM / KMS key policy and stolen
 *      ciphertext is permanently unusable.
 *   2. ENCRYPTION_KEY_PRIMARY (+ ENCRYPTION_KEY_V1..Vn for rotation)
 *   3. ENCRYPTION_KEY          — legacy single key (still decrypts old rows)
 *
 * Call initCrypto() once at boot (index.ts) before anything decrypts.
 */

export { encrypt, decrypt, encryptIfPresent, decryptIfPresent, getKeyManager } from './crypto/key-manager';

import { getKeyManager } from './crypto/key-manager';

/** Unwrap the KMS master key if configured (no-op otherwise). */
export async function initCrypto(): Promise<void> {
  await getKeyManager().initializeFromKms();
}
