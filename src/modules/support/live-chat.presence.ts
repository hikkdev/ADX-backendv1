import { redis } from '../../shared/cache';
import { logger } from '../../shared/logging';

/**
 * Operator presence — Lot I.
 *
 * Who is at the desk right now. One Redis sorted set, `support:presence`,
 * member = the operator's user id, score = the instant their presence
 * expires: `PUT /support/presence { online: true }` writes now + 90 s, the
 * desk's heartbeat (`POST /support/presence/heartbeat`, every 30 s) writes
 * it again, `{ online: false }` removes the member. A console that crashes
 * or a laptop that closes stops heartbeating and drops out on its own
 * within ninety seconds — the TTL is the point, not the PUT.
 *
 * A sorted set rather than one key per operator so the read is one
 * ZRANGEBYSCORE and never a SCAN; expired members are pruned on every read.
 * Redis down: nobody is online, which is the honest answer — a start with
 * nobody online becomes a ticket, and nothing is lost.
 */

export const PRESENCE_KEY = 'support:presence';
export const PRESENCE_TTL_MS = 90 * 1000;

export async function setOperatorPresence(userId: string, online: boolean, now: Date = new Date()): Promise<void> {
  if (online) await redis.zadd(PRESENCE_KEY, now.getTime() + PRESENCE_TTL_MS, userId);
  else await redis.zrem(PRESENCE_KEY, userId);
}

/** The heartbeat: the same write as going online, so a missed PUT still counts. */
export async function heartbeatOperator(userId: string, now: Date = new Date()): Promise<void> {
  await redis.zadd(PRESENCE_KEY, now.getTime() + PRESENCE_TTL_MS, userId);
}

/** Every operator whose presence has not expired at `now`, sorted by id. */
export async function onlineOperatorIds(now: Date = new Date()): Promise<string[]> {
  try {
    await redis.zremrangebyscore(PRESENCE_KEY, '-inf', now.getTime() - 1);
    const ids = await redis.zrangebyscore(PRESENCE_KEY, now.getTime(), '+inf');
    return [...new Set(ids)].sort();
  } catch (err) {
    logger.warn('Operator presence unreadable; treating the desk as empty', { reason: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export async function isOperatorOnline(userId: string, now: Date = new Date()): Promise<boolean> {
  return (await onlineOperatorIds(now)).includes(userId);
}
