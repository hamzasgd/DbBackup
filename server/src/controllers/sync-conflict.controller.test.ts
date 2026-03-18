import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth.middleware';
import { getUnresolvedConflicts, resolveConflict } from './sync-conflict.controller';
import { prisma } from '../config/database';
import { ConflictStrategy, DatabaseType, SyncDirection, SyncMode } from '@prisma/client';

/**
 * Unit tests for sync-conflict.controller.ts
 * Tests Requirements 4.7, 4.8
 */
describe('SyncConflictController', () => {
  let testUserId: string;
  let testSourceConnectionId: string;
  let testTargetConnectionId: string;
  let testSyncConfigId: string;
  let testConflictId: string;

  beforeEach(async () => {
    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        name: 'Test User',
        passwordHash: 'hashedpassword',
        isActive: true,
      },
    });
    testUserId = user.id;

    // Create test connections
    const sourceConnection = await prisma.connection.create({
      data: {
        userId: testUserId,
        name: 'Test Source',
        type: DatabaseType.MYSQL,
        host: 'localhost',
        port: 3306,
        database: 'test_source',
        username: 'test',
        password: 'test',
      },
    });
    testSourceConnectionId = sourceConnection.id;

    const targetConnection = await prisma.connection.create({
      data: {
        userId: testUserId,
        name: 'Test Target',
        type: DatabaseType.MYSQL,
        host: 'localhost',
        port: 3306,
        database: 'test_target',
        username: 'test',
        password: 'test',
      },
    });
    testTargetConnectionId = targetConnection.id;

    // Create test sync configuration
    const syncConfig = await prisma.syncConfiguration.create({
      data: {
        userId: testUserId,
        name: 'Test Sync Config',
        sourceConnectionId: testSourceConnectionId,
        targetConnectionId: testTargetConnectionId,
        direction: SyncDirection.BIDIRECTIONAL,
        mode: SyncMode.MANUAL,
        conflictStrategy: ConflictStrategy.MANUAL_RESOLUTION,
      },
    });
    testSyncConfigId = syncConfig.id;

    // Create test conflict
    const conflict = await prisma.conflict.create({
      data: {
        syncConfigId: testSyncConfigId,
        tableName: 'users',
        primaryKeyValues: { id: 1 },
        sourceData: { id: 1, name: 'Source Name', updated_at: '2024-01-01T10:00:00Z' },
        targetData: { id: 1, name: 'Target Name', updated_at: '2024-01-01T11:00:00Z' },
        sourceTimestamp: new Date('2024-01-01T10:00:00Z'),
        targetTimestamp: new Date('2024-01-01T11:00:00Z'),
        strategy: ConflictStrategy.MANUAL_RESOLUTION,
        resolved: false,
      },
    });
    testConflictId = conflict.id;
  });

  afterEach(async () => {
    // Clean up test data
    await prisma.conflict.deleteMany({ where: { syncConfigId: testSyncConfigId } });
    await prisma.syncConfiguration.deleteMany({ where: { id: testSyncConfigId } });
    await prisma.connection.deleteMany({ where: { userId: testUserId } });
    await prisma.user.deleteMany({ where: { id: testUserId } });
  });

  describe('getUnresolvedConflicts', () => {
    it('should return unresolved conflicts for a valid sync configuration', async () => {
      const req = {
        params: { id: testSyncConfigId },
        user: { userId: testUserId, email: 'test@example.com' },
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(),
      } as unknown as Response;

      const next = vi.fn() as NextFunction;

      await getUnresolvedConflicts(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            id: testConflictId,
            tableName: 'users',
            resolved: false,
          }),
        ]),
      });
    });

    it('should return 404 if sync configuration does not exist', async () => {
      const req = {
        params: { id: 'non-existent-id' },
        user: { userId: testUserId, email: 'test@example.com' },
      } as unknown as AuthRequest;

      const res = {} as Response;
      const next = vi.fn() as NextFunction;

      await getUnresolvedConflicts(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Sync configuration not found',
          statusCode: 404,
        })
      );
    });

    it('should return 403 if user does not own the connections', async () => {
      // Create another user
      const otherUser = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          name: 'Other User',
          passwordHash: 'hashedpassword',
          isActive: true,
        },
      });

      const req = {
        params: { id: testSyncConfigId },
        user: { userId: otherUser.id, email: 'other@example.com' },
      } as unknown as AuthRequest;

      const res = {} as Response;
      const next = vi.fn() as NextFunction;

      await getUnresolvedConflicts(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Access denied',
          statusCode: 403,
        })
      );

      // Clean up
      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });

  describe('resolveConflict', () => {
    it('should resolve conflict with SOURCE resolution', async () => {
      const req = {
        params: { conflictId: testConflictId },
        body: { resolution: 'SOURCE' },
        user: { userId: testUserId, email: 'test@example.com' },
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(),
      } as unknown as Response;

      const next = vi.fn() as NextFunction;

      await resolveConflict(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Conflict resolved successfully',
      });

      // Verify conflict was resolved
      const updatedConflict = await prisma.conflict.findUnique({
        where: { id: testConflictId },
      });
      expect(updatedConflict?.resolved).toBe(true);
      expect(updatedConflict?.resolution).toBe('manual');
      expect(updatedConflict?.resolvedBy).toBe(testUserId);
    });

    it('should resolve conflict with TARGET resolution', async () => {
      const req = {
        params: { conflictId: testConflictId },
        body: { resolution: 'TARGET' },
        user: { userId: testUserId, email: 'test@example.com' },
      } as unknown as AuthRequest;

      const res = {
        json: vi.fn(),
      } as unknown as Response;

      const next = vi.fn() as NextFunction;

      await resolveConflict(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        message: 'Conflict resolved successfully',
      });

      // Verify conflict was resolved with target data
      const updatedConflict = await prisma.conflict.findUnique({
        where: { id: testConflictId },
      });
      expect(updatedConflict?.resolved).toBe(true);
      expect(updatedConflict?.resolvedData).toEqual({
        id: 1,
        name: 'Target Name',
        updated_at: '2024-01-01T11:00:00Z',
      });
    });

    it('should return 400 for invalid resolution parameter', async () => {
      const req = {
        params: { conflictId: testConflictId },
        body: { resolution: 'INVALID' },
        user: { userId: testUserId, email: 'test@example.com' },
      } as unknown as AuthRequest;

      const res = {} as Response;
      const next = vi.fn() as NextFunction;

      await resolveConflict(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid resolution. Must be "SOURCE" or "TARGET"',
          statusCode: 400,
        })
      );
    });

    it('should return 404 if conflict does not exist', async () => {
      const req = {
        params: { conflictId: 'non-existent-id' },
        body: { resolution: 'SOURCE' },
        user: { userId: testUserId, email: 'test@example.com' },
      } as unknown as AuthRequest;

      const res = {} as Response;
      const next = vi.fn() as NextFunction;

      await resolveConflict(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Conflict not found',
          statusCode: 404,
        })
      );
    });

    it('should return 403 if user does not own the connections', async () => {
      // Create another user
      const otherUser = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          name: 'Other User',
          passwordHash: 'hashedpassword',
          isActive: true,
        },
      });

      const req = {
        params: { conflictId: testConflictId },
        body: { resolution: 'SOURCE' },
        user: { userId: otherUser.id, email: 'other@example.com' },
      } as unknown as AuthRequest;

      const res = {} as Response;
      const next = vi.fn() as NextFunction;

      await resolveConflict(req, res, next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Access denied',
          statusCode: 403,
        })
      );

      // Clean up
      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });
});
