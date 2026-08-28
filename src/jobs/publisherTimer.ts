import { prisma } from '../shared/database';
import { redis } from '../shared/cache';
import { createNotification } from '../services/notification.service';
import { logger } from '../shared/logging';

const TAG = 'publisherTimerJob';
const INTERVAL_MS = 60 * 1000;
const LOCK_KEY = 'lock:publisher-timer-tick';
// Shorter than INTERVAL_MS: if an instance dies mid-tick, the lock self-clears
// before the next tick is due instead of stalling the job until it expires.
const LOCK_TTL_MS = 45 * 1000;

export let publisherTimerInterval: ReturnType<typeof setInterval> | null = null;

export function startPublisherTimerJob(): void {
  publisherTimerInterval = setInterval(async () => {
    // Every instance runs this interval, but only the one that wins the lock
    // for a given minute actually processes it — otherwise N instances would
    // each notify admins about the same expired order.
    const acquired = await redis.set(LOCK_KEY, '1', 'PX', LOCK_TTL_MS, 'NX');
    if (!acquired) return;

    try {
      const now = new Date();
      // Only match orders whose timer expired within the last tick window so we
      // notify once per order rather than on every tick until the publisher responds.
      const windowStart = new Date(now.getTime() - INTERVAL_MS);
      const expiredOrders = await prisma.order.findMany({
        where: {
          status: 'PENDING_PUBLISHER',
          publisherTimerExpiry: { gte: windowStart, lt: now },
        },
        select: { id: true },
      });

      logger.info('Publisher timer tick', {
        tag: TAG,
        checked: expiredOrders.length,
        triggered: expiredOrders.length,
      });

      if (expiredOrders.length === 0) return;

      const admins = await prisma.userRole.findMany({ where: { role: 'ADMIN' } });

      for (const order of expiredOrders) {
        const shortId = order.id.slice(-6).toUpperCase();

        admins.map((ur) =>
          createNotification({
            userId: ur.userId,
            type: 'ORDER',
            title: 'Publisher no response',
            message: `Order ${shortId} has had no publisher response within 30 minutes. Please follow up.`,
            relatedId: order.id,
          }).catch(() => {}),
        );

        logger.info('Publisher timer expired — notified admins', { tag: TAG, orderId: order.id });
      }
    } catch (err) {
      logger.error('publisherTimerJob tick failed', { tag: TAG, err });
    }
  }, INTERVAL_MS);
}
