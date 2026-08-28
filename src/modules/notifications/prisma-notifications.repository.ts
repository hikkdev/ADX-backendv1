import { prisma } from '../../shared/database';
import type { NotificationType } from '../../shared/database';
import type { NotificationRepository } from './notifications.repository';
import type { ListNotificationsOptions, NewNotification } from './notifications.types';

export const prismaNotificationRepository: NotificationRepository = {
  findManyForUser(userId: string, opts: ListNotificationsOptions) {
    const { limit = 50, offset = 0, unreadOnly, type } = opts;
    return prisma.notification.findMany({
      where: {
        userId,
        ...(unreadOnly ? { read: false } : {}),
        ...(type ? { type } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  },

  countUnread(userId: string) {
    return prisma.notification.count({ where: { userId, read: false } });
  },

  findById(notificationId: string) {
    return prisma.notification.findUnique({ where: { id: notificationId } });
  },

  markRead(notificationId: string) {
    return prisma.notification.update({ where: { id: notificationId }, data: { read: true } });
  },

  markAllRead(userId: string) {
    return prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
  },

  create(data: NewNotification) {
    return prisma.notification.create({ data });
  },

  findPreferences(userId: string) {
    return prisma.notificationPreference.findMany({ where: { userId } });
  },

  upsertPreference(userId: string, type: NotificationType, enabled: boolean) {
    return prisma.notificationPreference.upsert({
      where: { userId_type: { userId, type } },
      update: { enabled },
      create: { userId, type, enabled },
    });
  },
};
