-- Schema check / additive schema sync results of a compare or sync run
ALTER TABLE "data_sync_runs" ADD COLUMN "schema" JSONB;
