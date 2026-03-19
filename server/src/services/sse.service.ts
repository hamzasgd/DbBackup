import { Response } from 'express';
import { Redis } from 'ioredis';
import { getRedisConfig } from '../config/redis';
import { logger } from '../config/logger';
import { AppError } from '../middleware/errorHandler';

const MAX_SSE_CONNECTIONS = 50;
let activeSseConnections = 0;

// Dedicated Redis publisher client — MUST be separate from any subscriber
let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (!publisher) {
    publisher = new Redis(getRedisConfig());
    publisher.on('error', (err) => logger.error('SSE Redis publisher error:', err));
  }
  return publisher;
}

export const BACKUP_PROGRESS_CHANNEL = (id: string) => `backup:progress:${id}`;
export const MIGRATION_PROGRESS_CHANNEL = (id: string) => `migration:progress:${id}`;

export async function publishProgress(channel: string, payload: object): Promise<void> {
  const pub = getPublisher();
  await pub.publish(channel, JSON.stringify(payload));
}

/** Stream SSE events to client for a given Redis pub/sub channel */
export function streamSSE(res: Response, channel: string, timeoutMs = 300_000): void {
  // Rate limit SSE connections
  if (activeSseConnections >= MAX_SSE_CONNECTIONS) {
    throw new AppError('Too many SSE connections, please try again later', 429);
  }
  activeSseConnections++;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial heartbeat
  res.write('event: connected\ndata: {}\n\n');

  // Create a fresh subscriber for this connection
  const sub = new Redis(getRedisConfig());

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15_000);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeSseConnections--;
    clearInterval(heartbeat);
    sub.unsubscribe(channel).catch(() => {});
    sub.quit().catch(() => {});
  };

  sub.subscribe(channel, (err) => {
    if (err) {
      logger.error(`SSE subscribe error for ${channel}:`, err);
      res.end();
      cleanup();
      return;
    }
  });

  sub.on('message', (_ch, message) => {
    res.write(`data: ${message}\n\n`);
    // Auto-close when job is done
    try {
      const parsed = JSON.parse(message) as { status?: string; progress?: number };
      if (
        parsed.status === 'COMPLETED' ||
        parsed.status === 'FAILED' ||
        parsed.progress === 100
      ) {
        setTimeout(() => { res.end(); cleanup(); }, 1000);
      }
    } catch { /* ignore parse errors */ }
  });

  // Auto-close after timeout to avoid zombie connections
  const timeout = setTimeout(() => { res.end(); cleanup(); }, timeoutMs);

  res.on('close', () => {
    clearTimeout(timeout);
    cleanup();
  });
}
