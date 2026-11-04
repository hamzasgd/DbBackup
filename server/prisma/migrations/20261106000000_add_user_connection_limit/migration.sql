-- Per-user connection limit (default 5 free; null = unlimited).
ALTER TABLE "users" ADD COLUMN "connectionLimit" INTEGER DEFAULT 5;
