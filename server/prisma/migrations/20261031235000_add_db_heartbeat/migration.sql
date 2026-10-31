-- DB heartbeat: per-connection health monitoring
ALTER TABLE "connections" ADD COLUMN "heartbeatEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "connection_heartbeats" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "error" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connection_heartbeats_connectionId_checkedAt_idx" ON "connection_heartbeats"("connectionId", "checkedAt");

-- AddForeignKey
ALTER TABLE "connection_heartbeats" ADD CONSTRAINT "connection_heartbeats_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
