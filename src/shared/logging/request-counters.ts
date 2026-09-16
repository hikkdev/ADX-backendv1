import { redis } from '../cache/redis';
import { logger } from './logger';

/**
 * Requests and 5xx answers per hour, kept a day in Redis — G13-B.
 *
 * `shared/errors` counts every 5xx per Indian day for the thirty-day
 * history; that series has no denominator, so it can say "how many" but
 * never "what share". The request logger drops every finished request into
 * one hash field per UTC hour here — and a 5xx into a second hash — so the
 * region read can answer the 5xx share over the last 24 hours as a rate.
 * Never awaited on the request path; a write that fails is a warning.
 * Fields older than the window are dropped on the way past a read.
 */

export const HOURLY_REQUESTS_KEY = 'api:requests:hours';
export const HOURLY_5XX_KEY = 'api:5xx:hours';
export const REQUEST_COUNT_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** The UTC hour an instant falls in, as the hash field. */
export const hourKey = (at: Date): string => String(Math.floor(at.getTime() / HOUR_MS));

export function recordRequestOutcome(statusCode: number, at = new Date()): void {
  const field = hourKey(at);
  const chain = redis.multi().hincrby(HOURLY_REQUESTS_KEY, field, 1);
  if (statusCode >= 500) chain.hincrby(HOURLY_5XX_KEY, field, 1);
  void chain.exec().catch((err: unknown) => logger.warn('Request outcome not counted', { reason: err instanceof Error ? err.message : String(err) }));
}

export type RequestCounts = { requests: number; serverErrors: number; hours: number };

/**
 * The last N hours of requests and 5xx answers, the current hour included.
 * Reads that fail answer zeros — the region row prints a null rate rather
 * than a 500 over a counter.
 */
export async function readRecentRequestCounts(now = new Date(), hours = REQUEST_COUNT_HOURS): Promise<RequestCounts> {
  const keep = new Set<string>();
  for (let back = 0; back < hours; back += 1) keep.add(hourKey(new Date(now.getTime() - back * HOUR_MS)));
  const sum = async (key: string): Promise<number> => {
    const stored = await redis.hgetall(key);
    let total = 0;
    const stale: string[] = [];
    for (const [field, value] of Object.entries(stored)) {
      if (keep.has(field)) total += Number(value) || 0;
      else stale.push(field);
    }
    if (stale.length > 0) {
      try {
        await redis.hdel(key, ...stale);
      } catch {
        // Pruning is housekeeping; the window still answers.
      }
    }
    return total;
  };
  try {
    const [requests, serverErrors] = await Promise.all([sum(HOURLY_REQUESTS_KEY), sum(HOURLY_5XX_KEY)]);
    return { requests, serverErrors, hours };
  } catch (err) {
    logger.warn('Request counts unreadable', { reason: err instanceof Error ? err.message : String(err) });
    return { requests: 0, serverErrors: 0, hours };
  }
}
