-- CreateTable
CREATE TABLE "data_sync_runs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceConnectionId" TEXT,
    "targetConnectionId" TEXT,
    "sourceName" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "sourceDatabase" TEXT NOT NULL,
    "targetDatabase" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "tables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "currentTable" TEXT,
    "tablesDone" INTEGER NOT NULL DEFAULT 0,
    "tablesTotal" INTEGER,
    "rowsChecked" BIGINT NOT NULL DEFAULT 0,
    "rowsEstimate" BIGINT,
    "results" JSONB,
    "error" TEXT,
    "progressAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_sync_runs_userId_createdAt_idx" ON "data_sync_runs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "data_sync_runs_targetConnectionId_status_idx" ON "data_sync_runs"("targetConnectionId", "status");

-- AddForeignKey
ALTER TABLE "data_sync_runs" ADD CONSTRAINT "data_sync_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_sync_runs" ADD CONSTRAINT "data_sync_runs_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_sync_runs" ADD CONSTRAINT "data_sync_runs_targetConnectionId_fkey" FOREIGN KEY ("targetConnectionId") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

