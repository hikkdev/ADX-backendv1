import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runPublisherSubscriptionSweep } from '../modules/revenue';

const TAG = 'publisherSubscriptionJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:publisher-subscription-tick';
const LOCK_TTL_MS = 50 * 60 * 1000;
/** Once a day, Indian time: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:publisher-subscription:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let publisherSubscriptionInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The daily publisher-subscription sweep — Lot J (B1).
 *
 * Three duties, all in `revenue.runPublisherSubscriptionSweep`: the
 * expiring notice seven days before a term ends (once per subscription),
 * the ended notice on the day it lapses, and the expiry of every order
 * left unpaid for seven days. Hourly interval, daily lock, the same shape
 * as the print-quote expiry: a process that starts at noon still catches
 * the day, and the day key is what makes it once.
 *
 * Lot K (B2): the day key is written **after** the sweep returns, not
 * before it runs — a sweep that throws leaves no key, so the next hourly
 * tick the same day tries again rather than waiting for tomorrow. The
 * tick lock is what keeps two ticks off the same sweep meanwhile.
 */
export async function publisherSubscriptionTick(now = new Date()): Promise<void> {
  recordHeartbeat('publisher-subscription', now);
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const dayKey = DAY_KEY(istDay(now));
    if (await redis.get(dayKey)) return;
    const summary = await runPublisherSubscriptionSweep(now);
    await redis.set(dayKey, '1', 'EX', 60 * 60 * 36);
    logger.info('Publisher subscriptions swept', { tag: TAG, ...summary });
  } catch (err) {
    logger.error('publisherSubscriptionJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startPublisherSubscriptionJob(): void {
  publisherSubscriptionInterval = setInterval(() => void publisherSubscriptionTick(), INTERVAL_MS);
}
