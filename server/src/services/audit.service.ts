import { prisma } from '../config/database';
import { logger } from '../config/logger';
import type { AuthRequest } from '../middleware/auth.middleware';

/**
 * Write an audit-log entry. Best-effort: failures are logged but never
 * break the request. Null userId allowed (e.g. failed login attempts).
 */
export async function logAudit(
  userId: string | null,
  action: string,
  resource: string,
  details?: Record<string, unknown>,
  ipAddress?: string,
  userAgent?: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        resource,
        details: (details as object) ?? undefined,
        ipAddress,
        userAgent,
      },
    });
  } catch (err) {
    logger.error('Failed to write audit log:', err);
  }
}

/** Convenience wrapper pulling IP + user-agent from the request. */
export async function logAuditReq(
  req: AuthRequest,
  userId: string | null,
  action: string,
  resource: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await logAudit(userId, action, resource, details, req.ip, req.headers['user-agent']);
}
