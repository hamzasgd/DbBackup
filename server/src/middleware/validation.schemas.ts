import { z } from 'zod';

// Common regex patterns
const tableNameRegex = /^[a-zA-Z_][a-zA-Z0-9_$]*$/;
const databaseNameRegex = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;

// Auth schemas
export const registerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

// Connection schemas
export const connectionSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.enum(['MYSQL', 'MARIADB', 'POSTGRESQL']),
  host: z.string().min(1, 'Host is required'),
  port: z.number().int().positive('Port must be a positive integer'),
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  database: z.string().min(1, 'Database is required'),
  sslEnabled: z.boolean().optional().default(false),
  sslCa: z.string().optional(),
  sslCert: z.string().optional(),
  sslKey: z.string().optional(),
  sshEnabled: z.boolean().optional().default(false),
  sshHost: z.string().optional(),
  sshPort: z.number().int().positive().optional(),
  sshUsername: z.string().optional(),
  sshPrivateKey: z.string().optional(),
  sshPassphrase: z.string().optional(),
  connectionTimeout: z.number().int().positive().optional(),
});

// Backup schemas
export const backupTriggerSchema = z.object({
  connectionId: z.string().uuid('Invalid connection ID'),
  format: z.enum(['COMPRESSED_SQL', 'PLAIN_SQL', 'CUSTOM', 'DIRECTORY', 'TAR']).optional(),
});

// Restore schemas
export const restoreSchema = z.object({
  backupId: z.string().uuid('Invalid backup ID'),
  targetConnectionId: z.string().uuid('Invalid connection ID').optional(),
  targetDatabase: z.string().regex(databaseNameRegex, 'Invalid database name').optional(),
});

// Schedule schemas
export const scheduleSchema = z.object({
  connectionId: z.string().uuid('Invalid connection ID'),
  name: z.string().min(1, 'Name is required'),
  frequency: z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']),
  cronExpression: z.string().min(1, 'Cron expression is required'),
  isActive: z.boolean().optional().default(true),
  retentionDays: z.number().int().positive().optional(),
  retentionCount: z.number().int().positive().optional(),
});

// Migration schemas
export const migrationSchema = z.object({
  sourceConnectionId: z.string().uuid('Invalid source connection ID'),
  targetConnectionId: z.string().uuid('Invalid target connection ID'),
});

// Export schemas
export const exportSchema = z.object({
  tables: z.array(z.string().regex(tableNameRegex, 'Invalid table name')).min(1, 'At least one table is required'),
  format: z.enum(['json', 'csv', 'sql']),
});

// Refresh token schema
export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// Logout schema
export const logoutSchema = z.object({
  refreshToken: z.string().optional(),
});