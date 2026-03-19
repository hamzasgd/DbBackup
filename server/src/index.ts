import 'dotenv/config';
import app from './app';
import { logger } from './config/logger';
import { connectRedis, disconnectRedis } from './config/redis';
import { startWorkers, stopWorkers } from './queue/workers';
import { prisma } from './config/database';

const PORT = process.env.PORT || 3001;

async function bootstrap() {
  try {
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
