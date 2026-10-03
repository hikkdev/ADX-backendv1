import { redis, orSkipWhenRedisDown } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runPromotionsLifecycle } from '../modules/promotions';

const TAG = 'promotionsJob';
const INTERVAL_MS = 5 * 60 * 1000;
const LOCK_KEY = 'lock:promotions-tick';
// Shorter than the interval, so an instance that dies mid-tick frees the next one.
const LOCK_TTL_MS = 4 * 60 * 1000;

export let promotionsInterval: ReturnType<typeof setInterval> | null = null;

/**
 * LM-1: paid placements cross their own dates — every five minutes, like the
 * campaign lifecycle. A scheduled ad or sponsored listing goes LIVE on its
 * first day and ENDED after its last; a priced booking left unpaid for an
 * hour is CANCELLED and its days freed; an ad paid for but never reviewed
 * before its last day is CANCELLED and refunded. The buyer hears at each.
 *
 * Every instance runs the interval; the one that wins the lock does the
 * work (each transition is also guarded on the status it leaves). Redis away:
 * the tick is skipped rather than taking the API down.
 */
export async function promotionsTick(now = new Date()): Promise<void> {
  recordHeartbeat('promotions', now);
  const acquired = await orSkipWhenRedisDown(redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX'), TAG);
  if (!acquired) return;
  try {
    const sweep = await runPromotionsLifecycle(now);
    if (Object.values(sweep).some((count) => count > 0)) logger.info('Promotions lifecycle tick', { tag: TAG, ...sweep });
  } catch (err) {
    logger.error('promotionsJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startPromotionsJob(): void {
  promotionsInterval = setInterval(() => void promotionsTick(), INTERVAL_MS);
}
