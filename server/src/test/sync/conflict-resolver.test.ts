import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConflictResolverService } from '../../services/sync/conflict-resolver.service';
import { ConflictStrategy, DatabaseType, SyncDirection, SyncMode } from '@prisma/client';
import { prisma } from '../../config/database';

/**
 * Unit tests for ConflictResolverService
 * 
 * These tests verify conflict detection and resolution strategies
 * for bidirectional synchronization scenarios.
 */

describe('ConflictResolverService', () => {
  let service: ConflictResolverService;
  let testUserId: string;
  let testSyncConfigId: string;

  beforeEach(async () => {
    service = new ConflictResolverService();

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `test-conflict-${Date.now()}-${Math.random()}@example.com`,
        name: 'Test User',
        passwordHash: 'hash',
      },
    });
    testUserId = user.id;

    // Create test connections
    const sourceConnection = await prisma.connection.create({
      data: {
        name: 'Test Source',
        type: DatabaseType.MYSQL,
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'password',
        database: 'test_source',
        userId: testUserId,
      },
    });

    const targetConnection = await prisma.connection.create({
      data: {
        name: 'Test Target',
        type: DatabaseType.MYSQL,
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'password',
        database: 'test_target',
        userId: testUserId,
      },
    });

    // Create test sync configuration
    const syncConfig = await prisma.syncConfiguration.create({
      data: {
        userId: testUserId,
        sourceConnectionId: sourceConnection.id,
        targetConnectionId: targetConnection.id,
        name: 'Test Sync Config',
        direction: SyncDirection.BIDIRECTIONAL,
        mode: SyncMode.MANUAL,
        conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
      },
    });
    testSyncConfigId = syncConfig.id;
  });

  afterEach(async () => {
    // Cleanup
    try {
      await prisma.conflict.deleteMany({ where: { syncConfigId: testSyncConfigId } });
      await prisma.syncConfiguration.deleteMany({ where: { id: testSyncConfigId } });
      await prisma.connection.deleteMany({ where: { userId: testUserId } });
      await prisma.user.deleteMany({ where: { id: testUserId } });
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  });


  describe('detectConflicts', () => {
    it('should detect conflicts when same record is modified in both databases', async () => {
      const sourceLogs = [
        {
          id: '1',
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          operation: 'UPDATE',
          primaryKeyValues: { id: 123 },
          changeData: { name: 'Alice Updated' },
          timestamp: new Date('2024-03-15T10:00:00Z'),
          checkpoint: 'checkpoint-1',
          origin: 'source',
          synchronized: false,
          synchronizedAt: null,
        },
      ];

      const targetLogs = [
        {
          id: '2',
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          operation: 'UPDATE',
          primaryKeyValues: { id: 123 },
          changeData: { name: 'Alice Modified' },
          timestamp: new Date('2024-03-15T10:05:00Z'),
          checkpoint: 'checkpoint-2',
          origin: 'target',
          synchronized: false,
          synchronizedAt: null,
        },
      ];

      const conflicts = await service.detectConflicts(sourceLogs, targetLogs);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].tableName).toBe('users');
      expect(conflicts[0].primaryKeyValues).toEqual({ id: 123 });
      expect(conflicts[0].sourceData).toEqual({ name: 'Alice Updated' });
      expect(conflicts[0].targetData).toEqual({ name: 'Alice Modified' });
    });

    it('should not detect conflicts when different records are modified', async () => {
      const sourceLogs = [
        {
          id: '1',
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          operation: 'UPDATE',
          primaryKeyValues: { id: 123 },
          changeData: { name: 'Alice Updated' },
          timestamp: new Date('2024-03-15T10:00:00Z'),
          checkpoint: 'checkpoint-1',
          origin: 'source',
          synchronized: false,
          synchronizedAt: null,
        },
      ];

      const targetLogs = [
        {
          id: '2',
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          operation: 'UPDATE',
          primaryKeyValues: { id: 456 },
          changeData: { name: 'Bob Modified' },
          timestamp: new Date('2024-03-15T10:05:00Z'),
          checkpoint: 'checkpoint-2',
          origin: 'target',
          synchronized: false,
          synchronizedAt: null,
        },
      ];

      const conflicts = await service.detectConflicts(sourceLogs, targetLogs);

      expect(conflicts).toHaveLength(0);
    });

    it('should handle composite primary keys correctly', async () => {
      const sourceLogs = [
        {
          id: '1',
          syncConfigId: testSyncConfigId,
          tableName: 'order_items',
          operation: 'UPDATE',
          primaryKeyValues: { order_id: 100, item_id: 5 },
          changeData: { quantity: 10 },
          timestamp: new Date('2024-03-15T10:00:00Z'),
          checkpoint: 'checkpoint-1',
          origin: 'source',
          synchronized: false,
          synchronizedAt: null,
        },
      ];

      const targetLogs = [
        {
          id: '2',
          syncConfigId: testSyncConfigId,
          tableName: 'order_items',
          operation: 'UPDATE',
          primaryKeyValues: { order_id: 100, item_id: 5 },
          changeData: { quantity: 15 },
          timestamp: new Date('2024-03-15T10:05:00Z'),
          checkpoint: 'checkpoint-2',
          origin: 'target',
          synchronized: false,
          synchronizedAt: null,
        },
      ];

      const conflicts = await service.detectConflicts(sourceLogs, targetLogs);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].primaryKeyValues).toEqual({ order_id: 100, item_id: 5 });
    });
  });


  describe('resolveConflict', () => {
    it('should resolve conflict using LAST_WRITE_WINS strategy (target wins)', async () => {
      const mockConflict = {
        id: '',
        syncConfigId: testSyncConfigId,
        tableName: 'users',
        primaryKeyValues: { id: 123 },
        sourceData: { name: 'Alice Source', updated_at: '2024-03-15T10:00:00Z' },
        targetData: { name: 'Alice Target', updated_at: '2024-03-15T10:05:00Z' },
        sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
        targetTimestamp: new Date('2024-03-15T10:05:00Z'),
        strategy: ConflictStrategy.LAST_WRITE_WINS,
        resolution: null,
        resolvedData: null,
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: new Date(),
      };

      const result = await service.resolveConflict(mockConflict, ConflictStrategy.LAST_WRITE_WINS);

      expect(result.resolution).toBe('target');
      expect(result.resolvedData).toEqual(mockConflict.targetData);

      // Verify conflict was stored in database
      const storedConflict = await prisma.conflict.findUnique({
        where: { id: result.conflictId },
      });
      expect(storedConflict).not.toBeNull();
      expect(storedConflict?.resolved).toBe(true);
      expect(storedConflict?.resolution).toBe('target');
    });

    it('should resolve conflict using SOURCE_WINS strategy', async () => {
      const mockConflict = {
        id: '',
        syncConfigId: testSyncConfigId,
        tableName: 'users',
        primaryKeyValues: { id: 456 },
        sourceData: { name: 'Bob Source' },
        targetData: { name: 'Bob Target' },
        sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
        targetTimestamp: new Date('2024-03-15T10:05:00Z'),
        strategy: ConflictStrategy.SOURCE_WINS,
        resolution: null,
        resolvedData: null,
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: new Date(),
      };

      const result = await service.resolveConflict(mockConflict, ConflictStrategy.SOURCE_WINS);

      expect(result.resolution).toBe('source');
      expect(result.resolvedData).toEqual(mockConflict.sourceData);

      const storedConflict = await prisma.conflict.findUnique({
        where: { id: result.conflictId },
      });
      expect(storedConflict?.resolved).toBe(true);
      expect(storedConflict?.resolution).toBe('source');
    });

    it('should resolve conflict using TARGET_WINS strategy', async () => {
      const mockConflict = {
        id: '',
        syncConfigId: testSyncConfigId,
        tableName: 'users',
        primaryKeyValues: { id: 789 },
        sourceData: { name: 'Charlie Source' },
        targetData: { name: 'Charlie Target' },
        sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
        targetTimestamp: new Date('2024-03-15T10:05:00Z'),
        strategy: ConflictStrategy.TARGET_WINS,
        resolution: null,
        resolvedData: null,
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: new Date(),
      };

      const result = await service.resolveConflict(mockConflict, ConflictStrategy.TARGET_WINS);

      expect(result.resolution).toBe('target');
      expect(result.resolvedData).toEqual(mockConflict.targetData);

      const storedConflict = await prisma.conflict.findUnique({
        where: { id: result.conflictId },
      });
      expect(storedConflict?.resolved).toBe(true);
      expect(storedConflict?.resolution).toBe('target');
    });

    it('should create unresolved conflict for MANUAL_RESOLUTION strategy', async () => {
      const mockConflict = {
        id: '',
        syncConfigId: testSyncConfigId,
        tableName: 'users',
        primaryKeyValues: { id: 999 },
        sourceData: { name: 'Manual Source' },
        targetData: { name: 'Manual Target' },
        sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
        targetTimestamp: new Date('2024-03-15T10:05:00Z'),
        strategy: ConflictStrategy.MANUAL_RESOLUTION,
        resolution: null,
        resolvedData: null,
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: new Date(),
      };

      const result = await service.resolveConflict(mockConflict, ConflictStrategy.MANUAL_RESOLUTION);

      expect(result.resolution).toBe('manual');
      expect(result.resolvedData).toBeNull();

      const storedConflict = await prisma.conflict.findUnique({
        where: { id: result.conflictId },
      });
      expect(storedConflict?.resolved).toBe(false);
      expect(storedConflict?.strategy).toBe(ConflictStrategy.MANUAL_RESOLUTION);
    });
  });


  describe('resolveConflictManually', () => {
    it('should manually resolve an unresolved conflict', async () => {
      // First create an unresolved conflict
      const mockConflict = {
        id: '',
        syncConfigId: testSyncConfigId,
        tableName: 'users',
        primaryKeyValues: { id: 111 },
        sourceData: { name: 'Manual Source' },
        targetData: { name: 'Manual Target' },
        sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
        targetTimestamp: new Date('2024-03-15T10:05:00Z'),
        strategy: ConflictStrategy.MANUAL_RESOLUTION,
        resolution: null,
        resolvedData: null,
        resolved: false,
        resolvedAt: null,
        resolvedBy: null,
        createdAt: new Date(),
      };

      const result = await service.resolveConflict(mockConflict, ConflictStrategy.MANUAL_RESOLUTION);
      const conflictId = result.conflictId;

      // Now manually resolve it
      const resolution = { name: 'Alice Final', updated_at: '2024-03-15T10:10:00Z' };
      await service.resolveConflictManually(conflictId, resolution, testUserId);

      // Verify it was resolved
      const resolvedConflict = await prisma.conflict.findUnique({
        where: { id: conflictId },
      });

      expect(resolvedConflict?.resolved).toBe(true);
      expect(resolvedConflict?.resolution).toBe('manual');
      expect(resolvedConflict?.resolvedData).toEqual(resolution);
      expect(resolvedConflict?.resolvedBy).toBe(testUserId);
      expect(resolvedConflict?.resolvedAt).not.toBeNull();
    });

    it('should throw error if conflict not found', async () => {
      await expect(
        service.resolveConflictManually('nonexistent-id', {}, testUserId)
      ).rejects.toThrow('Conflict nonexistent-id not found');
    });

    it('should throw error if conflict already resolved', async () => {
      // Create a resolved conflict
      const conflict = await prisma.conflict.create({
        data: {
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          primaryKeyValues: { id: 222 },
          sourceData: { name: 'Already Resolved Source' },
          targetData: { name: 'Already Resolved Target' },
          sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
          targetTimestamp: new Date('2024-03-15T10:05:00Z'),
          strategy: ConflictStrategy.SOURCE_WINS,
          resolution: 'source',
          resolved: true,
          resolvedAt: new Date(),
        },
      });

      await expect(
        service.resolveConflictManually(conflict.id, {}, testUserId)
      ).rejects.toThrow(`Conflict ${conflict.id} is already resolved`);
    });
  });


  describe('getUnresolvedConflicts', () => {
    it('should return only unresolved conflicts', async () => {
      // Create resolved conflict
      await prisma.conflict.create({
        data: {
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          primaryKeyValues: { id: 1 },
          sourceData: { name: 'Resolved Source' },
          targetData: { name: 'Resolved Target' },
          sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
          targetTimestamp: new Date('2024-03-15T10:05:00Z'),
          strategy: ConflictStrategy.SOURCE_WINS,
          resolution: 'source',
          resolved: true,
          resolvedAt: new Date(),
        },
      });

      // Create unresolved conflict
      await prisma.conflict.create({
        data: {
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          primaryKeyValues: { id: 2 },
          sourceData: { name: 'Unresolved Source' },
          targetData: { name: 'Unresolved Target' },
          sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
          targetTimestamp: new Date('2024-03-15T10:05:00Z'),
          strategy: ConflictStrategy.MANUAL_RESOLUTION,
          resolved: false,
        },
      });

      const result = await service.getUnresolvedConflicts(testSyncConfigId);

      expect(result).toHaveLength(1);
      expect(result[0].resolved).toBe(false);
      expect(result[0].primaryKeyValues).toEqual({ id: 2 });
    });
  });

  describe('getConflictHistory', () => {
    it('should return conflict history with default limit', async () => {
      // Create multiple conflicts
      await prisma.conflict.create({
        data: {
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          primaryKeyValues: { id: 1 },
          sourceData: { name: 'History 1 Source' },
          targetData: { name: 'History 1 Target' },
          sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
          targetTimestamp: new Date('2024-03-15T10:05:00Z'),
          strategy: ConflictStrategy.SOURCE_WINS,
          resolution: 'source',
          resolved: true,
          resolvedAt: new Date(),
        },
      });

      await prisma.conflict.create({
        data: {
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          primaryKeyValues: { id: 2 },
          sourceData: { name: 'History 2 Source' },
          targetData: { name: 'History 2 Target' },
          sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
          targetTimestamp: new Date('2024-03-15T10:05:00Z'),
          strategy: ConflictStrategy.MANUAL_RESOLUTION,
          resolved: false,
        },
      });

      const result = await service.getConflictHistory(testSyncConfigId);

      expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('should return conflict history with custom limit', async () => {
      // Create a conflict
      await prisma.conflict.create({
        data: {
          syncConfigId: testSyncConfigId,
          tableName: 'users',
          primaryKeyValues: { id: 3 },
          sourceData: { name: 'Limited Source' },
          targetData: { name: 'Limited Target' },
          sourceTimestamp: new Date('2024-03-15T10:00:00Z'),
          targetTimestamp: new Date('2024-03-15T10:05:00Z'),
          strategy: ConflictStrategy.TARGET_WINS,
          resolution: 'target',
          resolved: true,
          resolvedAt: new Date(),
        },
      });

      const result = await service.getConflictHistory(testSyncConfigId, 1);

      expect(result.length).toBeLessThanOrEqual(1);
    });
  });
});
