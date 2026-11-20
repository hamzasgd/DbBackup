-- MySQL/MariaDB: compress client-server traffic for backups and restores (off by default)
ALTER TABLE "connections" ADD COLUMN "compressTraffic" BOOLEAN NOT NULL DEFAULT false;
