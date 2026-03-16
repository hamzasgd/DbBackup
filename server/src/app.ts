import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'path';
import { rateLimit } from 'express-rate-limit';

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

const app = express();

// Security
app.use(helmet());
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
app.use(cookieParser());
app.use(compression());

// Serialize BigInt fields (e.g. fileSize from Prisma BigInt columns) as numbers
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () { return Number(this); };

// Logging — strip JWT tokens from query strings to prevent leaking secrets into logs
if (process.env.NODE_ENV !== 'test') {
  morgan.token('sanitized-url', (req) => {
    const url = (req as unknown as { originalUrl?: string }).originalUrl || req.url || '';
    return url.replace(/[?&]token=[^&]*/g, (m: string) => m.startsWith('?') ? '?token=[REDACTED]' : '&token=[REDACTED]');
  });
  app.use(morgan(':remote-addr - :remote-user [:date[clf]] ":method :sanitized-url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent"'));
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// Serve React frontend in production
if (process.env.NODE_ENV === 'production') {
  const clientPath = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientPath));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });
}

// Error handling
app.use(notFound);
app.use(errorHandler);

export default app;
