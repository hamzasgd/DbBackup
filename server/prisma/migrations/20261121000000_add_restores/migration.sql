-- CreateTable
CREATE TABLE "restores" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "backupId" TEXT,
    "targetConnectionId" TEXT,
    "backupLabel" TEXT NOT NULL,
    "targetName" TEXT NOT NULL,
    "targetDatabase" TEXT NOT NULL,
    "overwritesSource" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stage" TEXT,
    "bytesRead" BIGINT NOT NULL DEFAULT 0,
    "totalBytes" BIGINT,
    "stageStartedAt" TIMESTAMP(3),
    "progressAt" TIMESTAMP(3),
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restores_userId_createdAt_idx" ON "restores"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "restores_targetConnectionId_status_idx" ON "restores"("targetConnectionId", "status");

-- AddForeignKey
ALTER TABLE "restores" ADD CONSTRAINT "restores_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restores" ADD CONSTRAINT "restores_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "backups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restores" ADD CONSTRAINT "restores_targetConnectionId_fkey" FOREIGN KEY ("targetConnectionId") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

