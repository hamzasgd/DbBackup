-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('UNIDIRECTIONAL', 'BIDIRECTIONAL');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('REALTIME', 'SCHEDULED', 'MANUAL');

-- CreateEnum
CREATE TYPE "ConflictStrategy" AS ENUM ('LAST_WRITE_WINS', 'SOURCE_WINS', 'TARGET_WINS', 'MANUAL_RESOLUTION');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('ACTIVE', 'PAUSED', 'FAILED', 'STOPPED');

-- CreateEnum
CREATE TYPE "ChangeOperation" AS ENUM ('INSERT', 'UPDATE', 'DELETE');

-- CreateTable
CREATE TABLE "sync_configurations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceConnectionId" TEXT NOT NULL,
    "targetConnectionId" TEXT NOT NULL,
    "direction" "SyncDirection" NOT NULL DEFAULT 'UNIDIRECTIONAL',
    "mode" "SyncMode" NOT NULL DEFAULT 'MANUAL',
    "conflictStrategy" "ConflictStrategy" NOT NULL DEFAULT 'LAST_WRITE_WINS',
    "includeTables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludeTables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cronExpression" TEXT,
    "batchSize" INTEGER NOT NULL DEFAULT 500,
    "parallelTables" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_states" (
    "id" TEXT NOT NULL,
    "syncConfigId" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceCheckpoint" TEXT,
    "targetCheckpoint" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3),
    "totalRowsSynced" BIGINT NOT NULL DEFAULT 0,
    "lastSyncDuration" INTEGER,
    "averageSyncDuration" INTEGER,
    "currentJobId" TEXT,
    "currentTable" TEXT,
    "currentProgress" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "change_logs" (
    "id" TEXT NOT NULL,
    "syncConfigId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "operation" "ChangeOperation" NOT NULL,
    "primaryKeyValues" JSONB NOT NULL,
    "changeData" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkpoint" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'source',
    "synchronized" BOOLEAN NOT NULL DEFAULT false,
    "synchronizedAt" TIMESTAMP(3),

    CONSTRAINT "change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conflicts" (
    "id" TEXT NOT NULL,
    "syncConfigId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "primaryKeyValues" JSONB NOT NULL,
    "sourceData" JSONB NOT NULL,
    "targetData" JSONB NOT NULL,
    "sourceTimestamp" TIMESTAMP(3) NOT NULL,
    "targetTimestamp" TIMESTAMP(3) NOT NULL,
    "strategy" "ConflictStrategy" NOT NULL,
    "resolution" TEXT,
    "resolvedData" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conflicts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_history" (
    "id" TEXT NOT NULL,
    "syncConfigId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rowsSynced" BIGINT NOT NULL DEFAULT 0,
    "tablesProcessed" INTEGER NOT NULL DEFAULT 0,
    "conflictsDetected" INTEGER NOT NULL DEFAULT 0,
    "conflictsResolved" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "error" TEXT,

    CONSTRAINT "sync_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sync_states_syncConfigId_key" ON "sync_states"("syncConfigId");

-- CreateIndex
CREATE INDEX "change_logs_syncConfigId_synchronized_timestamp_idx" ON "change_logs"("syncConfigId", "synchronized", "timestamp");

-- CreateIndex
CREATE INDEX "conflicts_syncConfigId_resolved_idx" ON "conflicts"("syncConfigId", "resolved");

-- CreateIndex
CREATE INDEX "sync_history_syncConfigId_startedAt_idx" ON "sync_history"("syncConfigId", "startedAt");

-- AddForeignKey
ALTER TABLE "sync_configurations" ADD CONSTRAINT "sync_configurations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_configurations" ADD CONSTRAINT "sync_configurations_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_configurations" ADD CONSTRAINT "sync_configurations_targetConnectionId_fkey" FOREIGN KEY ("targetConnectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_states" ADD CONSTRAINT "sync_states_syncConfigId_fkey" FOREIGN KEY ("syncConfigId") REFERENCES "sync_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_logs" ADD CONSTRAINT "change_logs_syncConfigId_fkey" FOREIGN KEY ("syncConfigId") REFERENCES "sync_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_syncConfigId_fkey" FOREIGN KEY ("syncConfigId") REFERENCES "sync_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_history" ADD CONSTRAINT "sync_history_syncConfigId_fkey" FOREIGN KEY ("syncConfigId") REFERENCES "sync_configurations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
