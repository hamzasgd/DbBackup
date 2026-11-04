-- Per-user max retention period for schedules (default 30 days; null = unlimited).
ALTER TABLE "users" ADD COLUMN "maxRetentionDays" INTEGER DEFAULT 30;
