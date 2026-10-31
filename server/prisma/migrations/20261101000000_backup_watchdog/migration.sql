-- Missed-backup watchdog: alert if no completed backup within N hours
ALTER TABLE "connections" ADD COLUMN "expectedBackupHours" INTEGER;
