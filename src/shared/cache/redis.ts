import '../../config/load-env';
import Redis from 'ioredis';
import { logger } from '../logging/logger';

const globalForRedis = globalThis as unknown as { redis?: Redis };

function createRedisClient(): Redis {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
  });
  client.on('error', (err) => logger.error('Redis connection error', { err: err.message }));
  return client;
}

export const redis = globalForRedis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}
