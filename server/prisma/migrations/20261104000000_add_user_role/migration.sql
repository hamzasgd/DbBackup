-- Platform role for the super admin feature.
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';
-- Bootstrap: the earliest user (the owner — registration locks after them)
-- becomes the first super admin.
UPDATE "users" SET "role" = 'ADMIN'
WHERE "id" = (SELECT "id" FROM "users" ORDER BY "createdAt" ASC LIMIT 1);
