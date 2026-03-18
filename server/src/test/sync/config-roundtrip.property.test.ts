import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { prisma } from '../../config/database';
import { 
  SyncDirection, 
  SyncMode, 
  ConflictStrategy, 
  DatabaseType 
} from '@prisma/client';

// Feature: database-sync-tool, Property 1: Configuration Round-Trip Persistence
// Validates: Requirements 1.1, 1.3, 1.4, 1.5

/**
 * Property 1: Configuration Round-Trip Persistence
 * 
 * For any valid sync configuration with source connection, target connection, 
 * direction, conflict strategy, table filters, and schedule mode, creating and 
 * then retrieving the configuration should return an equivalent configuration 
 * with all fields preserved.
 */

describe('Property 1: Configuration Round-Trip Persistence', () => {
  it('should preserve all configuration fields through create and retrieve cycle', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate arbitrary sync configuration data
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 100 }),
          direction: fc.constantFrom(...Object.values(SyncDirection)),
          mode: fc.constantFrom(...Object.values(SyncMode)),
          conflictStrategy: fc.constantFrom(...Object.values(ConflictStrategy)),
          includeTables: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 10 }),
          excludeTables: fc.array(fc.string({ minLength: 1, maxLength: 50 }), { maxLength: 10 }),
          cronExpression: fc.option(fc.string({ minLength: 9, maxLength: 50 }), { nil: null }),
          batchSize: fc.integer({ min: 1, max: 10000 }),
          parallelTables: fc.integer({ min: 1, max: 10 }),
        }),
        async (configData) => {
          // Setup: Create test user and connections
          const user = await prisma.user.create({
            data: {
              email: `test-${Date.now()}-${Math.random()}@example.com`,
              name: 'Test User',
              passwordHash: 'hash',
            },
          });

          const sourceConnection = await prisma.connection.create({
            data: {
              name: 'Source DB',
              type: DatabaseType.MYSQL,
              host: 'localhost',
              port: 3306,
              username: 'root',
              password: 'password',
              database: 'source_db',
              userId: user.id,
            },
          });

          const targetConnection = await prisma.connection.create({
            data: {
              name: 'Target DB',
              type: DatabaseType.POSTGRESQL,
              host: 'localhost',
              port: 5432,
              username: 'postgres',
              password: 'password',
              database: 'target_db',
              userId: user.id,
            },
          });

          // Action: Create sync configuration
          const created = await prisma.syncConfiguration.create({
            data: {
              userId: user.id,
              sourceConnectionId: sourceConnection.id,
              targetConnectionId: targetConnection.id,
              name: configData.name,
              direction: configData.direction,
              mode: configData.mode,
              conflictStrategy: configData.conflictStrategy,
              includeTables: configData.includeTables,
              excludeTables: configData.excludeTables,
              cronExpression: configData.cronExpression,
              batchSize: configData.batchSize,
              parallelTables: configData.parallelTables,
            },
          });

          // Action: Retrieve the configuration
          const retrieved = await prisma.syncConfiguration.findUnique({
            where: { id: created.id },
          });

          // Assertion: All fields should be preserved
          expect(retrieved).not.toBeNull();
          expect(retrieved!.name).toBe(configData.name);
          expect(retrieved!.direction).toBe(configData.direction);
          expect(retrieved!.mode).toBe(configData.mode);
          expect(retrieved!.conflictStrategy).toBe(configData.conflictStrategy);
          expect(retrieved!.includeTables).toEqual(configData.includeTables);
          expect(retrieved!.excludeTables).toEqual(configData.excludeTables);
          expect(retrieved!.cronExpression).toBe(configData.cronExpression);
          expect(retrieved!.batchSize).toBe(configData.batchSize);
          expect(retrieved!.parallelTables).toBe(configData.parallelTables);
          expect(retrieved!.sourceConnectionId).toBe(sourceConnection.id);
          expect(retrieved!.targetConnectionId).toBe(targetConnection.id);
          expect(retrieved!.userId).toBe(user.id);
          expect(retrieved!.isActive).toBe(false); // Default value
          expect(retrieved!.id).toBe(created.id);
          expect(retrieved!.createdAt).toEqual(created.createdAt);
          expect(retrieved!.updatedAt).toEqual(created.updatedAt);

          // Cleanup
          await prisma.syncConfiguration.delete({ where: { id: created.id } });
          await prisma.connection.delete({ where: { id: sourceConnection.id } });
          await prisma.connection.delete({ where: { id: targetConnection.id } });
          await prisma.user.delete({ where: { id: user.id } });
        }
      ),
      { 
        numRuns: 100, // Run 100 iterations as specified in design
        verbose: true,
      }
    );
  });

  it('should handle edge cases: empty table filters', async () => {
    // Test with empty arrays for table filters
    const user = await prisma.user.create({
      data: {
        email: `test-edge-${Date.now()}@example.com`,
        name: 'Test User',
        passwordHash: 'hash',
      },
    });

    const sourceConnection = await prisma.connection.create({
      data: {
        name: 'Source DB',
        type: DatabaseType.MYSQL,
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'password',
        database: 'source_db',
        userId: user.id,
      },
    });

    const targetConnection = await prisma.connection.create({
      data: {
        name: 'Target DB',
        type: DatabaseType.POSTGRESQL,
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'password',
        database: 'target_db',
        userId: user.id,
      },
    });

    const created = await prisma.syncConfiguration.create({
      data: {
        userId: user.id,
        sourceConnectionId: sourceConnection.id,
        targetConnectionId: targetConnection.id,
        name: 'Edge Case Config',
        direction: SyncDirection.UNIDIRECTIONAL,
        mode: SyncMode.MANUAL,
        conflictStrategy: ConflictStrategy.LAST_WRITE_WINS,
        includeTables: [], // Empty array
        excludeTables: [], // Empty array
        batchSize: 500,
        parallelTables: 1,
      },
    });

    const retrieved = await prisma.syncConfiguration.findUnique({
      where: { id: created.id },
    });

    expect(retrieved).not.toBeNull();
    expect(retrieved!.includeTables).toEqual([]);
    expect(retrieved!.excludeTables).toEqual([]);

    // Cleanup
    await prisma.syncConfiguration.delete({ where: { id: created.id } });
    await prisma.connection.delete({ where: { id: sourceConnection.id } });
    await prisma.connection.delete({ where: { id: targetConnection.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('should handle edge cases: null cronExpression', async () => {
    // Test with null cronExpression (for non-scheduled modes)
    const user = await prisma.user.create({
      data: {
        email: `test-null-${Date.now()}@example.com`,
        name: 'Test User',
        passwordHash: 'hash',
      },
    });

    const sourceConnection = await prisma.connection.create({
      data: {
        name: 'Source DB',
        type: DatabaseType.MYSQL,
        host: 'localhost',
        port: 3306,
        username: 'root',
        password: 'password',
        database: 'source_db',
        userId: user.id,
      },
    });

    const targetConnection = await prisma.connection.create({
      data: {
        name: 'Target DB',
        type: DatabaseType.POSTGRESQL,
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'password',
        database: 'target_db',
        userId: user.id,
      },
    });

    const created = await prisma.syncConfiguration.create({
      data: {
        userId: user.id,
        sourceConnectionId: sourceConnection.id,
        targetConnectionId: targetConnection.id,
        name: 'Null Cron Config',
        direction: SyncDirection.BIDIRECTIONAL,
        mode: SyncMode.REALTIME,
        conflictStrategy: ConflictStrategy.SOURCE_WINS,
        cronExpression: null, // Null for non-scheduled mode
        batchSize: 1000,
        parallelTables: 5,
      },
    });

    const retrieved = await prisma.syncConfiguration.findUnique({
      where: { id: created.id },
    });

    expect(retrieved).not.toBeNull();
    expect(retrieved!.cronExpression).toBeNull();
    expect(retrieved!.mode).toBe(SyncMode.REALTIME);

    // Cleanup
    await prisma.syncConfiguration.delete({ where: { id: created.id } });
    await prisma.connection.delete({ where: { id: sourceConnection.id } });
    await prisma.connection.delete({ where: { id: targetConnection.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
