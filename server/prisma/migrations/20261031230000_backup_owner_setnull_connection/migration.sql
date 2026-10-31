-- Backup ownership is denormalized onto the row so backups survive their
-- connection being deleted ("keep backups" option on connection delete).
ALTER TABLE "backups" ADD COLUMN "userId" TEXT NOT NULL DEFAULT '';

-- Backfill owner from each backup's connection (connectionId is still
-- NOT NULL at this point, so every row gets an owner).
UPDATE "backups" SET "userId" = COALESCE(
  (SELECT "userId" FROM "connections" WHERE "connections"."id" = "backups"."connectionId"),
  ''
);

-- Detach instead of cascade: deleting a connection keeps backup rows
-- (connectionId becomes NULL); schedules still cascade as before.
ALTER TABLE "backups" DROP CONSTRAINT "backups_connectionId_fkey";
ALTER TABLE "backups" ALTER COLUMN "connectionId" DROP NOT NULL;
ALTER TABLE "backups" ADD CONSTRAINT "backups_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "backups_userId_idx" ON "backups"("userId");
