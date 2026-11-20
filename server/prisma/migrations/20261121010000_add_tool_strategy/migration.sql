-- AlterTable
ALTER TABLE "backups" ADD COLUMN     "strategy" TEXT NOT NULL DEFAULT 'TUNNEL';

-- AlterTable
ALTER TABLE "restores" ADD COLUMN     "strategy" TEXT NOT NULL DEFAULT 'TUNNEL';

-- AlterTable
ALTER TABLE "schedules" ADD COLUMN     "strategy" TEXT NOT NULL DEFAULT 'TUNNEL';

