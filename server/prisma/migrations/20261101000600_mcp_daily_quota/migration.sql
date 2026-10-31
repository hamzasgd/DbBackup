-- Per-key daily MCP call quota
ALTER TABLE "mcp_api_keys" ADD COLUMN "dailyCallLimit" INTEGER;
ALTER TABLE "mcp_api_keys" ADD COLUMN "callsToday" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "mcp_api_keys" ADD COLUMN "callsResetAt" TIMESTAMP(3);
