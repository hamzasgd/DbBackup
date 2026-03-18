-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('LOCAL', 'S3');

-- CreateEnum
CREATE TYPE "NotificationEvent" AS ENUM ('BACKUP_COMPLETED', 'BACKUP_FAILED', 'MIGRATION_COMPLETED', 'MIGRATION_FAILED', 'VERIFICATION_FAILED', 'RETENTION_CLEANUP');

-- AlterTable
ALTER TABLE "backups" ADD COLUMN     "checksum" TEXT,
ADD COLUMN     "storageKey" TEXT,
ADD COLUMN     "storageType" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "connectionTimeout" INTEGER DEFAULT 30000,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "retentionCount" INTEGER;

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT false,
    "emailAddress" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER DEFAULT 587,
    "smtpUser" TEXT,
    "smtpPass" TEXT,
    "smtpSecure" BOOLEAN NOT NULL DEFAULT false,
    "slackEnabled" BOOLEAN NOT NULL DEFAULT false,
    "slackWebhookUrl" TEXT,
    "notifyOnSuccess" BOOLEAN NOT NULL DEFAULT false,
    "notifyOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "notifyOnRetention" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "bucket" TEXT,
    "region" TEXT,
    "accessKeyId" TEXT,
    "secretAccessKey" TEXT,
    "endpoint" TEXT,
    "prefix" TEXT,
    "deleteLocal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_userId_key" ON "notification_settings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_settings_userId_key" ON "storage_settings"("userId");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_settings" ADD CONSTRAINT "storage_settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
