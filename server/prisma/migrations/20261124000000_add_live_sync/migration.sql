-- Live sync: follow the source's binary log and apply each change to the target
ALTER TABLE "data_sync_runs" ADD COLUMN "liveSyncId" TEXT;

CREATE TABLE "live_syncs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sourceConnectionId" TEXT,
    "targetConnectionId" TEXT,
    "sourceName" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "sourceDatabase" TEXT NOT NULL,
    "targetDatabase" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'STARTING',
    "serverId" INTEGER NOT NULL,
    "binlogFile" TEXT,
    "binlogPos" BIGINT,
    "catchUpRunId" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "headFile" TEXT,
    "headPos" BIGINT,
    "checkedAt" TIMESTAMP(3),
    "inserted" BIGINT NOT NULL DEFAULT 0,
    "updated" BIGINT NOT NULL DEFAULT 0,
    "deleted" BIGINT NOT NULL DEFAULT 0,
    "transactions" BIGINT NOT NULL DEFAULT 0,
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_syncs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "live_syncs_userId_targetConnectionId_key" ON "live_syncs"("userId", "targetConnectionId");

ALTER TABLE "live_syncs" ADD CONSTRAINT "live_syncs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "live_syncs" ADD CONSTRAINT "live_syncs_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "live_syncs" ADD CONSTRAINT "live_syncs_targetConnectionId_fkey" FOREIGN KEY ("targetConnectionId") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
