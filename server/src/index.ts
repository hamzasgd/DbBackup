import 'dotenv/config';
import app from './app';
import { logger } from './config/logger';
import { connectRedis, disconnectRedis } from './config/redis';
import { startWorkers, stopWorkers } from './queue/workers';
import { prisma } from './config/database';
import { initCrypto } from './services/crypto.service';
import fs from 'fs';
import path from 'path';

/** Loud warnings for common environment-file exposure mistakes. */
function auditEnvFileSecurity(): void {
  const envPath = path.join(process.cwd(), '.env');
  try {
    const mode = fs.statSync(envPath).mode & 0o077;
    if (mode !== 0) {
      logger.warn(`⚠️  .env is group/world readable (mode ${mode.toString(8).padStart(2, '0')}) — run: chmod 600 ${envPath}`);
    }
  } catch {
    /* no .env in cwd — nothing to audit */
  }
  if (process.env.NODE_ENV === 'production' && typeof process.getuid === 'function' && process.getuid() === 0) {
    logger.warn('⚠️  Running as root in production — use a dedicated unprivileged user for the app');
  }
  if (process.env.NODE_ENV === 'production' && !process.env.KMS_WRAPPED_MASTER_KEY && process.env.ENCRYPTION_KEY) {
    logger.warn('⚠️  ENCRYPTION_KEY is a plaintext env var — consider the KMS kill-switch (KMS_WRAPPED_MASTER_KEY) so the master key never touches disk');
  }
}
import { ensureStorageDir, getStoragePath } from './services/storage.service';

const PORT = process.env.PORT || 3001;

// Last-resort: a crash on an unhandled stream error (EPIPE etc.) takes the
// whole app down — log it, keep serving, and rely on PM2 restart if it recurs.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (app continuing):', err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection (app continuing):', reason);
});

async function bootstrap() {
  try {
    auditEnvFileSecurity();
    await initCrypto();
    ensureStorageDir(getStoragePath());
    await connectRedis();
    await startWorkers();

    const server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV}]`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      
      server.close(() => {
        logger.info('HTTP server closed');
      });

      await stopWorkers();
      logger.info('Workers stopped');

      await prisma.$disconnect();
      logger.info('Prisma disconnected');

      await disconnectRedis();
      logger.info('Redis disconnected');

      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        logger.error(`❌ Port ${PORT} is already in use. Run: lsof -ti :${PORT} | xargs kill -9`);
      } else {
        logger.error('Server error:', err);
      }
      process.exit(1);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

bootstrap();
