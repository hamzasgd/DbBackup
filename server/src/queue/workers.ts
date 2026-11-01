import { createBackupWorker } from './backup.queue';
import { createScheduleWorker } from './schedule.queue';
import { createMigrationWorker } from './migration.queue';
import { createSyncWorker } from './sync';
import { createRetentionWorker, scheduleRetentionSweep } from './retention.queue';
import { createRestoreWorker } from './restore.queue';
import { createHeartbeatWorker, scheduleHeartbeatChecks } from './heartbeat.queue';
import { logger } from '../config/logger';
import { SyncEngineService } from '../services/sync/sync-engine.service';
import { PrismaClient } from '@prisma/client';

let backupWorker: ReturnType<typeof createBackupWorker>;
let scheduleWorker: ReturnType<typeof createScheduleWorker>;
let migrationWorker: ReturnType<typeof createMigrationWorker>;
let syncWorker: ReturnType<typeof createSyncWorker>;
let retentionWorker: ReturnType<typeof createRetentionWorker>;
let restoreWorker: ReturnType<typeof createRestoreWorker>;
let heartbeatWorker: ReturnType<typeof createHeartbeatWorker>;

export async function startWorkers(): Promise<void> {
  backupWorker = createBackupWorker();
  scheduleWorker = createScheduleWorker();
  migrationWorker = createMigrationWorker();
  syncWorker = createSyncWorker();
  retentionWorker = createRetentionWorker();
  restoreWorker = createRestoreWorker();
  heartbeatWorker = createHeartbeatWorker();

  logger.info('✅ Queue workers started');
  logger.info(`Backup worker id=${backupWorker.id}`);
  logger.info(`Schedule worker id=${scheduleWorker.id}`);
  logger.info(`Migration worker id=${migrationWorker.id}`);
  logger.info(`Sync worker id=${syncWorker.id}`);
  logger.info(`Retention worker id=${retentionWorker.id}`);
  logger.info(`Restore worker id=${restoreWorker.id}`);
  logger.info(`Heartbeat worker id=${heartbeatWorker.id}`);

  // Register the daily global retention sweep
  try {
    await scheduleRetentionSweep();
  } catch (error) {
    logger.error('Failed to schedule retention sweep:', error);
  }

  // Register the periodic DB heartbeat monitor
  try {
    await scheduleHeartbeatChecks();
  } catch (error) {
    logger.error('Failed to schedule heartbeat checks:', error);
  }

  // Recover active real-time sync configurations after restart
  try {
    const syncEngine = new SyncEngineService();
    await syncEngine.recoverRealtimeConfigs();
  } catch (error) {
    logger.error('Failed to recover real-time sync configurations:', error);
  }
}

export async function stopWorkers(): Promise<void> {
  await backupWorker.close();
  await scheduleWorker.close();
  await migrationWorker.close();
  await syncWorker.close();
  await retentionWorker.close();
  await restoreWorker.close();
  await heartbeatWorker.close();
  logger.info('Workers stopped gracefully');
}
