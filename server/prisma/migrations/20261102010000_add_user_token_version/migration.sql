-- Access-token invalidation: bumped on password change / revoke-all-sessions
ALTER TABLE "users" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
