export function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['password', 'passphrase', 'sshPrivateKey', 'sshPassphrase', 'secretAccessKey', 'accessKeyId', 'sslCa', 'sslCert', 'sslKey', 'credential', 'privateKey'];
  const result: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(config)) {
    const lowerKey = key.toLowerCase();
    if (
      sensitiveKeys.some(sk => lowerKey.includes(sk.toLowerCase())) ||
      lowerKey.includes('secret') ||
      lowerKey.includes('key')
    ) {
      result[key] = '••••••••';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeConfig(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/** Strip CR/LF (and other control chars) so a user-supplied value can't forge extra log lines. */
export function sanitizeForLog(value: unknown): string {
  return String(value).replace(/[\r\n\u0000-\u001f\u007f]/g, '');
}
