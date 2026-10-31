-- Keep old backup passphrases (encrypted) so pre-rotation .enc backups stay decryptable
ALTER TABLE "storage_settings" ADD COLUMN "backupPassphraseHistory" JSONB;
