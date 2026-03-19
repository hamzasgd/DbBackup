import { createBackupWorker } from './backup.queue';
import { createScheduleWorker } from './schedule.queue';
import { createMigrationWorker } from './migration.queue';
import { createSyncWorker } from './sync.queue';
import { logger } from '../config/logger';
import { SyncEngineService } from '../services/sync/sync-engine.service';

export async function startWorkers(): Promise<void> {
  const backupWorker = createBackupWorker();
  const scheduleWorker = createScheduleWorker();
  const migrationWorker = createMigrationWorker();
  const syncWorker = createSyncWorker();

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

  process.on('SIGTERM', async () => {
    await backupWorker.close();
    await scheduleWorker.close();
    await migrationWorker.close();
    await syncWorker.close();
    logger.info('Workers stopped gracefully');
  });
}
