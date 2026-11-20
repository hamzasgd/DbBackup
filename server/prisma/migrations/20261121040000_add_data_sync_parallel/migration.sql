-- Chunks a compare or sync checks at the same time (runs before this ran one at a time)
ALTER TABLE "data_sync_runs" ADD COLUMN "parallel" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "data_sync_runs" ALTER COLUMN "parallel" SET DEFAULT 4;
