import winston from 'winston';

// Sensitive fields that should be redacted from logs
const SENSITIVE_FIELDS = [
  'password',
  'passwordHash',
  'sshPrivateKey',
  'sshPassphrase',
  'sslKey',
  'sslCert',
  'sslCa',
  'secretAccessKey',
  'accessKeyId',
  'token',
  'authorization',
  'cookie',
  'apiKey',
  'apiSecret',
  'privateKey',
  'passphrase',
  'connectionString',
  'credentials',
];

/**
 * Recursively redact sensitive fields from an object
 */
function redactSensitive(obj: unknown, depth: number = 0): unknown {
  if (depth > 10 || obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => redactSensitive(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  const record = obj as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_FIELDS.some(field =>
      lowerKey.includes(field.toLowerCase())
    );

    if (isSensitive) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitive(value, depth + 1);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Custom format that redacts sensitive info - returns a winston Format
 */
const redactFormat = (): winston.Logform.Format => winston.format((info: winston.Logform.TransformableInfo) => {
  // Redact message if it's an object
  if (typeof info.message === 'object' && info.message !== null) {
    info.message = redactSensitive(info.message) as string | object;
  }

  // Redact any additional metadata
  if (info.meta && typeof info.meta === 'object') {
    info.meta = redactSensitive(info.meta) as object;
  }

  // Redact request body if present
  if (info.body && typeof info.body === 'object') {
    info.body = redactSensitive(info.body) as object;
  }

  // Redact query params that might contain sensitive data
  if (info.query && typeof info.query === 'object') {
    const redactedQuery: Record<string, unknown> = {};
    const query = info.query as Record<string, unknown>;
    for (const [key, value] of Object.entries(query)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('password') || lowerKey.includes('token') || lowerKey.includes('key')) {
        redactedQuery[key] = '[REDACTED]';
      } else {
        redactedQuery[key] = value;
      }
    }
    info.query = redactedQuery;
  }

  return info;
})();

const logFormat = winston.format.printf(({ level, message, timestamp, stack, ...rest }) => {
  let msg = `${timestamp} [${level}]: ${typeof message === 'string' ? message : JSON.stringify(message)}`;

  const otherProps = Object.entries(rest)
    .filter(([key]) => !['level', 'message', 'timestamp', 'stack'].includes(key))
    .map(([key, value]) => ` ${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join('');

  msg += otherProps;

  if (stack) {
    msg += `\n${stack}`;
  }

  return msg;
});

export const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    redactFormat(),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        redactFormat(),
        logFormat
      ),
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});

export function createScopedLogger(scope: string) {
  return logger.child({ scope });
}
