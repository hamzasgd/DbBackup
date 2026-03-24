/**
 * Base CDC Tracker - Abstract base class for Change Data Capture trackers
 *
 * Provides shared functionality for MySQL and PostgreSQL CDC implementations:
 * - Trigger-based configuration tracking
 * - Shared checkpoint update and cleanup logic
 * - Common type definitions
 *
 * Requirements: 2.1
 */

import { CDCTrackerService } from './cdc-tracker.service';
import { prisma } from '../../config/database';
import type { SyncConfigWithConnections } from './sync-utils';
import type { ChangeLog } from './types';

export abstract class BaseCDCTracker implements CDCTrackerService {
  /** Per-config tracking of whether to use trigger-based CDC */
  protected triggerBasedConfigs = new Map<string, boolean>();

  /**
   * Check if a config uses trigger-based CDC
   * Default is true (safe fallback)
   */
  protected isTriggerBased(configId: string): boolean {
    return this.triggerBasedConfigs.get(configId) ?? true;
  }

  /**
   * Update the checkpoint after successful synchronization
   * Shared implementation for all CDC trackers
   * Requirements: 2.5, 7.4
   */
  async updateCheckpoint(
    config: SyncConfigWithConnections,
    checkpoint: string,
    origin: 'source' | 'target'
  ): Promise<void> {
    const field = origin === 'source' ? 'sourceCheckpoint' : 'targetCheckpoint';

    await prisma.syncState.update({
      where: { syncConfigId: config.id },
      data: { [field]: checkpoint },
    });
  }

  /**
   * Clean up old change log entries
   * Shared implementation for all CDC trackers
   * Requirements: 2.7
   */
  async cleanupChangeLogs(config: SyncConfigWithConnections, before: Date): Promise<number> {
    const result = await prisma.changeLog.deleteMany({
      where: {
        syncConfigId: config.id,
        synchronized: true,
        synchronizedAt: {
          lt: before,
        },
      },
    });

    return result.count;
  }

  // Abstract methods that must be implemented by subclasses

  /**
   * Initialize change tracking for a sync configuration
   */
  abstract initializeTracking(config: SyncConfigWithConnections): Promise<void>;

  /**
   * Teardown change tracking for a sync configuration
   */
  abstract teardownTracking(config: SyncConfigWithConnections): Promise<void>;

  /**
   * Capture changes from the database since the specified checkpoint
   */
  abstract captureChanges(config: SyncConfigWithConnections, since: string): Promise<ChangeLog[]>;

  /**
   * Get the current checkpoint for a sync configuration
   */
  abstract getCheckpoint(config: SyncConfigWithConnections, origin: 'source' | 'target'): Promise<string>;
}

// Re-export types for use in subclasses
export type { ChangeLog } from './types';
