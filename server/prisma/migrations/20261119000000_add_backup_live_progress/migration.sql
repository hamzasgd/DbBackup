-- Live backup progress: bytes written, expected size, stage, heartbeat
ALTER TABLE "backups" ADD COLUMN "bytesWritten" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "backups" ADD COLUMN "expectedBytes" BIGINT;
ALTER TABLE "backups" ADD COLUMN "stage" TEXT;
ALTER TABLE "backups" ADD COLUMN "progressAt" TIMESTAMP(3);
ALTER TABLE "backups" ADD COLUMN "bytesChangedAt" TIMESTAMP(3);
