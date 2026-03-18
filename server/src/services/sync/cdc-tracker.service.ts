/**
 * Type definitions for CDC Tracker Service
 * 
 * Note: SyncConfiguration and ChangeLog types are inferred from Prisma models.
 * The actual types will be available at runtime after Prisma client generation.
 */

// Placeholder types - these will be replaced with actual Prisma types when implementations are created
// For now, we define the interface structure that implementations must follow
interface SyncConfiguration {
  id: string;
  userId: string;
  name: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  direction: string;
  mode: string;
  conflictStrategy: string;
  includeTables: string[];
  excludeTables: string[];
  cronExpression: string | null;
  batchSize: number;
  parallelTables: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ChangeLog {
  id: string;
  syncConfigId: string;
  tableName: string;
  operation: string;
  primaryKeyValues: any;
  changeData: any;
  timestamp: Date;
  checkpoint: string;
  origin: string;
  synchronized: boolean;
  synchronizedAt: Date | null;
}

/**
 * CDCTrackerService Interface
 * 
 * Defines the contract for Change Data Capture (CDC) tracking services.
 * Implementations capture and track changes in source and target databases
 * for synchronization purposes.
 * 
 * Supports:
 * - MySQL/MariaDB: Binary log position tracking or trigger-based tracking
 * - PostgreSQL: Logical replication slots or trigger-based tracking
 */
export interface CDCTrackerService {
  /**
   * Initialize change tracking for a sync configuration.
   * Sets up necessary infrastructure (triggers, replication slots, etc.)
   * to capture data changes in the specified tables.
   * 
   * @param config - The sync configuration to initialize tracking for
   * @throws Error if tracking initialization fails
   * 
   * Requirements: 2.1
   */
  initializeTracking(config: SyncConfiguration): Promise<void>;

  /**
   * Teardown change tracking for a sync configuration.
   * Removes tracking infrastructure (triggers, replication slots, etc.)
   * when synchronization is stopped or deleted.
   * 
   * @param config - The sync configuration to teardown tracking for
   * @throws Error if tracking teardown fails
   * 
   * Requirements: 2.1
   */
  teardownTracking(config: SyncConfiguration): Promise<void>;

  /**
   * Capture changes from the database since the specified checkpoint.
   * Retrieves all INSERT, UPDATE, and DELETE operations that occurred
   * after the given checkpoint.
   * 
   * @param config - The sync configuration to capture changes for
   * @param since - The checkpoint to retrieve changes after (database-specific format)
   * @returns Array of change log entries with operation type, table, primary key, and data
   * @throws Error if change capture fails
   * 
   * Requirements: 2.4, 2.6
   */
  captureChanges(config: SyncConfiguration, since: string): Promise<ChangeLog[]>;

  /**
   * Get the current checkpoint for a sync configuration.
   * The checkpoint format is database-specific:
   * - MySQL/MariaDB: binlog file:position (e.g., "mysql-bin.000123:456789")
   * - PostgreSQL: LSN (Log Sequence Number, e.g., "0/3000000")
   * - Trigger-based: timestamp with optional last ID
   * 
   * @param config - The sync configuration to get checkpoint for
   * @param origin - The database origin ('source' or 'target')
   * @returns The current checkpoint as a string
   * @throws Error if checkpoint retrieval fails
   * 
   * Requirements: 2.5
   */
  getCheckpoint(config: SyncConfiguration, origin: 'source' | 'target'): Promise<string>;

  /**
   * Update the checkpoint after successful synchronization.
   * Stores the new checkpoint position to enable incremental sync
   * on the next synchronization cycle.
   * 
   * @param config - The sync configuration to update checkpoint for
   * @param checkpoint - The new checkpoint value (database-specific format)
   * @param origin - The database origin ('source' or 'target')
   * @throws Error if checkpoint update fails
   * 
   * Requirements: 2.5, 7.4
   */
  updateCheckpoint(
    config: SyncConfiguration,
    checkpoint: string,
    origin: 'source' | 'target'
  ): Promise<void>;

  /**
   * Clean up old change log entries that have been synchronized.
   * Removes change logs older than the specified date to prevent
   * unbounded growth of the change log table.
   * 
   * @param config - The sync configuration to clean up change logs for
   * @param before - Delete change logs synchronized before this date
   * @returns Number of change log entries deleted
   * @throws Error if cleanup fails
   * 
   * Requirements: 2.7
   */
  cleanupChangeLogs(config: SyncConfiguration, before: Date): Promise<number>;
}
