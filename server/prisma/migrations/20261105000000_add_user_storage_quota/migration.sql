-- Per-user storage quota (default 1 GB free; null = unlimited).
ALTER TABLE "users" ADD COLUMN "storageQuotaBytes" BIGINT DEFAULT 1073741824;
