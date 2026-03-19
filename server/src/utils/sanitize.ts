export function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['password', 'sshPrivateKey', 'sshPassphrase', 'secretAccessKey', 'accessKeyId'];
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