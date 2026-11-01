import express, { RequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'path';
import { rateLimit } from 'express-rate-limit';

import { logger } from './config/logger';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import authRoutes from './routes/auth.routes';
import connectionRoutes from './routes/connection.routes';
import backupRoutes from './routes/backup.routes';
import restoreRoutes from './routes/restore.routes';
import scheduleRoutes from './routes/schedule.routes';
import auditRoutes from './routes/audit.routes';
import exportRoutes from './routes/export.routes';
import migrationRoutes from './routes/migration.routes';
import notificationRoutes from './routes/notification.routes';
import storageRoutes from './routes/storage.routes';
import syncConfigRoutes from './routes/sync-config.routes';
import syncConflictRoutes from './routes/sync-conflict.routes';
import syncStateRoutes from './routes/sync-state.routes';
import syncOperationsRoutes from './routes/sync-operations.routes';
import { mcpRouter, keysRouter } from './routes/mcp.routes';
import { checkHealth } from './services/health.service';

const app = express();

// Behind a reverse proxy (nginx / aaPanel / Cloudflare): trust X-Forwarded-* so
// req.ip is the real client IP — rate limiting, login lockout and audit logging
// all key off it. Set TRUST_PROXY to the exact number of proxy hops in front of
// the app (e.g. 2 for Cloudflare + nginx), an IP/subnet, or 'false' to disable.
// Wrong hop counts let a client spoof its IP via X-Forwarded-For, so this is
// deliberately configurable instead of hard-coded.
const trustProxyEnv = process.env.TRUST_PROXY;
app.set(
  'trust proxy',
  trustProxyEnv === undefined ? 1
    : trustProxyEnv === 'false' ? false
    : /^\d+$/.test(trustProxyEnv) ? Number(trustProxyEnv)
    : trustProxyEnv,
);

// Security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://static.cloudflareinsights.com'],
      styleSrc: ["'self'", "'unsafe-inline'"], // Tailwind uses inline styles
      imgSrc: ["'self'", 'data:'], // app images are local/inline SVG only
      connectSrc: ["'self'", 'https://cloudflareinsights.com'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'none'"],
      frameSrc: ["'none'"],
    },
  },
}));

// helmet doesn't set Permissions-Policy — lock down powerful features the app never uses
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_URL) {
  logger.warn('CLIENT_URL is not set — CORS falls back to http://localhost:5173, which blocks the real frontend. Set it to your site origin.');
}
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(compression() as unknown as RequestHandler);

// Serialize BigInt fields (e.g. fileSize from Prisma BigInt columns) as numbers
app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? Number(value) : value
);

// Logging — strip JWT tokens from query strings to prevent leaking secrets into logs
if (process.env.NODE_ENV !== 'test') {
  morgan.token('sanitized-url', (req) => {
    const url = (req as unknown as { originalUrl?: string }).originalUrl || req.url || '';
    // Redact any query param whose name smells like a secret (token, password, key, secret, pass)
    return url.replace(/([?&])([^=&]*?(?:token|pass|secret|key|auth)[^=&]*?)=[^&]*/gi, (m: string, p1: string) => `${p1}[REDACTED]`);
  });
  app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :sanitized-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'));
}

// Health check
// Checks the app database, Redis and the queue workers; 503 when any is down,
// so an external uptime monitor (UptimeRobot, Better Stack, ...) can alert on it.
app.get('/health', async (_req, res) => {
  const health = await checkHealth();
  res.status(health.status === 'ok' ? 200 : 503).json(health);
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/connections', exportRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/restore', restoreRoutes);
app.use('/api/schedules', scheduleRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/migrations', migrationRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/sync/configurations', syncConfigRoutes);
app.use('/api/sync/configurations', syncStateRoutes);
app.use('/api/sync/configurations', syncOperationsRoutes);
app.use('/api/sync/conflicts', syncConflictRoutes);

// MCP (AI agent) endpoint + API-key management.
// /mcp is its own bearer-authenticated JSON-RPC surface — NOT under /api/.
app.use('/mcp', express.json({ limit: '1mb' }), mcpRouter);
app.use('/api/mcp/keys', keysRouter);

// Serve React frontend in production
if (process.env.NODE_ENV === 'production') {
  const clientPath = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientPath, { dotfiles: 'deny' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });
}

// Error handling
app.use(notFound);
app.use(errorHandler);

export default app;
