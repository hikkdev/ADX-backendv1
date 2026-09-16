import { redis } from '../cache/redis';
import { logger } from './logger';

/**
 * Request latency, kept a few minutes in Redis — Lot G (Q130).
 *
 * The request logger drops every request's duration into a list keyed by
 * the UTC minute it finished in; the health-sample job reads the *previous*
 * minute back — the one that is complete — and writes its p95 as the API's
 * own sample. Lists expire after three minutes, so this is a window and
 * never a log. Never awaited on the request path: a write that fails is a
 * warning, and the sample for that minute reads as "no traffic".
 */

const KEY_PREFIX = 'api:latency:';
const WINDOW_TTL_SECONDS = 3 * 60;

export const latencyMinuteKey = (at: Date): string => `${KEY_PREFIX}${Math.floor(at.getTime() / 60_000)}`;

export function recordRequestLatency(durationMs: number, at = new Date()): void {
  const key = latencyMinuteKey(at);
  void redis
    .multi()
    .rpush(key, String(Math.max(0, Math.round(durationMs))))
    .expire(key, WINDOW_TTL_SECONDS)
    .exec()
    .catch((err: unknown) => logger.warn('Request latency not recorded', { reason: err instanceof Error ? err.message : String(err) }));
}

/** The p95 of a sorted-in-place sample, by the nearest-rank method. Null when empty. */
export function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

/**
 * The previous minute's p95 and request count — `{ p95Ms: null, count: 0 }`
 * when nothing was served in it, which the sampler records as an OK sample
 * with no latency rather than as a failure.
 */
export async function readPreviousMinuteLatency(now = new Date()): Promise<{ p95Ms: number | null; count: number }> {
  const previous = new Date(now.getTime() - 60_000);
  const raw = await redis.lrange(latencyMinuteKey(previous), 0, -1);
  const values = raw.map((v) => Number(v)).filter((v) => Number.isFinite(v));
  return { p95Ms: percentile95(values), count: values.length };
}
