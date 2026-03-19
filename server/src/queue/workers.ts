import { createBackupWorker } from './backup.queue';
import { createScheduleWorker } from './schedule.queue';
import { createMigrationWorker } from './migration.queue';
import { createSyncWorker } from './sync.queue';
import { logger } from '../config/logger';
import { SyncEngineService } from '../services/sync/sync-engine.service';
import { PrismaClient } from '@prisma/client';

let backupWorker: ReturnType<typeof createBackupWorker>;
let scheduleWorker: ReturnType<typeof createScheduleWorker>;
let migrationWorker: ReturnType<typeof createMigrationWorker>;
let syncWorker: ReturnType<typeof createSyncWorker>;

export async function startWorkers(): Promise<void> {
  backupWorker = createBackupWorker();
  scheduleWorker = createScheduleWorker();
  migrationWorker = createMigrationWorker();
  syncWorker = createSyncWorker();

  logger.info('✅ Queue workers started');
  logger.info(`Backup worker id=${backupWorker.id}`);
  logger.info(`Schedule worker id=${scheduleWorker.id}`);
  logger.info(`Migration worker id=${migrationWorker.id}`);
  logger.info(`Sync worker id=${syncWorker.id}`);

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
  logger.info('Workers stopped gracefully');
}
