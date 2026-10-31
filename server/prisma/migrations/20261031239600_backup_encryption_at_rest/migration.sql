-- At-rest encryption of backup files (AES-256-GCM with stored passphrase)
ALTER TABLE "storage_settings" ADD COLUMN "backupEncryptionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "storage_settings" ADD COLUMN "backupPassphrase" TEXT;
