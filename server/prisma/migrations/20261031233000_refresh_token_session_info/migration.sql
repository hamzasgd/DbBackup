-- Track where each session (refresh token) was created from
ALTER TABLE "refresh_tokens" ADD COLUMN "ipAddress" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "userAgent" TEXT;
