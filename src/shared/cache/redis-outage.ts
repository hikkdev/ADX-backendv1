import { logger } from '../logging/logger';

/**
 * Redis going away must not take the API down with it (26 Sep 2026: the
 * backend kept crashing whenever the local Redis — a Docker container —
 * stopped with Docker Desktop). ioredis rejects every queued command once
 * it gives up (`MaxRetriesPerRequestError`) or once the socket is closed
 * ("Connection is closed."); a background caller that did not catch that
 * became an unhandled rejection, and Node ends the process on one.
 *
 * `isRedisOutage` recognises exactly those two ioredis failures — nothing
 * else — so the process-level net in `server.ts` can keep the server up
 * for a Redis outage while every other unexpected error still stops it.
 */
/**
 * 28 Sep 2026: thrown at once — instead of queuing a command for the ~30 s
 * ioredis spends retrying — by callers that must answer a request now (the
 * rate limiters) while the connection is known to be down. A Redis outage as
 * far as `isRedisOutage` and the error handler are concerned.
 */
export class RedisUnavailableError extends Error {
  static readonly NAME = 'RedisUnavailableError';
  constructor(message = 'Redis is unavailable') {
    super(message);
    this.name = RedisUnavailableError.NAME;
  }
}

/** ioredis states in which a command would only wait for a reconnect: fail fast instead. */
export function redisKnownDown(status: string): boolean {
  return status === 'reconnecting' || status === 'close' || status === 'end';
}

export function isRedisOutage(reason: unknown): boolean {
  if (!(reason instanceof Error)) return false;
  if (reason.name === 'MaxRetriesPerRequestError') return true;
  if (reason.name === RedisUnavailableError.NAME) return true;
  return reason.message === 'Connection is closed.' && /ioredis/.test(reason.stack ?? '');
}

/**
 * For a job's lock: the Redis answer, or null when Redis is unavailable —
 * the tick is skipped (logged) and the next one tries again.
 */
export async function orSkipWhenRedisDown<T>(call: Promise<T>, tag: string): Promise<T | null> {
  try {
    return await call;
  } catch (err) {
    logger.warn('Redis unavailable — tick skipped', { tag, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
