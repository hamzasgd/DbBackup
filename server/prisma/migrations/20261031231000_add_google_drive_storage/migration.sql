-- Google Drive as a storage provider (parity with S3)
ALTER TYPE "StorageProvider" ADD VALUE 'GOOGLE_DRIVE';

-- AlterTable
ALTER TABLE "storage_settings" ADD COLUMN "gdriveClientId" TEXT;
ALTER TABLE "storage_settings" ADD COLUMN "gdriveClientSecret" TEXT;
ALTER TABLE "storage_settings" ADD COLUMN "gdriveRefreshToken" TEXT;
ALTER TABLE "storage_settings" ADD COLUMN "gdriveFolderId" TEXT;
