import { redis } from './redis';
import { logger } from '../logging/logger';

/**
 * A small read-through cache over Redis for documents every request reads and
 * ops rarely change: the platform settings row, the feature-flag table.
 *
 * Redis rather than a process map because invalidation has to reach every
 * instance — a PUT on one box must not leave the others serving the old row
 * for a minute. Redis being down is not a reason to fail the request: every
 * error here is logged and the loader is called instead, so the worst case is
 * the database doing the work the cache would have saved.
 */
export async function readThrough<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch (err) {
    logger.warn('cache read failed; loading from source', { key, err: err instanceof Error ? err.message : String(err) });
  }
  const value = await load();
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn('cache write failed', { key, err: err instanceof Error ? err.message : String(err) });
  }
  return value;
}

/** Drops one cached document so the next read goes to the source. */
export async function invalidate(key: string): Promise<void> {
  try {
    await redis.del(key);
  } catch (err) {
    logger.warn('cache invalidate failed', { key, err: err instanceof Error ? err.message : String(err) });
  }
}
