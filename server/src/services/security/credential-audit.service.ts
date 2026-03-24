import { Request } from 'express';
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';

export type CredentialAction = 'DECRYPT' | 'TEST' | 'BACKUP' | 'RESTORE' | 'SYNC' | 'MIGRATION' | 'VIEW';

export interface CredentialAccessLogEntry {
  id: string;
  connectionId: string;
  userId: string;
  action: CredentialAction;
  ipAddress: string | null;
  timestamp: Date;
  success: boolean;
  errorMessage?: string;
}

/**
 * Service for auditing credential access events.
 * Tracks who accessed credentials, when, and what action was performed.
 */
export class CredentialAuditService {
  /**
   * Log a credential access event
   */
  async logAccess(
    connectionId: string,
    userId: string,
    action: CredentialAction,
    req: Request,
    success: boolean = true,
    errorMessage?: string
  ): Promise<void> {
    try {
      await prisma.credentialAccessLog.create({
        data: {
          connectionId,
          userId,
          action,
          ipAddress: req.ip ?? req.socket.remoteAddress ?? null,
          success,
          errorMessage,
        },
      });
    } catch (error) {
      // Don't let audit logging failures break the main operation
      logger.error('Failed to log credential access:', error);
    }
  }

  /**
   * Get recent access logs for a connection
   */
  async getRecentAccess(
    connectionId: string,
    hours: number = 24
  ): Promise<CredentialAccessLogEntry[]> {
    const logs = await prisma.credentialAccessLog.findMany({
      where: {
        connectionId,
        timestamp: {
          gte: new Date(Date.now() - hours * 60 * 60 * 1000),
        },
      },
      orderBy: { timestamp: 'desc' },
      take: 100,
    });

    return logs.map(log => ({
      id: log.id,
      connectionId: log.connectionId,
      userId: log.userId,
      action: log.action as CredentialAction,
      ipAddress: log.ipAddress,
      timestamp: log.timestamp,
      success: log.success,
      errorMessage: log.errorMessage ?? undefined,
    }));
  }

  /**
   * Detect anomalous access patterns for a connection
   */
  async detectAnomalousAccess(
    connectionId: string,
    threshold: number = 100,
    windowMs: number = 60 * 60 * 1000 // 1 hour
  ): Promise<{ anomalous: boolean; count: number; message?: string }> {
    const recentAccesses = await prisma.credentialAccessLog.count({
      where: {
        connectionId,
        timestamp: { gte: new Date(Date.now() - windowMs) },
      },
    });

    if (recentAccesses > threshold) {
      return {
        anomalous: true,
        count: recentAccesses,
        message: `Excessive credential access detected: ${recentAccesses} accesses in ${windowMs / 1000 / 60} minutes (threshold: ${threshold})`,
      };
    }

    return { anomalous: false, count: recentAccesses };
  }

  /**
   * Get all failed access attempts for a user
   */
  async getFailedAttempts(userId: string, hours: number = 24): Promise<number> {
    return prisma.credentialAccessLog.count({
      where: {
        userId,
        success: false,
        timestamp: { gte: new Date(Date.now() - hours * 60 * 60 * 1000) },
      },
    });
  }

  /**
   * Check if user has exceeded failed access threshold
   */
  async isUserLockedOut(userId: string, maxFailedAttempts: number = 10): Promise<boolean> {
    const failedAttempts = await this.getFailedAttempts(userId);
    return failedAttempts >= maxFailedAttempts;
  }
}

// Singleton instance
export const credentialAuditService = new CredentialAuditService();
