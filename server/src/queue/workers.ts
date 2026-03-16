import { createBackupWorker } from './backup.queue';
import { createScheduleWorker } from './schedule.queue';
import { createMigrationWorker } from './migration.queue';
import { logger } from '../config/logger';

export async function startWorkers(): Promise<void> {
  const backupWorker = createBackupWorker();
  const scheduleWorker = createScheduleWorker();
  const migrationWorker = createMigrationWorker();

  logger.info('✅ Queue workers started');

  process.on('SIGTERM', async () => {
    await backupWorker.close();
    await scheduleWorker.close();
    await migrationWorker.close();
    logger.info('Workers stopped gracefully');
  });
}
