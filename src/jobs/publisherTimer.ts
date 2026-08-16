import { prisma } from '../lib/prisma';
import { createNotification } from '../services/notification.service';
import { logger } from '../lib/logger';

const TAG = 'publisherTimerJob';
const INTERVAL_MS = 60 * 1000;

export let publisherTimerInterval: ReturnType<typeof setInterval> | null = null;

export function startPublisherTimerJob(): void {
  publisherTimerInterval = setInterval(async () => {
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
