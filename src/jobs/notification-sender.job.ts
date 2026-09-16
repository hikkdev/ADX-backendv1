import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { purgeDeliveries, sendQueuedDeliveries } from '../modules/notifications';

const TAG = 'notificationSenderJob';
const INTERVAL_MS = 30 * 1000;
const LOCK_KEY = 'lock:notification-sender-tick';
const LOCK_TTL_MS = 25 * 1000;
const BATCH = 200;
/** Once a day, Indian time: the day key is what makes it once. */
const PURGE_DAY_KEY = (day: string) => `lock:notification-purge:${day}`;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export let notificationSenderInterval: ReturnType<typeof setInterval> | null = null;

const istDay = (now: Date) => new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/**
 * The outbound sender — Lot E (Q87/Q147).
 *
 * Every thirty seconds, under a Redis lock so two instances never send the
 * same row: every QUEUED delivery under the attempt cap, oldest first, through
 * the dispatcher's `attemptDelivery` — email by the primary door, SMS by the
 * template's kind — three attempts and then FAILED. An OTP is attempted in
 * the request that raised it; this tick is its retry, and every other
 * message's first attempt.
 *
 * Once a day the same tick runs the retention rule (Q87): variables nulled
 * at 90 days, at 7 for a sensitive template, the rows gone at 180.
 */
export async function notificationSenderTick(now = new Date()): Promise<void> {
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const tally = await sendQueuedDeliveries(BATCH, now);
    if (tally.picked > 0) logger.info('Notification deliveries sent', { tag: TAG, ...tally });

    const first = await redis.set(PURGE_DAY_KEY(istDay(now)), '1', 'EX', 60 * 60 * 36, 'NX');
    if (first) {
      const purged = await purgeDeliveries(now);
      logger.info('Notification deliveries purged', { tag: TAG, ...purged });
    }
  } catch (err) {
    logger.error('notificationSenderJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  }
}

export function startNotificationSenderJob(): void {
  notificationSenderInterval = setInterval(() => void notificationSenderTick(), INTERVAL_MS);
}
