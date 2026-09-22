import { redis } from '../../shared/cache';
import type { LastFix } from './agent-locations.rules';

/**
 * LT-1: the live position, one record per agent in Redis — `agentloc:last:
 * <agentId>`, a day's TTL — and a sorted set `agentloc:index` of who has
 * one, scored by the fix's time, so the live map lists everybody in one
 * range read. No history here: the trail (Postgres) is the history.
 */
const LAST_KEY = (agentId: string) => `agentloc:last:${agentId}`;
const INDEX_KEY = 'agentloc:index';
export const LAST_FIX_TTL_SECONDS = 24 * 60 * 60;

export async function readLastFix(agentId: string): Promise<LastFix | null> {
  const raw = await redis.get(LAST_KEY(agentId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LastFix;
  } catch {
    return null;
  }
}

export async function writeLastFix(fix: LastFix): Promise<void> {
  await redis
    .multi()
    .set(LAST_KEY(fix.agentId), JSON.stringify(fix), 'EX', LAST_FIX_TTL_SECONDS)
    .zadd(INDEX_KEY, new Date(fix.at).getTime(), fix.agentId)
    .exec();
}

/** Every agent with a fix newer than `since`, newest first. */
export async function listLastFixes(since: Date, limit = 500): Promise<LastFix[]> {
  const ids = await redis.zrevrangebyscore(INDEX_KEY, '+inf', String(since.getTime()), 'LIMIT', 0, limit);
  if (ids.length === 0) return [];
  const raws = await redis.mget(...ids.map(LAST_KEY));
  const out: LastFix[] = [];
  raws.forEach((raw, index) => {
    if (!raw) {
      // The record expired under the index: drop the stale entry.
      void redis.zrem(INDEX_KEY, ids[index]!);
      return;
    }
    try {
      out.push(JSON.parse(raw) as LastFix);
    } catch {
      /* a corrupt record is not a fix */
    }
  });
  return out;
}

/** The agent's trip ended (the context closed): the live record loses its context but keeps the position. */
export async function clearFixContext(agentId: string): Promise<void> {
  const fix = await readLastFix(agentId);
  if (!fix || !fix.context) return;
  await writeLastFix({ ...fix, context: null, tripStart: null });
}

/** Tests: forget everything. */
export async function resetLiveStore(): Promise<void> {
  const ids = await redis.zrange(INDEX_KEY, '0', '-1');
  if (ids.length > 0) await redis.del(...ids.map(LAST_KEY));
  await redis.del(INDEX_KEY);
}
