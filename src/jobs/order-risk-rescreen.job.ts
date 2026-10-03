import { redis, orSkipWhenRedisDown } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { recordHeartbeat } from '../shared/jobs';
import { runOrderRescreen } from '../modules/fraud';

const TAG = 'orderRiskRescreenJob';
const INTERVAL_MS = 60 * 60 * 1000;
const LOCK_KEY = 'lock:order-risk-rescreen-tick';
const LOCK_TTL_MS = 55 * 60 * 1000;
/** Once a day, Indian time: the day key is what makes it once. */
const DAY_KEY = (day: string) => `lock:order-risk-rescreen:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let orderRiskRescreenInterval: ReturnType<typeof setInterval> | null = null;

export const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The nightly order re-screen — order fraud screening (the owner, 2 Oct 2026).
 *
 * Every open order (not COMPLETED or CANCELLED) is scored again, so a signal
 * that appeared since the order was placed — a shared bank account found on
 * the publisher, a prior case confirmed — reaches it. A cleared order
 * re-flags only on a NEW signal; nothing here goes past a reversible hold,
 * and that only with automatic holds switched on (they ship off). The desk
 * hears of the new flags once, as one batch.
 *
 * Hourly interval under a day lock, like the fraud signal scan, so a process
 * that started at noon still catches the day; Redis away, the tick is
 * skipped rather than run unlocked.
 */
export async function orderRiskRescreenTick(now = new Date()): Promise<void> {
  recordHeartbeat('order-risk-rescreen', now);
  const acquired = await orSkipWhenRedisDown(redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX'), TAG);
  if (!acquired) return;

  try {
    const first = await redis.set(DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (!first) return;
    const report = await runOrderRescreen(now);
    logger.info('Order re-screen done', { tag: TAG, ...report });
  } catch (err) {
    logger.error('orderRiskRescreenJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startOrderRiskRescreenJob(): void {
  orderRiskRescreenInterval = setInterval(() => void orderRiskRescreenTick(), INTERVAL_MS);
}
