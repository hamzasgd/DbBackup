import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgreSQLCDCTracker } from '../../services/sync/postgresql-cdc-tracker.service';
import { prisma } from '../../config/database';
import { DatabaseType, SyncDirection, SyncMode, ConflictStrategy } from '@prisma/client';

/**
 * Unit tests for PostgreSQLCDCTracker
 * 
 * These tests verify the basic functionality of the PostgreSQL CDC tracker
 * including checkpoint management and change log operations.
 */

describe('PostgreSQLCDCTracker', () => {
  let tracker: PostgreSQLCDCTracker;
  let testUserId: string;
  let testSourceConnectionId: string;
  let testTargetConnectionId: string;
  let testSyncConfigId: string;

  beforeEach(async () => {
    tracker = new PostgreSQLCDCTracker();

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `test-pg-cdc-${Date.now()}-${Math.random()}@example.com`,
        name: 'Test User',
        passwordHash: 'hash',
      },
    });
    testUserId = user.id;

    // Create test connections
    const sourceConnection = await prisma.connection.create({
      data: {
        name: 'Test PostgreSQL Source',
        type: DatabaseType.POSTGRESQL,
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'password',
        database: 'test_source',
        userId: testUserId,
      },
    });
    testSourceConnectionId = sourceConnection.id;

    const targetConnection = await prisma.connection.create({
      data: {
        name: 'Test PostgreSQL Target',
        type: DatabaseType.POSTGRESQL,
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'password',
        database: 'test_target',
        userId: testUserId,
      },
    });
    testTargetConnectionId = targetConnection.id;

    // Create test sync configuration
    const syncConfig = await prisma.syncConfiguration.create({
      data: {
        userId: testUserId,
        sourceConnectionId: testSourceConnectionId,
        targetConnectionId: testTargetConnectionId,
        name: 'Test PostgreSQL Sync Config',
        direction: SyncDirection.UNIDIRECTIONAL,
        mode: SyncMode.MANUAL,
        conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
      },
    });
    testSyncConfigId = syncConfig.id;

    // Create sync state
    await prisma.syncState.create({
      data: {
        syncConfigId: testSyncConfigId,
      },
    });
  });

  afterEach(async () => {
    // Cleanup in reverse order
    try {
      await prisma.changeLog.deleteMany({ where: { syncConfigId: testSyncConfigId } });
      await prisma.syncState.deleteMany({ where: { syncConfigId: testSyncConfigId } });
      await prisma.syncConfiguration.deleteMany({ where: { id: testSyncConfigId } });
      await prisma.connection.deleteMany({ where: { id: testSourceConnectionId } });
      await prisma.connection.deleteMany({ where: { id: testTargetConnectionId } });
      await prisma.user.deleteMany({ where: { id: testUserId } });
    } catch (error) {
      // Ignore cleanup errors
      console.error('Cleanup error:', error);
    }
  });

  it('should update checkpoint for source', async () => {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id: testSyncConfigId },
    });

    expect(config).not.toBeNull();

    const checkpoint = '0/3000000';
    await tracker.updateCheckpoint(config!, checkpoint, 'source');

    const syncState = await prisma.syncState.findUnique({
      where: { syncConfigId: testSyncConfigId },
    });

    expect(syncState?.sourceCheckpoint).toBe(checkpoint);
  });

  it('should update checkpoint for target', async () => {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id: testSyncConfigId },
    });

    expect(config).not.toBeNull();

    const checkpoint = '0/4000000';
    await tracker.updateCheckpoint(config!, checkpoint, 'target');

    const syncState = await prisma.syncState.findUnique({
      where: { syncConfigId: testSyncConfigId },
    });

    expect(syncState?.targetCheckpoint).toBe(checkpoint);
  });

  it('should update checkpoint for trigger-based CDC', async () => {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id: testSyncConfigId },
    });

    expect(config).not.toBeNull();

    const checkpoint = '2024-03-15T10:30:00.000Z:123';
    await tracker.updateCheckpoint(config!, checkpoint, 'source');

    const syncState = await prisma.syncState.findUnique({
      where: { syncConfigId: testSyncConfigId },
    });

    expect(syncState?.sourceCheckpoint).toBe(checkpoint);
  });

  it('should clean up old change logs', async () => {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id: testSyncConfigId },
    });

    expect(config).not.toBeNull();

    // Create some test change logs
    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
    const recentDate = new Date();

    await prisma.changeLog.create({
      data: {
        syncConfigId: testSyncConfigId,
        tableName: 'test_table',
        operation: 'INSERT',
        primaryKeyValues: { id: 1 },
        checkpoint: 'test:1',
        synchronized: true,
        synchronizedAt: oldDate,
      },
    });

    await prisma.changeLog.create({
      data: {
        syncConfigId: testSyncConfigId,
        tableName: 'test_table',
        operation: 'UPDATE',
        primaryKeyValues: { id: 2 },
        checkpoint: 'test:2',
        synchronized: true,
        synchronizedAt: recentDate,
      },
    });

    // Clean up logs older than 3 days
    const cutoffDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const deletedCount = await tracker.cleanupChangeLogs(config!, cutoffDate);

    expect(deletedCount).toBe(1); // Only the old log should be deleted

    // Verify the recent log still exists
    const remainingLogs = await prisma.changeLog.findMany({
      where: { syncConfigId: testSyncConfigId },
    });
    expect(remainingLogs.length).toBe(1);
    expect(remainingLogs[0].primaryKeyValues).toEqual({ id: 2 });
  });

  it('should handle cleanup with no matching logs', async () => {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id: testSyncConfigId },
    });

    expect(config).not.toBeNull();

    const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const deletedCount = await tracker.cleanupChangeLogs(config!, cutoffDate);

    expect(deletedCount).toBe(0);
  });

  it('should clean up only synchronized logs', async () => {
    const config = await prisma.syncConfiguration.findUnique({
      where: { id: testSyncConfigId },
    });

    expect(config).not.toBeNull();

    const oldDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Create synchronized log (should be deleted)
    await prisma.changeLog.create({
      data: {
        syncConfigId: testSyncConfigId,
        tableName: 'test_table',
        operation: 'INSERT',
        primaryKeyValues: { id: 1 },
        checkpoint: 'test:1',
        synchronized: true,
        synchronizedAt: oldDate,
      },
    });

    // Create unsynchronized log (should NOT be deleted)
    await prisma.changeLog.create({
      data: {
        syncConfigId: testSyncConfigId,
        tableName: 'test_table',
        operation: 'UPDATE',
        primaryKeyValues: { id: 2 },
        checkpoint: 'test:2',
        synchronized: false,
        synchronizedAt: oldDate,
      },
    });

    const cutoffDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const deletedCount = await tracker.cleanupChangeLogs(config!, cutoffDate);

    expect(deletedCount).toBe(1); // Only the synchronized log should be deleted

    const remainingLogs = await prisma.changeLog.findMany({
      where: { syncConfigId: testSyncConfigId },
    });
    expect(remainingLogs.length).toBe(1);
    expect(remainingLogs[0].synchronized).toBe(false);
  });
});
