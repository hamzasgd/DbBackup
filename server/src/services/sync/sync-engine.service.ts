import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { 
  SyncConfiguration, 
  SyncState,
  SyncHistory,
  SyncDirection, 
  SyncMode, 
  ConflictStrategy,
  SyncStatus,
  Connection 
} from '@prisma/client';
import { SchemaValidatorService } from './schema-validator.service';
import { ConnectionConfig } from '../engines/base.engine';
import { CDCTrackerService } from './cdc-tracker.service';
import { MySQLCDCTracker } from './mysql-cdc-tracker.service';
import { PostgreSQLCDCTracker } from './postgresql-cdc-tracker.service';
import { connectionToConfig } from './sync-utils';

/**
 * DTO for creating a sync configuration
 */
export interface CreateSyncConfigDto {
  userId: string;
  name: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  direction?: SyncDirection;
  mode?: SyncMode;
  conflictStrategy?: ConflictStrategy;
  includeTables?: string[];
  excludeTables?: string[];
  cronExpression?: string | null;
  batchSize?: number;
  parallelTables?: number;
}

/**
 * DTO for updating a sync configuration
 */
export interface UpdateSyncConfigDto {
  name?: string;
  direction?: SyncDirection;
  mode?: SyncMode;
  conflictStrategy?: ConflictStrategy;
  includeTables?: string[];
  excludeTables?: string[];
  cronExpression?: string | null;
  batchSize?: number;
  parallelTables?: number;
}

/**
 * SyncEngineService - Core orchestration service for database synchronization
 * 
 * Manages sync configurations and coordinates CDC tracking, conflict resolution,
 * and schema validation. This is the primary service for sync configuration
 * lifecycle management.
 * 
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 11.4
 */
export class SyncEngineService {
  private schemaValidator: SchemaValidatorService;
  private cdcTrackers: Map<string, CDCTrackerService>;

  constructor() {
    this.schemaValidator = new SchemaValidatorService();
    this.cdcTrackers = new Map();
  }

  /**
   * Get or create a CDC tracker for a specific database type
   */
  private getCDCTracker(dbType: string): CDCTrackerService {
    if (!this.cdcTrackers.has(dbType)) {
      if (dbType === 'MYSQL' || dbType === 'MARIADB') {
        this.cdcTrackers.set(dbType, new MySQLCDCTracker());
      } else if (dbType === 'POSTGRESQL') {
        this.cdcTrackers.set(dbType, new PostgreSQLCDCTracker());
      } else {
        throw new Error(`Unsupported database type for CDC: ${dbType}`);
      }
    }
    return this.cdcTrackers.get(dbType)!;
  }

  /**
   * Create a new sync configuration
   * 
   * Validates that:
   * - Source and target connections exist and are accessible
   * - User owns both connections
   * - Connections are different (cannot sync to itself)
   * 
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 11.4
   */
  async createSyncConfiguration(data: CreateSyncConfigDto): Promise<SyncConfiguration> {
    // Validate that source and target connections exist and user owns them
    const sourceConnection = await prisma.connection.findUnique({
      where: { id: data.sourceConnectionId },
    });

    if (!sourceConnection) {
      throw new Error(`Source connection ${data.sourceConnectionId} not found`);
    }

    if (sourceConnection.userId !== data.userId) {
      throw new Error('User does not own source connection');
    }

    const targetConnection = await prisma.connection.findUnique({
      where: { id: data.targetConnectionId },
    });

    if (!targetConnection) {
      throw new Error(`Target connection ${data.targetConnectionId} not found`);
    }

    if (targetConnection.userId !== data.userId) {
      throw new Error('User does not own target connection');
    }

    // Validate that source and target are different
    if (data.sourceConnectionId === data.targetConnectionId) {
      throw new Error('Source and target connections must be different');
    }

    // Test connection accessibility
    await this.validateConnectionAccessibility(sourceConnection);
    await this.validateConnectionAccessibility(targetConnection);

    // Create the sync configuration
    const syncConfig = await prisma.syncConfiguration.create({
      data: {
        userId: data.userId,
        name: data.name,
        sourceConnectionId: data.sourceConnectionId,
        targetConnectionId: data.targetConnectionId,
        direction: data.direction ?? SyncDirection.UNIDIRECTIONAL,
        mode: data.mode ?? SyncMode.MANUAL,
        conflictStrategy: data.conflictStrategy ?? ConflictStrategy.LAST_WRITE_WINS,
        includeTables: data.includeTables ?? [],
        excludeTables: data.excludeTables ?? [],
        cronExpression: data.cronExpression ?? null,
        batchSize: data.batchSize ?? 500,
        parallelTables: data.parallelTables ?? 1,
        isActive: false,
      },
    });

    return syncConfig;
  }

  /**
   * Validate that a connection is accessible
   * 
   * Requirements: 1.2
   */
  private async validateConnectionAccessibility(connection: Connection): Promise<void> {
    // Import engine factory dynamically to avoid circular dependencies
    const { engineFactory } = await import('../engines/engine.factory');
    
    const config = connectionToConfig(connection);
    const engine = engineFactory(config);
    
    try {
      // Test connection by getting database info
      await engine.getDbInfo();
    } catch (error) {
      throw new Error(
        `Connection ${connection.name} is not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Update an existing sync configuration
   * 
   * Only allows updates when the configuration is inactive.
   * 
   * Requirements: 1.6
   */
  async updateSyncConfiguration(
    id: string,
    data: UpdateSyncConfigDto
  ): Promise<SyncConfiguration> {
    // Check if configuration exists
    const existingConfig = await prisma.syncConfiguration.findUnique({
      where: { id },
    });

    if (!existingConfig) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    // Prevent updates to active configurations
    if (existingConfig.isActive) {
      throw new Error('Cannot update active sync configuration. Please pause or stop it first.');
    }

    // Update the configuration
    const updatedConfig = await prisma.syncConfiguration.update({
      where: { id },
      data: {
        name: data.name,
        direction: data.direction,
        mode: data.mode,
        conflictStrategy: data.conflictStrategy,
        includeTables: data.includeTables,
        excludeTables: data.excludeTables,
        cronExpression: data.cronExpression,
        batchSize: data.batchSize,
        parallelTables: data.parallelTables,
      },
    });

    return updatedConfig;
  }

  /**
   * Delete a sync configuration
   * 
   * Cascades to delete associated sync state, change logs, conflicts, and history.
   * This is handled automatically by Prisma's cascade delete configuration.
   * 
   * Requirements: 1.7
   */
  async deleteSyncConfiguration(id: string): Promise<void> {
    // Check if configuration exists
    const existingConfig = await prisma.syncConfiguration.findUnique({
      where: { id },
    });

    if (!existingConfig) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    // Prevent deletion of active configurations
    if (existingConfig.isActive) {
      throw new Error('Cannot delete active sync configuration. Please stop it first.');
    }

    // Delete the configuration (cascade will handle related records)
    await prisma.syncConfiguration.delete({
      where: { id },
    });
  }

  /**
   * Get a single sync configuration by ID
   * 
   * Requirements: 1.8
   */
  async getSyncConfiguration(id: string): Promise<SyncConfiguration | null> {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: {
        sourceConnection: true,
        targetConnection: true,
        syncState: true,
      },
    });

    return config;
  }

  /**
   * List all sync configurations for a user
   * 
   * Returns only configurations where the user owns both source and target connections.
   * 
   * Requirements: 1.8
   */
  async listSyncConfigurations(userId: string): Promise<SyncConfiguration[]> {
    const configs = await prisma.syncConfiguration.findMany({
      where: {
        userId,
      },
      include: {
        sourceConnection: true,
        targetConnection: true,
        syncState: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return configs;
  }

  /**
   * Activate a sync configuration
   * 
   * Performs the following:
   * 1. Validates schema compatibility between source and target
   * 2. Initializes CDC tracking on source (and target for bidirectional)
   * 3. Creates SyncState record
   * 4. Optionally performs initial full sync
   * 5. Sets configuration to active
   * 6. Sets up real-time or scheduled mode if configured
   * 
   * Requirements: 2.1, 6.5, 13.1, 13.5, 13.6, 13.7, 13.8, 14.1
   */
  async activateSyncConfiguration(
    id: string,
    performInitialSync: boolean = false
  ): Promise<void> {
    // Get the configuration with connections
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: {
        sourceConnection: true,
        targetConnection: true,
        syncState: true,
      },
    });

    if (!config) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    if (config.isActive) {
      throw new Error('Sync configuration is already active');
    }

    // Validate schema compatibility
    const sourceConfig = connectionToConfig(config.sourceConnection);
    const targetConfig = connectionToConfig(config.targetConnection);

    const schemaComparison = await this.schemaValidator.compareSchemas(
      sourceConfig,
      targetConfig,
      config.includeTables.length > 0 ? config.includeTables : []
    );

    const validationResult = await this.schemaValidator.validateSchemaCompatibility(
      schemaComparison
    );

    if (!validationResult.valid) {
      throw new Error(
        `Schema validation failed: ${validationResult.errors.join(', ')}`
      );
    }

    // Initialize CDC tracking on source
    const sourceCDC = this.getCDCTracker(config.sourceConnection.type);
    await sourceCDC.initializeTracking(config as any);

    // Initialize CDC tracking on target for bidirectional sync
    if (config.direction === SyncDirection.BIDIRECTIONAL) {
      const targetCDC = this.getCDCTracker(config.targetConnection.type);
      await targetCDC.initializeTracking(config as any);
    }

    // Create SyncState record
    await prisma.syncState.create({
      data: {
        syncConfigId: config.id,
        status: SyncStatus.ACTIVE,
        sourceCheckpoint: await sourceCDC.getCheckpoint(config as any, 'source'),
        targetCheckpoint:
          config.direction === SyncDirection.BIDIRECTIONAL
            ? await this.getCDCTracker(config.targetConnection.type).getCheckpoint(
                config as any,
                'target'
              )
            : null,
      },
    });

    // Set configuration to active
    await prisma.syncConfiguration.update({
      where: { id },
      data: { isActive: true },
    });

    // Perform initial full sync if requested
    if (performInitialSync) {
      try {
        const { addSyncJob } = await import('../../queue/sync.queue');
        await addSyncJob({
          configId: id,
          mode: 'full',
        });
      } catch (error) {
        // Rollback activation if initial sync fails
        await this.stopSyncConfiguration(id);
        throw new Error(
          `Initial sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    // Set up real-time or scheduled mode
    if (config.mode === SyncMode.REALTIME) {
      await this.setupRealtimeMode(id);
    } else if (config.mode === SyncMode.SCHEDULED && config.cronExpression) {
      await this.setupScheduledMode(id);
    }
  }

  /**
   * Pause a sync configuration
   * 
   * Cancels pending sync jobs and updates state to PAUSED.
   * Does not teardown CDC tracking, allowing for quick resume.
   * 
   * Requirements: 13.5, 13.8
   */
  async pauseSyncConfiguration(id: string): Promise<void> {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: { syncState: true },
    });

    if (!config) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    if (!config.isActive) {
      throw new Error('Sync configuration is not active');
    }

    if (!config.syncState) {
      throw new Error('Sync state not found for active configuration');
    }

    // Update sync state to PAUSED
    await prisma.syncState.update({
      where: { id: config.syncState.id },
      data: {
        status: SyncStatus.PAUSED,
        currentJobId: null,
      },
    });

    // Cancel any running/pending BullMQ job
    await this.cancelRunningJob(config.syncState.currentJobId);

    // Cancel real-time intervals or scheduled jobs
    if (config.mode === SyncMode.REALTIME) {
      await this.cancelRealtimeMode(id);
    } else if (config.mode === SyncMode.SCHEDULED) {
      await this.cancelScheduledMode(id);
    }
  }

  /**
   * Resume a paused sync configuration
   * 
   * Restarts scheduling for a paused configuration.
   * Updates state to ACTIVE and re-enables job scheduling.
   * 
   * Requirements: 13.6
   */
  async resumeSyncConfiguration(id: string): Promise<void> {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: { syncState: true },
    });

    if (!config) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    if (!config.isActive) {
      throw new Error('Sync configuration is not active');
    }

    if (!config.syncState) {
      throw new Error('Sync state not found for configuration');
    }

    if (config.syncState.status !== SyncStatus.PAUSED) {
      throw new Error('Sync configuration is not paused');
    }

    // Update sync state to ACTIVE
    await prisma.syncState.update({
      where: { id: config.syncState.id },
      data: {
        status: SyncStatus.ACTIVE,
      },
    });

    // Restart real-time or scheduled mode
    if (config.mode === SyncMode.REALTIME) {
      await this.setupRealtimeMode(id);
    } else if (config.mode === SyncMode.SCHEDULED && config.cronExpression) {
      await this.setupScheduledMode(id);
    }
  }

  /**
   * Stop a sync configuration
   * 
   * Completely stops synchronization:
   * 1. Cancels pending jobs
   * 2. Tears down CDC tracking
   * 3. Removes SyncState record
   * 4. Sets configuration to inactive
   * 5. Cancels real-time or scheduled mode
   * 
   * Requirements: 13.7
   */
  async stopSyncConfiguration(id: string): Promise<void> {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: {
        sourceConnection: true,
        targetConnection: true,
        syncState: true,
      },
    });

    if (!config) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    if (!config.isActive) {
      throw new Error('Sync configuration is not active');
    }

    // Cancel any running/pending BullMQ job first
    if (config.syncState?.currentJobId) {
      await this.cancelRunningJob(config.syncState.currentJobId);
    }

    // Cancel real-time or scheduled mode
    if (config.mode === SyncMode.REALTIME) {
      await this.cancelRealtimeMode(id);
    } else if (config.mode === SyncMode.SCHEDULED) {
      await this.cancelScheduledMode(id);
    }

    // Teardown CDC tracking on source
    const sourceCDC = this.getCDCTracker(config.sourceConnection.type);
    await sourceCDC.teardownTracking(config as any);

    // Teardown CDC tracking on target for bidirectional sync
    if (config.direction === SyncDirection.BIDIRECTIONAL) {
      const targetCDC = this.getCDCTracker(config.targetConnection.type);
      await targetCDC.teardownTracking(config as any);
    }

    // Remove SyncState record
    if (config.syncState) {
      await prisma.syncState.delete({
        where: { id: config.syncState.id },
      });
    }

    // Set configuration to inactive
    await prisma.syncConfiguration.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /**
   * Set up real-time sync mode
   * 
   * Polls the ChangeLog table every 5 seconds for new changes.
   * If changes are detected, triggers a sync job.
   * 
   * Requirements: 6.1, 15.1
   */
  private async setupRealtimeMode(configId: string): Promise<void> {
    // Store interval ID in a map for later cancellation
    if (!this.realtimeIntervals) {
      this.realtimeIntervals = new Map();
    }

    const intervalId = setInterval(async () => {
      try {
        // Check if configuration is still active
        const config = await prisma.syncConfiguration.findUnique({
          where: { id: configId },
          include: { syncState: true },
        });

        if (!config || !config.isActive || config.mode !== SyncMode.REALTIME) {
          // Configuration was deactivated or mode changed, cancel interval
          clearInterval(intervalId);
          this.realtimeIntervals?.delete(configId);
          return;
        }

        // Check if a sync job is already running
        if (config.syncState?.currentJobId) {
          return; // Skip this cycle if sync is already running
        }

        // Check for new changes in ChangeLog
        const changeCount = await prisma.changeLog.count({
          where: {
            syncConfigId: configId,
            synchronized: false,
          },
        });

        if (changeCount > 0) {
          // Trigger sync job
          await this.triggerSync(configId, false);
        }
      } catch (error) {
        logger.error(`Real-time sync check failed for ${configId}:`, error);
      }
    }, 5000); // Check every 5 seconds

    this.realtimeIntervals.set(configId, intervalId);
  }

  /**
   * Cancel real-time sync mode
   */
  private async cancelRealtimeMode(configId: string): Promise<void> {
    if (this.realtimeIntervals?.has(configId)) {
      const intervalId = this.realtimeIntervals.get(configId);
      clearInterval(intervalId);
      this.realtimeIntervals.delete(configId);
    }
  }

  /**
   * Cancel a running or pending BullMQ sync job by ID.
   * Removes it from the queue so it won't be retried.
   */
  private async cancelRunningJob(jobId: string | null): Promise<void> {
    if (!jobId) return;

    try {
      const { getSyncQueue } = await import('../../queue/sync.queue');
      const queue = getSyncQueue();
      const job = await queue.getJob(jobId);

      if (job) {
        // Try to remove the job. If it's active, this will stop it from being retried.
        const state = await job.getState();
        if (state === 'active') {
          // For active jobs, move to failed so the worker stops processing
          await job.moveToFailed(new Error('Sync configuration stopped by user'), '0', true);
          logger.info(`Cancelled active sync job ${jobId}`);
        } else if (state === 'waiting' || state === 'delayed') {
          await job.remove();
          logger.info(`Removed pending sync job ${jobId}`);
        } else {
          // completed, failed, etc — nothing to do
          logger.info(`Sync job ${jobId} already in state: ${state}`);
        }
      }
    } catch (error) {
      logger.warn(`Failed to cancel job ${jobId}:`, error);
      // Don't throw — stopping the config is more important than cleaning up the job
    }
  }

  /**
   * Set up scheduled sync mode
   * 
   * Uses the existing schedule queue infrastructure to schedule sync jobs
   * based on the cron expression.
   * 
   * Requirements: 6.2, 15.1
   */
  private async setupScheduledMode(configId: string): Promise<void> {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id: configId },
    });

    if (!config || !config.cronExpression) {
      throw new Error('Cron expression not found for scheduled sync');
    }

    // Import schedule queue
    const { addScheduleJob } = await import('../../queue/schedule.queue');

    // Create a schedule job that triggers sync
    await addScheduleJob({
      id: configId,
      cronExpression: config.cronExpression,
    });

    // Calculate and store next scheduled sync time
    const parser = await import('cron-parser');
    const interval = parser.parseExpression(config.cronExpression);
    const nextRun = interval.next().toDate();

    await prisma.syncState.update({
      where: { syncConfigId: configId },
      data: {
        nextSyncAt: nextRun,
      },
    });
  }

  /**
   * Cancel scheduled sync mode
   */
  private async cancelScheduledMode(configId: string): Promise<void> {
    // Import schedule queue
    const { getScheduleQueue } = await import('../../queue/schedule.queue');
    const queue = getScheduleQueue();

    // Remove the scheduled job for this sync configuration
    await queue.removeJobScheduler(configId);

    // Clear next scheduled sync time
    await prisma.syncState.update({
      where: { syncConfigId: configId },
      data: {
        nextSyncAt: null,
      },
    });
  }

  private realtimeIntervals?: Map<string, NodeJS.Timeout>;

  /**
   * Trigger a manual sync job
   * 
   * Enqueues a sync job for manual execution. Can optionally force a full sync
   * instead of incremental sync.
   * 
   * Requirements: 6.3, 6.4
   */
  async triggerSync(id: string, force: boolean = false): Promise<string> {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: { syncState: true },
    });

    if (!config) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    if (!config.isActive) {
      throw new Error('Cannot trigger sync for inactive configuration');
    }

    if (!config.syncState) {
      throw new Error('Sync state not found for active configuration');
    }

    // Check if a sync job is already running (with atomic update to prevent race conditions)
    if (config.syncState.currentJobId) {
      // Check if the job actually exists in the queue
      const { getSyncQueue } = await import('../../queue/sync.queue');
      const queue = getSyncQueue();
      
      try {
        const job = await queue.getJob(config.syncState.currentJobId);
        
        // If job doesn't exist or is completed/failed, atomically clear the stale job ID
        if (!job || await job.isCompleted() || await job.isFailed()) {
          logger.warn(`Clearing stale job ID ${config.syncState.currentJobId} for sync ${id}`);
          // Atomic conditional update: only clear if the job ID hasn't changed
          const updated = await prisma.syncState.updateMany({
            where: {
              syncConfigId: id,
              currentJobId: config.syncState.currentJobId, // only if still the same stale ID
            },
            data: { currentJobId: null },
          });
          if (updated.count === 0) {
            // Another process already cleared/replaced it — re-check
            throw new Error('A sync job is already running for this configuration');
          }
        } else {
          // Job is actually running
          throw new Error('A sync job is already running for this configuration');
        }
      } catch (error) {
        // If we can't get the job, it probably doesn't exist - clear the stale ID
        if (error instanceof Error && error.message !== 'A sync job is already running for this configuration') {
          logger.warn(`Error checking job status, clearing stale job ID: ${error.message}`);
          await prisma.syncState.updateMany({
            where: {
              syncConfigId: id,
              currentJobId: config.syncState.currentJobId,
            },
            data: { currentJobId: null },
          });
        } else {
          throw error;
        }
      }
    }

    // For incremental sync, check if there are any pending changes
    if (!force) {
      const pendingChanges = await prisma.changeLog.count({
        where: {
          syncConfigId: id,
          synchronized: false,
        },
      });

      logger.info(`Triggering sync for ${id}. Pending changes: ${pendingChanges}`);
    }

    // Enqueue sync job using BullMQ
    const { addSyncJob } = await import('../../queue/sync.queue');
    const jobId = await addSyncJob({
      configId: id,
      mode: force ? 'full' : 'incremental',
    });

    // Update sync state to indicate job is pending
    await prisma.syncState.update({
      where: { id: config.syncState.id },
      data: {
        currentJobId: jobId,
        status: SyncStatus.ACTIVE,
      },
    });

    return jobId;
  }

  /**
   * Perform a full synchronization
   * 
   * Forces a complete synchronization of all records regardless of checkpoint.
   * This is useful for recovering from errors or ensuring complete consistency.
   * 
   * Requirements: 7.6, 7.7, 14.2
   */
  async performFullSync(id: string): Promise<string> {
    // Full sync is just a forced sync
    return this.triggerSync(id, true);
  }

  /**
   * Get the current sync state
   * 
   * Retrieves the current synchronization state including status, checkpoints,
   * timing information, and statistics.
   * 
   * Requirements: 10.5, 10.6
   */
  async getSyncState(id: string): Promise<SyncState | null> {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
      include: {
        syncState: true,
      },
    });

    if (!config) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    if (!config.syncState) {
      return null;
    }

    return config.syncState;
  }

  /**
   * Get synchronization history
   * 
   * Retrieves the execution history for a sync configuration, including
   * timing, statistics, and error information.
   * 
   * Requirements: 10.5, 10.6
   */
  async getSyncHistory(id: string, limit: number = 10): Promise<SyncHistory[]> {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id },
    });

    if (!config) {
      throw new Error(`Sync configuration ${id} not found`);
    }

    const history = await prisma.syncHistory.findMany({
      where: {
        syncConfigId: id,
      },
      orderBy: {
        startedAt: 'desc',
      },
      take: limit,
    });

    return history;
  }

  /**
   * Recover real-time sync configurations after server restart.
   *
   * Queries all active real-time sync configurations and re-establishes
   * their polling intervals. Should be called during server startup.
   */
  async recoverRealtimeConfigs(): Promise<void> {
    const activeRealtimeConfigs = await prisma.syncConfiguration.findMany({
      where: {
        isActive: true,
        mode: SyncMode.REALTIME,
      },
      include: {
        syncState: true,
      },
    });

    if (activeRealtimeConfigs.length === 0) {
      return;
    }

    logger.info(`Recovering ${activeRealtimeConfigs.length} active real-time sync configurations`);

    for (const config of activeRealtimeConfigs) {
      try {
        // Only recover configs that are ACTIVE or PAUSED (not FAILED)
        if (config.syncState?.status === SyncStatus.ACTIVE) {
          await this.setupRealtimeMode(config.id);
          logger.info(`Recovered real-time sync for ${config.name} (${config.id})`);
        }
      } catch (error) {
        logger.error(`Failed to recover real-time sync for ${config.name} (${config.id}):`, error);
      }
    }
  }
}
