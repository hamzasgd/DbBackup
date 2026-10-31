-- MCP approval mode: pending agent actions awaiting human approval
CREATE TABLE "mcp_approvals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mcpKeyId" TEXT NOT NULL,
    "keyName" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "args" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "mcp_approvals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mcp_approvals_userId_status_idx" ON "mcp_approvals"("userId", "status");
ALTER TABLE "mcp_approvals" ADD CONSTRAINT "mcp_approvals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "mcp_api_keys" ADD COLUMN "approvalRequired" BOOLEAN NOT NULL DEFAULT false;
