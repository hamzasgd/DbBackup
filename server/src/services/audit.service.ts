import { prisma } from '../config/database';
import { logger } from '../config/logger';

export async function logAudit(
  userId: string,
  action: string,
  resource: string,
  details?: Record<string, unknown>,
  ipAddress?: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        resource,
        details: details as object ?? undefined,
        ipAddress,
      },
    });
  } catch (err) {
    logger.error('Failed to write audit log:', err);
  }
}