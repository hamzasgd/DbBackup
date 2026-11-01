import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { prisma } from '../config/database';
import { logAudit } from '../services/audit.service';
import { logger } from '../config/logger';
import {
  toolSummaries,
  dispatchTool,
  hashMcpKey,
  type McpScope,
  type McpToolContext,
} from '../services/mcp.service';
import { authenticate } from '../middleware/auth.middleware';
import { AuthRequest } from '../middleware/auth.middleware';
import { AppError } from '../middleware/errorHandler';
import { generateMcpKey, approveMcpAction, denyMcpAction } from '../services/mcp.service';

/**
 * MCP (Model Context Protocol) over Streamable HTTP — a minimal JSON-RPC 2.0
 * server at POST /mcp. AI agents authenticate with a scoped API key
 * (Authorization: Bearer dbbk_mcp_...). Every tool call is audited.
 *
 * Key management lives under /api/mcp/keys (normal JWT session auth).
 */

const PROTOCOL_VERSION = '2025-06-18';

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Rate limit exceeded' } },
});

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface AuthedKey {
  id: string;
  name: string;
  userId: string;
  scopes: string[];
  approvalRequired?: boolean;
}

async function authenticateKey(authHeader: string | undefined): Promise<AuthedKey | null> {
  // Parsed without a regex: `\s+(.+)` backtracks polynomially on long whitespace runs
  const header = authHeader ?? '';
  const sep = header.search(/\s/);
  if (sep < 1 || header.slice(0, sep).toLowerCase() !== 'bearer') return null;
  const bearer = header.slice(sep).trim();
  if (!bearer) return null;
  const key = await prisma.mcpApiKey.findUnique({
    where: { keyHash: hashMcpKey(bearer) },
    include: { user: { select: { isActive: true } } },
  });
  if (!key || key.revokedAt || key.user.isActive !== true) return null;
  if (key.expiresAt && key.expiresAt < new Date()) return null;
  return { id: key.id, name: key.name, userId: key.userId, scopes: key.scopes, approvalRequired: key.approvalRequired };
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

const mcpRouter = Router();

mcpRouter.post('/', mcpLimiter, async (req, res: Response, next) => {
  try {
    const authed = await authenticateKey(req.headers.authorization);
    if (!authed) {
      res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Invalid or revoked MCP API key' } });
      return;
    }

    const body = req.body as JsonRpcRequest | JsonRpcRequest[];
    const messages = Array.isArray(body) ? body : [body];
    const responses: unknown[] = [];

    for (const msg of messages) {
      if (!msg || typeof msg.method !== 'string') continue;

      // Notifications (no id) get a bare 202 — nothing to answer
      if (msg.id === undefined || msg.id === null) {
        res.status(202).end();
        return;
      }

      switch (msg.method) {
        case 'initialize':
          responses.push(rpcResult(msg.id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'dbbackup', version: '1.0.0' },
            instructions: 'DbBackup — database backup management. Scoped API key; destructive tools need the admin scope. Every call is audited.',
          }));
          break;

        case 'ping':
          responses.push(rpcResult(msg.id, {}));
          break;

        case 'tools/list': {
          responses.push(rpcResult(msg.id, { tools: toolSummaries(authed.scopes as McpScope[]) }));
          break;
        }

        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          const ctx: McpToolContext = {
            userId: authed.userId,
            keyId: authed.id,
            keyName: authed.name,
            scopes: authed.scopes as McpScope[],
            ip: req.ip,
            approvalRequired: authed.approvalRequired,
          };
          const started = Date.now();
          const result = await dispatchTool(name, args, ctx);
          await logAudit(authed.userId, 'MCP_CALL', 'mcp', {
            key: authed.name,
            tool: name,
            ok: !result.isError,
            ms: Date.now() - started,
          }, req.ip, req.headers['user-agent']);
          responses.push(rpcResult(msg.id, {
            content: [{ type: 'text', text: result.text }],
            isError: result.isError,
            ...(result.pendingApproval ? { approvalId: result.approvalId, pendingApproval: true } : {}),
          }));
          break;
        }

        default:
          responses.push(rpcError(msg.id, -32601, `Method not found: ${msg.method}`));
      }
    }

    res.json(Array.isArray(body) ? responses : responses[0]);
  } catch (err) {
    logger.error('MCP endpoint error:', err);
    res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } });
  }
});

// ─── Key management (JWT session auth) ──────────────────────────────────────

const keysRouter = Router();
keysRouter.use(authenticate);

keysRouter.get('/', async (req: AuthRequest, res, next) => {
  try {
    const keys = await prisma.mcpApiKey.findMany({
      where: { userId: req.user!.userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, keyPrefix: true, scopes: true, lastUsedAt: true, expiresAt: true, createdAt: true, approvalRequired: true, dailyCallLimit: true, callsToday: true },
    });
    res.json({ success: true, data: { keys } });
  } catch (err) { next(err); }
});

keysRouter.post('/', async (req: AuthRequest, res, next) => {
  try {
    const { name, scopes, expiresInDays, approvalRequired, dailyCallLimit } = req.body as { name?: string; scopes?: string[]; expiresInDays?: number; approvalRequired?: boolean; dailyCallLimit?: number };
    if (!name || typeof name !== 'string' || name.length > 60) throw new AppError('Key name is required (max 60 chars)', 400);
    const valid: McpScope[] = ['read', 'write', 'admin'];
    const requested = Array.isArray(scopes) && scopes.length > 0 ? scopes : ['read'];
    for (const s of requested) {
      if (!valid.includes(s as McpScope)) throw new AppError(`Invalid scope: ${s} (allowed: read, write, admin)`, 400);
    }
    // admin implies write implies read
    const finalScopes = new Set<McpScope>(requested as McpScope[]);
    if (finalScopes.has('admin')) { finalScopes.add('write'); finalScopes.add('read'); }
    if (finalScopes.has('write')) finalScopes.add('read');

    const expiresAt = expiresInDays && Number(expiresInDays) > 0
      ? new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000)
      : null;

    const { raw, hash, prefix } = generateMcpKey();
    const key = await prisma.mcpApiKey.create({
      data: {
        id: crypto.randomUUID(),
        userId: req.user!.userId,
        name,
        keyHash: hash,
        keyPrefix: prefix,
        scopes: [...finalScopes],
        expiresAt,
        approvalRequired: !!approvalRequired,
        dailyCallLimit: dailyCallLimit ? Math.max(1, Number(dailyCallLimit)) : null,
      },
    });
    await logAudit(req.user!.userId, 'MCP_KEY_CREATE', 'mcp', { keyId: key.id, name, scopes: [...finalScopes], expiresAt }, req.ip, req.headers['user-agent']);

    // Raw key is shown exactly once — only the hash is stored
    res.status(201).json({
      success: true,
      data: { id: key.id, name, scopes: [...finalScopes], expiresAt, key: raw },
      message: 'Copy this key now — it cannot be shown again',
    });
  } catch (err) { next(err); }
});

keysRouter.post('/:id/rotate', async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.mcpApiKey.findFirst({ where: { id: req.params.id, userId: req.user!.userId, revokedAt: null } });
    if (!existing) throw new AppError('Key not found', 404);

    // Generate a new key, replace the hash — old key stops working immediately
    const { raw, hash, prefix } = generateMcpKey();
    await prisma.mcpApiKey.update({
      where: { id: existing.id },
      data: { keyHash: hash, keyPrefix: prefix, callsToday: 0, lastUsedAt: null },
    });

    await logAudit(req.user!.userId, 'MCP_KEY_ROTATE', 'mcp', { keyId: existing.id, name: existing.name }, req.ip, req.headers['user-agent']);
    res.json({
      success: true,
      data: { key: raw },
      message: `Key "${existing.name}" rotated — the old key is now invalid. Copy the new key now.`,
    });
  } catch (err) { next(err instanceof AppError ? err : new AppError(err instanceof Error ? err.message : 'Rotate failed', 400)); }
});

keysRouter.delete('/:id', async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.mcpApiKey.findFirst({ where: { id: req.params.id, userId: req.user!.userId } });
    if (!existing) throw new AppError('Key not found', 404);
    await prisma.mcpApiKey.update({ where: { id: existing.id }, data: { revokedAt: new Date() } });
    await logAudit(req.user!.userId, 'MCP_KEY_REVOKE', 'mcp', { keyId: existing.id, name: existing.name }, req.ip, req.headers['user-agent']);
    res.json({ success: true, message: `Key "${existing.name}" revoked — agents using it get 401 immediately` });
  } catch (err) { next(err); }
});

// Pending MCP approvals (human-in-the-loop)
keysRouter.get('/approvals/pending', async (req: AuthRequest, res, next) => {
  try {
    const pending = await prisma.mcpApproval.findMany({
      where: { userId: req.user!.userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: { approvals: pending } });
  } catch (err) { next(err); }
});

keysRouter.post('/approvals/:id/approve', async (req: AuthRequest, res, next) => {
  try {
    const result = await approveMcpAction(req.user!.userId, req.params.id);
    await logAudit(req.user!.userId, 'MCP_APPROVE', 'mcp', { approvalId: req.params.id }, req.ip, req.headers['user-agent']);
    res.json({ success: true, data: result, message: 'Action executed' });
  } catch (err) { next(err instanceof AppError ? err : new AppError(err instanceof Error ? err.message : 'Approve failed', 400)); }
});

keysRouter.post('/approvals/:id/deny', async (req: AuthRequest, res, next) => {
  try {
    await denyMcpAction(req.user!.userId, req.params.id);
    await logAudit(req.user!.userId, 'MCP_DENY', 'mcp', { approvalId: req.params.id }, req.ip, req.headers['user-agent']);
    res.json({ success: true, message: 'Action denied' });
  } catch (err) { next(err instanceof AppError ? err : new AppError(err instanceof Error ? err.message : 'Deny failed', 400)); }
});

export { mcpRouter, keysRouter };
