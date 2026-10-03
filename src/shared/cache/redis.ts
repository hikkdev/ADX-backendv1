import '../../config/load-env';
import Redis from 'ioredis';
import { logger } from '../logging/logger';
import { errorThrottled } from '../logging/throttled';

const globalForRedis = globalThis as unknown as { redis?: Redis };

function createRedisClient(): Redis {
  const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 3,
  });
  // Once a minute while it lasts, with how many were held back (28 Sep 2026) — not every 5 s reconnect.
  client.on('error', (err) => errorThrottled('Redis connection error', { err: err.message || err.name }));
  return client;
}

export const redis = globalForRedis.redis ?? createRedisClient();

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}
