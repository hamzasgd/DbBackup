import crypto from 'crypto';
import { randomUUID as uuidv4 } from 'crypto';
import { prisma } from '../config/database';
import { decrypt, decryptIfPresent } from './crypto.service';
import { engineFactory } from './engines/engine.factory';
import { addBackupJob } from '../queue/backup.queue';
import { getHeartbeatSummary } from './heartbeat.service';
import { getStorageUsage } from './storage-alerts.service';
import { deleteBackupArtifact } from './storage.service';
import { verifyBackup } from './verification.service';
import path from 'path';

/**
 * MCP (Model Context Protocol) tool registry.
 *
 * AI agents connect with a scoped API key (see McpApiKey). Every tool is
 * bound to a scope — read / write / admin — and every call is audited with
 * the key name, tool, outcome and caller IP.
 */

export type McpScope = 'read' | 'write' | 'admin';

export interface McpToolContext {
  userId: string;
  keyId: string;
  keyName: string;
  scopes: McpScope[];
  ip?: string;
  approvalRequired?: boolean;
}

export interface McpToolDef {
  name: string;
  description: string;
  scope: McpScope;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx: McpToolContext) => Promise<string>;
}

function short(s: unknown, n = 400): string {
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function buildEngineConfig(conn: {
  type: string; host: string; port: number; username: string; password: string | null;
  database: string; sslEnabled: boolean; sshEnabled: boolean; sshHost: string | null;
  sshPort: number | null; sshUsername: string | null; sshPrivateKey: string | null;
  sshPrivateKeyPath: string | null; sshPassphrase: string | null;
}) {
  return {
    type: conn.type as Parameters<typeof engineFactory>[0]['type'],
    host: decrypt(conn.host),
    port: conn.port,
    username: decrypt(conn.username),
    password: conn.password ? decrypt(conn.password) : undefined,
    database: decrypt(conn.database),
    sslEnabled: conn.sslEnabled,
    sshEnabled: conn.sshEnabled,
    sshHost: decryptIfPresent(conn.sshHost) || undefined,
    sshPort: conn.sshPort || 22,
    sshUsername: decryptIfPresent(conn.sshUsername) || undefined,
    sshPrivateKey: decryptIfPresent(conn.sshPrivateKey) || undefined,
    sshPrivateKeyPath: conn.sshPrivateKeyPath ?? undefined,
    sshPassphrase: decryptIfPresent(conn.sshPassphrase) || undefined,
  };
}

async function ownedConnection(ctx: McpToolContext, connectionId: unknown) {
  if (typeof connectionId !== 'string' || !connectionId) throw new Error('connectionId (string) is required');
  const conn = await prisma.connection.findFirst({ where: { id: connectionId, userId: ctx.userId } });
  if (!conn) throw new Error(`Connection not found: ${connectionId}`);
  return conn;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'list_connections',
    description: 'List database connections with type, database, SSH-tunnel and heartbeat status.',
    scope: 'read',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, ctx) {
      const conns = await prisma.connection.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
        include: { heartbeats: { take: 1, orderBy: { checkedAt: 'desc' } } },
      });
      return short(conns.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        database: decrypt(c.database),
        sshEnabled: c.sshEnabled,
        heartbeatEnabled: c.heartbeatEnabled,
        heartbeat: c.heartbeats[0]
          ? { status: c.heartbeats[0].status, latencyMs: c.heartbeats[0].latencyMs, checkedAt: c.heartbeats[0].checkedAt }
          : null,
      })));
    },
  },
  {
    name: 'connection_test',
    description: 'Test connectivity for one connection (runs SELECT VERSION()).',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { connectionId: { type: 'string' } },
      required: ['connectionId'],
    },
    async handler(args, ctx) {
      const conn = await ownedConnection(ctx, args.connectionId);
      const engine = engineFactory(buildEngineConfig(conn));
      const result = await engine.testConnection();
      return short(result);
    },
  },
  {
    name: 'list_backups',
    description: 'List recent backups (status, size, storage, verification).',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 10, maximum: 50 } },
    },
    async handler(args, ctx) {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
      const backups = await prisma.backup.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { connection: { select: { name: true } } },
      });
      return short(backups.map((b) => ({
        id: b.id,
        connection: b.connection?.name ?? null,
        fileName: b.fileName,
        status: b.status,
        sizeBytes: Number(b.fileSize),
        storageType: b.storageType,
        encrypted: b.fileName.endsWith('.enc'),
        verified: b.verified,
        error: b.error,
        createdAt: b.createdAt,
      })));
    },
  },
  {
    name: 'get_backup',
    description: 'Get one backup by id (status, progress, error).',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { backupId: { type: 'string' } },
      required: ['backupId'],
    },
    async handler(args, ctx) {
      const b = await prisma.backup.findFirst({
        where: { id: String(args.backupId), userId: ctx.userId },
        include: { connection: { select: { name: true } } },
      });
      if (!b) throw new Error(`Backup not found: ${args.backupId}`);
      return short({
        id: b.id, connection: b.connection?.name ?? null, fileName: b.fileName, status: b.status,
        progress: b.progress, sizeBytes: Number(b.fileSize), storageType: b.storageType,
        verified: b.verified, error: b.error, createdAt: b.createdAt, completedAt: b.completedAt,
      });
    },
  },
  {
    name: 'trigger_backup',
    description: 'Trigger a new backup for a connection. Returns the backupId — poll get_backup for progress.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string' },
        format: { type: 'string', enum: ['COMPRESSED_SQL', 'PLAIN_SQL', 'CUSTOM', 'DIRECTORY', 'TAR'] },
      },
      required: ['connectionId'],
    },
    async handler(args, ctx) {
      const conn = await ownedConnection(ctx, args.connectionId);
      const defaultFormat = conn.type === 'POSTGRESQL' ? 'CUSTOM' : 'COMPRESSED_SQL';
      const format = (args.format as typeof defaultFormat) || defaultFormat;

      const backup = await prisma.backup.create({
        data: {
          id: uuidv4(),
          userId: ctx.userId,
          connectionId: conn.id,
          fileName: 'pending',
          filePath: 'pending',
          dbType: conn.type,
          dbName: decrypt(conn.database),
          status: 'PENDING',
          format,
          startedAt: new Date(),
        },
      });
      await addBackupJob({
        backupId: backup.id,
        connectionId: conn.id,
        outputDir: process.env.BACKUP_STORAGE_PATH || path.join(process.cwd(), 'backups'),
        format,
      });
      return JSON.stringify({ backupId: backup.id, status: 'PENDING', note: 'Poll get_backup for progress' });
    },
  },
  {
    name: 'heartbeat_status',
    description: 'Heartbeat health for one connection: current status, 24h uptime %, average latency, recent checks.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { connectionId: { type: 'string' } },
      required: ['connectionId'],
    },
    async handler(args, ctx) {
      const conn = await ownedConnection(ctx, args.connectionId);
      const summary = await getHeartbeatSummary(conn.id);
      return short({
        enabled: conn.heartbeatEnabled,
        latest: summary.latest,
        stats24h: summary.stats24h,
        recentChecks: summary.history.slice(0, 10),
      });
    },
  },
  {
    name: 'storage_usage',
    description: 'Storage usage for local disk, Google Drive and S3 budget, with the alert threshold.',
    scope: 'read',
    inputSchema: { type: 'object', properties: {} },
    async handler(_args, ctx) {
      return short(await getStorageUsage(ctx.userId));
    },
  },
  {
    name: 'activity_log',
    description: 'Recent audit events (logins, backups, changes) for this account.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 20, maximum: 100 } },
    },
    async handler(args, ctx) {
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
      const logs = await prisma.auditLog.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return short(logs.map((l) => ({ action: l.action, resource: l.resource, details: l.details, ip: l.ipAddress, at: l.createdAt })));
    },
  },
  {
    name: 'verify_backup',
    description: 'Re-verify a completed backup (downloads from S3/Drive if the local copy is gone).',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: { backupId: { type: 'string' } },
      required: ['backupId'],
    },
    async handler(args, ctx) {
      const b = await prisma.backup.findFirst({ where: { id: String(args.backupId), userId: ctx.userId } });
      if (!b) throw new Error(`Backup not found: ${args.backupId}`);
      if (b.status !== 'COMPLETED') throw new Error('Only completed backups can be verified');

      const { ensureLocalBackupFile, cleanupTempFile } = await import('./storage.service');
      const { localPath, downloaded } = await ensureLocalBackupFile(ctx.userId, b);
      try {
        const result = await verifyBackup(localPath, b.dbType, b.format);
        await prisma.backup.update({
          where: { id: b.id },
          data: { verified: result.valid, verifiedAt: new Date(), checksum: result.checksum || null },
        });
        return short(result);
      } finally {
        if (downloaded) cleanupTempFile(localPath);
      }
    },
  },
  {
    name: 'delete_backup',
    description: 'PERMANENTLY delete a backup (files on local/S3/Drive + record). Admin scope required.',
    scope: 'admin',
    inputSchema: {
      type: 'object',
      properties: { backupId: { type: 'string' } },
      required: ['backupId'],
    },
    async handler(args, ctx) {
      const b = await prisma.backup.findFirst({ where: { id: String(args.backupId), userId: ctx.userId } });
      if (!b) throw new Error(`Backup not found: ${args.backupId}`);
      await deleteBackupArtifact(ctx.userId, b);
      await prisma.backup.delete({ where: { id: b.id } });
      return JSON.stringify({ deleted: true, backupId: b.id });
    },
  },
];

export function toolSummaries(scopes: McpScope[]) {
  return MCP_TOOLS
    .filter((t) => scopes.includes(t.scope))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

export async function dispatchTool(name: string, args: Record<string, unknown>, ctx: McpToolContext): Promise<{ text: string; isError: boolean; approvalId?: string; pendingApproval?: boolean }> {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  if (!ctx.scopes.includes(tool.scope)) {
    return { text: `Tool "${name}" requires the "${tool.scope}" scope (key "${ctx.keyName}" has: ${ctx.scopes.join(', ') || 'none'})`, isError: true };
  }

  // Human-in-the-loop: destructive tools pause for approval when the key requires it
  if (ctx.approvalRequired && (tool.scope === 'write' || tool.scope === 'admin')) {
    const approval = await prisma.mcpApproval.create({
      data: {
        userId: ctx.userId,
        mcpKeyId: ctx.keyId,
        keyName: ctx.keyName,
        tool: name,
        args: args as object,
        status: 'PENDING',
      },
    });
    return {
      text: `⏸ Approval required: "${name}" is waiting for human approval. Check Settings → AI/MCP → Pending approvals. The owner will approve or deny it.`,
      isError: false,
      approvalId: approval.id,
      pendingApproval: true,
    };
  }

  try {
    // Per-key daily quota
    const key = await prisma.mcpApiKey.findUnique({ where: { id: ctx.keyId }, select: { dailyCallLimit: true, callsToday: true, callsResetAt: true } });
    if (key?.dailyCallLimit && key.dailyCallLimit > 0) {
      const now = new Date();
      const needsReset = !key.callsResetAt || new Date(key.callsResetAt) < now;
      const todayCount = needsReset ? 0 : key.callsToday;

      if (todayCount >= key.dailyCallLimit) {
        return {
          text: `Daily call limit reached (${key.dailyCallLimit}). Resets at midnight UTC. Current key: "${ctx.keyName}".`,
          isError: true,
        };
      }

      const nextReset = new Date(now);
      nextReset.setUTCHours(24, 0, 0, 0);
      await prisma.mcpApiKey.update({
        where: { id: ctx.keyId },
        data: { callsToday: todayCount + 1, callsResetAt: nextReset },
      });
    }

    const text = await tool.handler(args, ctx);
    await prisma.mcpApiKey.update({ where: { id: ctx.keyId }, data: { lastUsedAt: new Date() } });
    return { text, isError: false };
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}

/** Approve a pending MCP action and execute it. */
export async function approveMcpAction(userId: string, approvalId: string): Promise<{ text: string }> {
  const approval = await prisma.mcpApproval.findFirst({ where: { id: approvalId, userId, status: 'PENDING' } });
  if (!approval) throw new Error('Pending approval not found');

  const key = await prisma.mcpApiKey.findUnique({ where: { id: approval.mcpKeyId } });
  if (!key) throw new Error('MCP key no longer exists');

  const result = await dispatchTool(approval.tool, (approval.args ?? {}) as Record<string, unknown>, {
    userId,
    keyId: key.id,
    keyName: key.name,
    scopes: key.scopes as McpScope[],
    approvalRequired: false, // already approved
  });

  await prisma.mcpApproval.update({
    where: { id: approvalId },
    data: { status: 'APPROVED', result: result.text, resolvedAt: new Date() },
  });

  return { text: result.text };
}

/** Deny a pending MCP action. */
export async function denyMcpAction(userId: string, approvalId: string): Promise<void> {
  const result = await prisma.mcpApproval.updateMany({
    where: { id: approvalId, userId, status: 'PENDING' },
    data: { status: 'DENIED', resolvedAt: new Date() },
  });
  if (result.count === 0) throw new Error('Pending approval not found');
}

/** Key generation: raw key returned ONCE, only the SHA-256 hash is stored. */
export function generateMcpKey(): { raw: string; hash: string; prefix: string } {
  const raw = `dbbk_mcp_${crypto.randomBytes(24).toString('base64url')}`;
  return {
    raw,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    prefix: raw.slice(0, 16),
  };
}

export function hashMcpKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
