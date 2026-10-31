-- Restore drills: periodic test-restores into a scratch database
CREATE TABLE "restore_drills" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "tablesRestored" INTEGER,
    "rowsRestored" BIGINT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "restore_drills_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restore_drills_userId_startedAt_idx" ON "restore_drills"("userId", "startedAt");

-- AddForeignKey
ALTER TABLE "restore_drills" ADD CONSTRAINT "restore_drills_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "restore_drills" ADD CONSTRAINT "restore_drills_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "backups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
