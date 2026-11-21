-- Quick sync: compare only rows changed since the last completed sync
ALTER TABLE "data_sync_runs" ADD COLUMN "method" TEXT NOT NULL DEFAULT 'FULL';
-- The source server's clock when the run started (where the next quick run starts looking)
ALTER TABLE "data_sync_runs" ADD COLUMN "sourceTime" TIMESTAMP(3);
-- Quick runs: rows changed since this moment were compared
ALTER TABLE "data_sync_runs" ADD COLUMN "since" TIMESTAMP(3);
