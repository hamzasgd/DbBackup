import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SyncEngineService, CreateSyncConfigDto } from './sync-engine.service';
import { prisma } from '../../config/database';
import { SyncDirection, SyncMode, ConflictStrategy, DatabaseType } from '@prisma/client';

describe('SyncEngineService', () => {
  let service: SyncEngineService;
  let testUserId: string;
  let sourceConnectionId: string;
  let targetConnectionId: string;

  beforeEach(async () => {
    service = new SyncEngineService();

    // Create a test user
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        name: 'Test User',
        passwordHash: 'hashed_password',
      },
    });
    testUserId = user.id;

    // Create test connections (note: these won't actually connect to real databases)
    const sourceConnection = await prisma.connection.create({
      data: {
        userId: testUserId,
        name: 'Test Source',
        type: DatabaseType.MYSQL,
        host: 'localhost',
        port: 3306,
        username: 'test',
        password: 'test',
        database: 'test_source',
      },
    });
    sourceConnectionId = sourceConnection.id;

    const targetConnection = await prisma.connection.create({
      data: {
        userId: testUserId,
        name: 'Test Target',
        type: DatabaseType.MYSQL,
        host: 'localhost',
        port: 3306,
        username: 'test',
        password: 'test',
        database: 'test_target',
      },
    });
    targetConnectionId = targetConnection.id;
  });

  afterEach(async () => {
    // Clean up test data
    await prisma.syncConfiguration.deleteMany({
      where: { userId: testUserId },
    });
    await prisma.connection.deleteMany({
      where: { userId: testUserId },
    });
    await prisma.user.delete({
      where: { id: testUserId },
    });
  });

  describe('createSyncConfiguration', () => {
    it('should create a sync configuration with valid data', async () => {
      const data: CreateSyncConfigDto = {
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
        direction: SyncDirection.UNIDIRECTIONAL,
        mode: SyncMode.MANUAL,
        conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
      };

      // Skip connection validation for this test by mocking
      // In a real scenario, we'd need actual database connections
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration(data);

      expect(config).toBeDefined();
      expect(config.name).toBe('Test Sync');
      expect(config.userId).toBe(testUserId);
      expect(config.sourceConnectionId).toBe(sourceConnectionId);
      expect(config.targetConnectionId).toBe(targetConnectionId);
      expect(config.direction).toBe(SyncDirection.UNIDIRECTIONAL);
      expect(config.mode).toBe(SyncMode.MANUAL);
      expect(config.conflictStrategy).toBe(ConflictStrategy.LAST_WRITE_WINS);
      expect(config.isActive).toBe(false);

      // Restore original method
      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject creation if source connection does not exist', async () => {
      const data: CreateSyncConfigDto = {
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId: 'non-existent-id',
        targetConnectionId,
      };

      await expect(service.createSyncConfiguration(data)).rejects.toThrow(
        'Source connection non-existent-id not found'
      );
    });

    it('should reject creation if target connection does not exist', async () => {
      const data: CreateSyncConfigDto = {
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId: 'non-existent-id',
      };

      await expect(service.createSyncConfiguration(data)).rejects.toThrow(
        'Target connection non-existent-id not found'
      );
    });

    it('should reject creation if user does not own source connection', async () => {
      // Create another user
      const otherUser = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          name: 'Other User',
          passwordHash: 'hashed_password',
        },
      });

      const data: CreateSyncConfigDto = {
        userId: otherUser.id,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      };

      await expect(service.createSyncConfiguration(data)).rejects.toThrow(
        'User does not own source connection'
      );

      // Clean up
      await prisma.user.delete({ where: { id: otherUser.id } });
    });

    it('should reject creation if source and target are the same', async () => {
      const data: CreateSyncConfigDto = {
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId: sourceConnectionId,
      };

      await expect(service.createSyncConfiguration(data)).rejects.toThrow(
        'Source and target connections must be different'
      );
    });
  });

  describe('updateSyncConfiguration', () => {
    it('should update an inactive sync configuration', async () => {
      // Create a config first
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Original Name',
        sourceConnectionId,
        targetConnectionId,
      });

      const updated = await service.updateSyncConfiguration(config.id, {
        name: 'Updated Name',
        batchSize: 1000,
      });

      expect(updated.name).toBe('Updated Name');
      expect(updated.batchSize).toBe(1000);

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject update of active sync configuration', async () => {
      // Create and activate a config
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Manually set it to active
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });

      await expect(
        service.updateSyncConfiguration(config.id, { name: 'New Name' })
      ).rejects.toThrow('Cannot update active sync configuration');

      service['validateConnectionAccessibility'] = originalValidate;
    });
  });

  describe('deleteSyncConfiguration', () => {
    it('should delete an inactive sync configuration', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      await service.deleteSyncConfiguration(config.id);

      const deleted = await prisma.syncConfiguration.findUnique({
        where: { id: config.id },
      });

      expect(deleted).toBeNull();

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject deletion of active sync configuration', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Manually set it to active
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });

      await expect(service.deleteSyncConfiguration(config.id)).rejects.toThrow(
        'Cannot delete active sync configuration'
      );

      service['validateConnectionAccessibility'] = originalValidate;
    });
  });

  describe('getSyncConfiguration', () => {
    it('should retrieve a sync configuration by ID', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const created = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      const retrieved = await service.getSyncConfiguration(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe('Test Sync');

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should return null for non-existent configuration', async () => {
      const retrieved = await service.getSyncConfiguration('non-existent-id');
      expect(retrieved).toBeNull();
    });
  });

  describe('listSyncConfigurations', () => {
    it('should list all sync configurations for a user', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Sync 1',
        sourceConnectionId,
        targetConnectionId,
      });

      await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Sync 2',
        sourceConnectionId,
        targetConnectionId,
      });

      const configs = await service.listSyncConfigurations(testUserId);

      expect(configs).toHaveLength(2);
      expect(configs[0].name).toBe('Sync 2'); // Most recent first
      expect(configs[1].name).toBe('Sync 1');

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should return empty array for user with no configurations', async () => {
      const configs = await service.listSyncConfigurations(testUserId);
      expect(configs).toHaveLength(0);
    });
  });

  describe('activateSyncConfiguration', () => {
    it('should activate a sync configuration and create sync state', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      // Mock schema validator
      const originalCompare = service['schemaValidator'].compareSchemas;
      const originalValidateSchema = service['schemaValidator'].validateSchemaCompatibility;
      service['schemaValidator'].compareSchemas = async () => ({
        compatible: true,
        missingTables: [],
        columnMismatches: [],
        typeMismatches: [],
      });
      service['schemaValidator'].validateSchemaCompatibility = async () => ({
        valid: true,
        errors: [],
        warnings: [],
      });

      // Mock CDC tracker
      const mockCDC = {
        initializeTracking: async () => {},
        teardownTracking: async () => {},
        captureChanges: async () => [],
        getCheckpoint: async () => 'checkpoint-0',
        updateCheckpoint: async () => {},
        cleanupChangeLogs: async () => 0,
      };
      service['getCDCTracker'] = () => mockCDC;

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      await service.activateSyncConfiguration(config.id, false);

      // Verify configuration is active
      const updated = await prisma.syncConfiguration.findUnique({
        where: { id: config.id },
        include: { syncState: true },
      });

      expect(updated?.isActive).toBe(true);
      expect(updated?.syncState).toBeDefined();
      expect(updated?.syncState?.status).toBe('ACTIVE');
      expect(updated?.syncState?.sourceCheckpoint).toBe('checkpoint-0');

      // Restore
      service['validateConnectionAccessibility'] = originalValidate;
      service['schemaValidator'].compareSchemas = originalCompare;
      service['schemaValidator'].validateSchemaCompatibility = originalValidateSchema;
    });

    it('should reject activation if already active', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Manually set to active
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });

      await expect(service.activateSyncConfiguration(config.id, false)).rejects.toThrow(
        'Sync configuration is already active'
      );

      service['validateConnectionAccessibility'] = originalValidate;
    });
  });

  describe('pauseSyncConfiguration', () => {
    it('should pause an active sync configuration', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create sync state manually
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });
      await prisma.syncState.create({
        data: {
          syncConfigId: config.id,
          status: 'ACTIVE',
        },
      });

      await service.pauseSyncConfiguration(config.id);

      const updated = await prisma.syncConfiguration.findUnique({
        where: { id: config.id },
        include: { syncState: true },
      });

      expect(updated?.syncState?.status).toBe('PAUSED');

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject pause if not active', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      await expect(service.pauseSyncConfiguration(config.id)).rejects.toThrow(
        'Sync configuration is not active'
      );

      service['validateConnectionAccessibility'] = originalValidate;
    });
  });

  describe('resumeSyncConfiguration', () => {
    it('should resume a paused sync configuration', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create paused sync state
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });
      await prisma.syncState.create({
        data: {
          syncConfigId: config.id,
          status: 'PAUSED',
        },
      });

      await service.resumeSyncConfiguration(config.id);

      const updated = await prisma.syncConfiguration.findUnique({
        where: { id: config.id },
        include: { syncState: true },
      });

      expect(updated?.syncState?.status).toBe('ACTIVE');

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject resume if not paused', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create active sync state
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });
      await prisma.syncState.create({
        data: {
          syncConfigId: config.id,
          status: 'ACTIVE',
        },
      });

      await expect(service.resumeSyncConfiguration(config.id)).rejects.toThrow(
        'Sync configuration is not paused'
      );

      service['validateConnectionAccessibility'] = originalValidate;
    });
  });

  describe('stopSyncConfiguration', () => {
    it('should stop an active sync configuration and remove sync state', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      // Mock CDC tracker
      const mockCDC = {
        initializeTracking: async () => {},
        teardownTracking: async () => {},
        captureChanges: async () => [],
        getCheckpoint: async () => 'checkpoint-0',
        updateCheckpoint: async () => {},
        cleanupChangeLogs: async () => 0,
      };
      service['getCDCTracker'] = () => mockCDC;

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create active sync state
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });
      const syncState = await prisma.syncState.create({
        data: {
          syncConfigId: config.id,
          status: 'ACTIVE',
        },
      });

      await service.stopSyncConfiguration(config.id);

      const updated = await prisma.syncConfiguration.findUnique({
        where: { id: config.id },
        include: { syncState: true },
      });

      expect(updated?.isActive).toBe(false);
      expect(updated?.syncState).toBeNull();

      // Verify sync state was deleted
      const deletedState = await prisma.syncState.findUnique({
        where: { id: syncState.id },
      });
      expect(deletedState).toBeNull();

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject stop if not active', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      await expect(service.stopSyncConfiguration(config.id)).rejects.toThrow(
        'Sync configuration is not active'
      );

      service['validateConnectionAccessibility'] = originalValidate;
    });
  });

  describe('triggerSync', () => {
    it('should trigger a manual sync job for an active configuration', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create active sync state
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });
      await prisma.syncState.create({
        data: {
          syncConfigId: config.id,
          status: 'ACTIVE',
        },
      });

      const jobId = await service.triggerSync(config.id, false);

      expect(jobId).toBeDefined();
      expect(jobId).toContain('sync-');

      // Verify sync state was updated with job ID
      const updated = await prisma.syncConfiguration.findUnique({
        where: { id: config.id },
        include: { syncState: true },
      });

      expect(updated?.syncState?.currentJobId).toBe(jobId);

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject trigger if configuration is not active', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      await expect(service.triggerSync(config.id, false)).rejects.toThrow(
        'Cannot trigger sync for inactive configuration'
      );

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject trigger if a sync job is already running', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create active sync state with existing job
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });
      await prisma.syncState.create({
        data: {
          syncConfigId: config.id,
          status: 'ACTIVE',
          currentJobId: 'existing-job-id',
        },
      });

      await expect(service.triggerSync(config.id, false)).rejects.toThrow(
        'A sync job is already running for this configuration'
      );

      service['validateConnectionAccessibility'] = originalValidate;
    });
  });

  describe('performFullSync', () => {
    it('should trigger a full sync job', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create active sync state
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });
      await prisma.syncState.create({
        data: {
          syncConfigId: config.id,
          status: 'ACTIVE',
        },
      });

      const jobId = await service.performFullSync(config.id);

      expect(jobId).toBeDefined();
      expect(jobId).toContain('sync-');

      service['validateConnectionAccessibility'] = originalValidate;
    });
  });

  describe('getSyncState', () => {
    it('should retrieve sync state for an active configuration', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create sync state
      await prisma.syncConfiguration.update({
        where: { id: config.id },
        data: { isActive: true },
      });
      const syncState = await prisma.syncState.create({
        data: {
          syncConfigId: config.id,
          status: 'ACTIVE',
          sourceCheckpoint: 'checkpoint-123',
          totalRowsSynced: BigInt(1000),
        },
      });

      const state = await service.getSyncState(config.id);

      expect(state).toBeDefined();
      expect(state!.id).toBe(syncState.id);
      expect(state!.status).toBe('ACTIVE');
      expect(state!.sourceCheckpoint).toBe('checkpoint-123');
      expect(state!.totalRowsSynced).toBe(BigInt(1000));

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should return null for configuration without sync state', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      const state = await service.getSyncState(config.id);

      expect(state).toBeNull();

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject if configuration does not exist', async () => {
      await expect(service.getSyncState('non-existent-id')).rejects.toThrow(
        'Sync configuration non-existent-id not found'
      );
    });
  });

  describe('getSyncHistory', () => {
    it('should retrieve sync history for a configuration', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create some history records
      await prisma.syncHistory.create({
        data: {
          syncConfigId: config.id,
          status: 'COMPLETED',
          rowsSynced: BigInt(100),
          tablesProcessed: 2,
          conflictsDetected: 0,
          conflictsResolved: 0,
          startedAt: new Date('2024-01-01T10:00:00Z'),
          completedAt: new Date('2024-01-01T10:05:00Z'),
          duration: 300000,
        },
      });

      await prisma.syncHistory.create({
        data: {
          syncConfigId: config.id,
          status: 'COMPLETED',
          rowsSynced: BigInt(50),
          tablesProcessed: 1,
          conflictsDetected: 1,
          conflictsResolved: 1,
          startedAt: new Date('2024-01-02T10:00:00Z'),
          completedAt: new Date('2024-01-02T10:03:00Z'),
          duration: 180000,
        },
      });

      const history = await service.getSyncHistory(config.id, 10);

      expect(history).toHaveLength(2);
      expect(history[0].status).toBe('COMPLETED');
      expect(history[0].rowsSynced).toBe(BigInt(50)); // Most recent first
      expect(history[1].rowsSynced).toBe(BigInt(100));

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should limit history results', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      // Create 5 history records
      for (let i = 0; i < 5; i++) {
        await prisma.syncHistory.create({
          data: {
            syncConfigId: config.id,
            status: 'COMPLETED',
            rowsSynced: BigInt(100 * i),
            tablesProcessed: 1,
            conflictsDetected: 0,
            conflictsResolved: 0,
            startedAt: new Date(`2024-01-0${i + 1}T10:00:00Z`),
            completedAt: new Date(`2024-01-0${i + 1}T10:05:00Z`),
            duration: 300000,
          },
        });
      }

      const history = await service.getSyncHistory(config.id, 3);

      expect(history).toHaveLength(3);

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should return empty array for configuration with no history', async () => {
      const originalValidate = service['validateConnectionAccessibility'];
      service['validateConnectionAccessibility'] = async () => {};

      const config = await service.createSyncConfiguration({
        userId: testUserId,
        name: 'Test Sync',
        sourceConnectionId,
        targetConnectionId,
      });

      const history = await service.getSyncHistory(config.id, 10);

      expect(history).toHaveLength(0);

      service['validateConnectionAccessibility'] = originalValidate;
    });

    it('should reject if configuration does not exist', async () => {
      await expect(service.getSyncHistory('non-existent-id', 10)).rejects.toThrow(
        'Sync configuration non-existent-id not found'
      );
    });
  });
});
