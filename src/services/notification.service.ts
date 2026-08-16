import { prisma } from '../lib/prisma';
import type { NotificationType } from '../generated/prisma';

export async function getNotifications(
  userId: string,
  opts: { limit?: number; offset?: number; unreadOnly?: boolean; type?: NotificationType } = {},
) {
  const { limit = 50, offset = 0, unreadOnly, type } = opts;

  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: {
        userId,
        ...(unreadOnly ? { read: false } : {}),
        ...(type ? { type } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    prisma.notification.count({ where: { userId, read: false } }),
  ]);

  return { notifications, unreadCount };
}

export async function getNotificationById(notificationId: string) {
  return prisma.notification.findUnique({ where: { id: notificationId } });
}

export async function markRead(notificationId: string) {
  return prisma.notification.update({ where: { id: notificationId }, data: { read: true } });
}

export async function markAllRead(userId: string) {
  return prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
}

export async function createNotification(data: {
  userId: string;
  type: NotificationType;
  title: string;
  subtitle?: string;
  message: string;
  suggestedAction?: string;
  relatedId?: string;
}) {
  return prisma.notification.create({ data });
}
