import 'dotenv/config';
import app from './app';
import { logger } from './config/logger';
import { connectRedis } from './config/redis';
import { startWorkers } from './queue/workers';

const PORT = process.env.PORT || 3001;

async function bootstrap() {
  try {
    await connectRedis();
    await startWorkers();

    const server = app.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT} [${process.env.NODE_ENV}]`);
    });

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
