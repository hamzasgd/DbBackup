import { prisma } from '../../config/database';
import { 
  SyncConfiguration, 
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
    
    const config: ConnectionConfig = {
      type: connection.type,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      database: connection.database,
      sslEnabled: connection.sslEnabled,
      sslCa: connection.sslCa ?? undefined,
      sslCert: connection.sslCert ?? undefined,
      sslKey: connection.sslKey ?? undefined,
      sshEnabled: connection.sshEnabled,
      sshHost: connection.sshHost ?? undefined,
      sshPort: connection.sshPort ?? undefined,
      sshUsername: connection.sshUsername ?? undefined,
      sshPrivateKey: connection.sshPrivateKey ?? undefined,
      sshPassphrase: connection.sshPassphrase ?? undefined,
      connectionTimeout: connection.connectionTimeout ?? 30000,
    };

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
    const sourceConfig = this.connectionToConfig(config.sourceConnection);
    const targetConfig = this.connectionToConfig(config.targetConnection);

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

    // TODO: If performInitialSync is true, trigger initial full sync job
    // This will be implemented in task 9.1 when sync operations are added
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
      },
    });

    // TODO: Cancel pending sync jobs from queue
    // This will be implemented when sync queue is created in task 10.1
    // For now, the PAUSED status will prevent new jobs from being queued
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

    // TODO: Restart scheduling for scheduled mode
    // This will be implemented when scheduling logic is added in task 15.1
  }

  /**
   * Stop a sync configuration
   * 
   * Completely stops synchronization:
   * 1. Cancels pending jobs
   * 2. Tears down CDC tracking
   * 3. Removes SyncState record
   * 4. Sets configuration to inactive
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

    // TODO: Cancel pending sync jobs from queue
    // This will be implemented when sync queue is created in task 10.1

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

    // Check if a sync job is already running
    if (config.syncState.currentJobId) {
      throw new Error('A sync job is already running for this configuration');
    }

    // TODO: Enqueue sync job using BullMQ
    // This will be implemented in task 10.1 when sync queue is created
    // For now, we'll generate a job ID and update the state
    const jobId = `sync-${id}-${Date.now()}`;

    // Update sync state to indicate job is pending
    await prisma.syncState.update({
      where: { id: config.syncState.id },
      data: {
        currentJobId: jobId,
        status: SyncStatus.ACTIVE,
      },
    });

    // TODO: Call addSyncJob(jobId, id, force ? 'full' : 'incremental')
    // Placeholder for BullMQ integration

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
  async getSyncState(id: string): Promise<any> {
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
  async getSyncHistory(id: string, limit: number = 10): Promise<any[]> {
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
   * Helper method to convert Connection to ConnectionConfig
   */
  private connectionToConfig(connection: Connection): ConnectionConfig {
    return {
      type: connection.type,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      database: connection.database,
      sslEnabled: connection.sslEnabled,
      sslCa: connection.sslCa ?? undefined,
      sslCert: connection.sslCert ?? undefined,
      sslKey: connection.sslKey ?? undefined,
      sshEnabled: connection.sshEnabled,
      sshHost: connection.sshHost ?? undefined,
      sshPort: connection.sshPort ?? undefined,
      sshUsername: connection.sshUsername ?? undefined,
      sshPrivateKey: connection.sshPrivateKey ?? undefined,
      sshPassphrase: connection.sshPassphrase ?? undefined,
      connectionTimeout: 30000,
    };
  }
}
