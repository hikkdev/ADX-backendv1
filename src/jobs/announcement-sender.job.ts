import { redis } from '../shared/cache';
import { logger } from '../shared/logging';
import { reportError } from '../shared/errors';
import { sendDueAnnouncements } from '../modules/announcements';

const TAG = 'announcementSenderJob';
const INTERVAL_MS = 30 * 1000;
const LOCK_KEY = 'lock:announcement-sender-tick';
/** A big audience takes a while; the lock outlives the interval so a second instance never joins in. */
const LOCK_TTL_MS = 10 * 60 * 1000;

export let announcementSenderInterval: ReturnType<typeof setInterval> | null = null;

/**
 * The announcement fan-out — Lot E (Q64/Q130).
 *
 * Every thirty seconds under a Redis lock: SCHEDULED announcements whose time
 * has come become SENDING, and every SENDING announcement is walked in
 * batches of 500 through the dispatcher — an in-app ANNOUNCEMENT row for
 * everyone, email to those with an address who have not unsubscribed, SMS
 * only when CRITICAL. Each (person, channel) is marked once, so a tick that
 * dies mid-way resumes on the next without a second message to anyone.
 */
export async function announcementSenderTick(now = new Date()): Promise<void> {
  const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
  if (!acquired) return;

  try {
    const { promoted, ran } = await sendDueAnnouncements(now);
    if (promoted > 0 || ran > 0) logger.info('Announcements processed', { tag: TAG, promoted, ran });
  } catch (err) {
    logger.error('announcementSenderJob tick failed', { tag: TAG, err });
    void reportError(err, { tag: TAG });
  } finally {
    await redis.del(LOCK_KEY).catch(() => undefined);
  }
}

export function startAnnouncementSenderJob(): void {
  announcementSenderInterval = setInterval(() => void announcementSenderTick(), INTERVAL_MS);
}
