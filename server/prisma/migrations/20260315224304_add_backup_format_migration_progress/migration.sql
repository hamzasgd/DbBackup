-- CreateEnum
CREATE TYPE "BackupFormat" AS ENUM ('COMPRESSED_SQL', 'PLAIN_SQL', 'CUSTOM', 'DIRECTORY', 'TAR');

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "backups" ADD COLUMN     "format" "BackupFormat" NOT NULL DEFAULT 'COMPRESSED_SQL',
ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "migrations" (
    "id" TEXT NOT NULL,
    "sourceConnectionId" TEXT NOT NULL,
    "targetConnectionId" TEXT NOT NULL,
    "status" "MigrationStatus" NOT NULL DEFAULT 'PENDING',
    "tableCount" INTEGER NOT NULL DEFAULT 0,
    "tablesCompleted" INTEGER NOT NULL DEFAULT 0,
    "rowsMigrated" BIGINT NOT NULL DEFAULT 0,
    "currentTable" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "migrations_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "migrations" ADD CONSTRAINT "migrations_targetConnectionId_fkey" FOREIGN KEY ("targetConnectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
