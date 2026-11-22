-- CreateTable
CREATE TABLE "db_access" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "hashNative" TEXT NOT NULL,
    "hashSha2" TEXT NOT NULL,
    "database" TEXT NOT NULL,
    "tables" TEXT[],
    "privileges" TEXT[],
    "maxConnections" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "backendUser" TEXT NOT NULL,
    "backendHost" TEXT NOT NULL,
    "backendPassword" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "db_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "db_access_sessions" (
    "id" TEXT NOT NULL,
    "accessId" TEXT NOT NULL,
    "clientIp" TEXT NOT NULL,
    "clientProgram" TEXT,
    "serverVersion" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "queries" INTEGER NOT NULL DEFAULT 0,
    "bytesIn" BIGINT NOT NULL DEFAULT 0,
    "bytesOut" BIGINT NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "db_access_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "db_access_queries" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "sql" TEXT NOT NULL,

    CONSTRAINT "db_access_queries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "db_access_username_key" ON "db_access"("username");

-- CreateIndex
CREATE INDEX "db_access_userId_idx" ON "db_access"("userId");

-- CreateIndex
CREATE INDEX "db_access_sessions_accessId_startedAt_idx" ON "db_access_sessions"("accessId", "startedAt");

-- CreateIndex
CREATE INDEX "db_access_queries_sessionId_at_idx" ON "db_access_queries"("sessionId", "at");

-- CreateIndex
CREATE INDEX "db_access_queries_at_idx" ON "db_access_queries"("at");

-- AddForeignKey
ALTER TABLE "db_access" ADD CONSTRAINT "db_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "db_access" ADD CONSTRAINT "db_access_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "db_access_sessions" ADD CONSTRAINT "db_access_sessions_accessId_fkey" FOREIGN KEY ("accessId") REFERENCES "db_access"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "db_access_queries" ADD CONSTRAINT "db_access_queries_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "db_access_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

