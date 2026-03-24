import { logger } from '../../config/logger';
import { ConnectionConfig } from '../../services/engines/base.engine';

/**
 * Validates database connection configurations for security compliance.
 * Enforces SSL/TLS requirements and SSH key validation.
 */
export class ConnectionValidatorService {
  /**
   * Validate SSL configuration for a connection
   */
  validateSSLConfiguration(config: ConnectionConfig): { valid: boolean; warnings: string[]; errors: string[] } {
    const warnings: string[] = [];
    const errors: string[] = [];

    // Warn if SSL is not enabled for non-local connections
    if (!config.sslEnabled && config.host !== 'localhost' && config.host !== '127.0.0.1') {
      warnings.push(
        `Connection to ${config.host} does not have SSL enabled. ` +
        'Credentials and data may be transmitted in cleartext over the network.'
      );
    }

    // In production, enforce SSL for non-local connections
    if (process.env.NODE_ENV === 'production' && process.env.ENFORCE_SSL === 'true') {
      if (!config.sslEnabled && config.host !== 'localhost' && config.host !== '127.0.0.1') {
        errors.push(
          'SSL is required for database connections in production. ' +
          'Set sslEnabled: true or disable ENFORCE_SSL for non-production environments.'
        );
      }
    }

    return { valid: errors.length === 0, warnings, errors };
  }

  /**
   * Validate SSH key format and strength
   */
  validateSSHKey(privateKey: string | null | undefined): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!privateKey) {
      return { valid: true, errors: [] }; // SSH key is optional
    }

    // Check key format
    const validFormats = [
      'BEGIN OPENSSH PRIVATE KEY',
      'BEGIN RSA PRIVATE KEY',
      'BEGIN DSA PRIVATE KEY',
      'BEGIN EC PRIVATE KEY',
      'BEGIN PRIVATE KEY',
    ];

    const hasValidFormat = validFormats.some(format =>
      privateKey.includes(format)
    );

    if (!hasValidFormat) {
      errors.push('Invalid SSH private key format. Expected OpenSSH, RSA, DSA, EC, or PKCS8 format.');
      return { valid: false, errors };
    }

    // Check minimum key length for RSA/DSA/EC
    if (privateKey.includes('BEGIN RSA PRIVATE KEY') || privateKey.includes('BEGIN OPENSSH PRIVATE KEY')) {
      // Extract key content and check base64 length as a rough proxy for key strength
      const base64Content = privateKey
        .replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----/, '')
        .replace(/-----END [A-Z ]+ PRIVATE KEY-----/, '')
        .replace(/\s/g, '');

      if (base64Content.length < 500) {
        errors.push('SSH private key appears to be too short. Minimum 2048-bit RSA recommended.');
      }
    }

    // Check for passphrase requirement (good security practice)
    // This is just informational - we don't require passphrase
    if (!privateKey.includes('ENCRYPTED')) {
      logger.debug('SSH private key has no passphrase. Consider adding a passphrase for additional security.');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate all security aspects of a connection
   */
  validateConnection(config: ConnectionConfig): {
    valid: boolean;
    warnings: string[];
    errors: string[];
  } {
    const allWarnings: string[] = [];
    const allErrors: string[] = [];

    // Validate SSL
    const sslResult = this.validateSSLConfiguration(config);
    allWarnings.push(...sslResult.warnings);
    allErrors.push(...sslResult.errors);

    // Validate SSH key if SSH is enabled
    if (config.sshEnabled) {
      const sshResult = this.validateSSHKey(config.sshPrivateKey ?? null);
      allErrors.push(...sshResult.errors);
    }

    // Warn about connection timeout too low
    if (config.connectionTimeout && config.connectionTimeout < 5000) {
      allWarnings.push('Connection timeout is very low (< 5s). This may cause issues with slow networks.');
    }

    return {
      valid: allErrors.length === 0,
      warnings: allWarnings,
      errors: allErrors,
    };
  }
}

export const connectionValidator = new ConnectionValidatorService();
