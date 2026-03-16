import { Redis } from 'ioredis';
import { logger } from './logger';

let redisClient: Redis;

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  maxRetriesPerRequest: null;
}

export function getRedisConfig(): RedisConfig {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}

export function getRedis(): Redis {
  if (!redisClient) {
    throw new Error('Redis not connected. Call connectRedis() first.');
  }
  return redisClient;
}

export async function connectRedis(): Promise<void> {
  redisClient = new Redis(getRedisConfig());

  return new Promise((resolve, reject) => {
    redisClient.on('connect', () => {
      logger.info('✅ Redis connected');
      resolve();
    });
    redisClient.on('error', (err: Error) => {
      logger.error('❌ Redis error:', err);
      reject(err);
    });
  });
}

export default getRedis;
