import { prisma } from '../../shared/database';
import type { NotificationChannel, NotificationType, Prisma } from '../../shared/database';
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

  countRead(userId: string) {
    return prisma.notification.count({ where: { userId, read: true } });
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
    // E9: the two columns ride the row as sent; a caller that sends neither
    // leaves both null. The payload is the caller's own JSON shape.
    const { payload, ...rest } = data;
    return prisma.notification.create({
      data: { ...rest, ...(payload === undefined ? {} : { payload: payload as Prisma.InputJsonValue }) },
    });
  },

  findPreferences(userId: string) {
    return prisma.notificationPreference.findMany({ where: { userId } });
  },

  upsertPreference(userId: string, type: NotificationType, channel: NotificationChannel, enabled: boolean) {
    return prisma.notificationPreference.upsert({
      where: { userId_type_channel: { userId, type, channel } },
      update: { enabled },
      create: { userId, type, channel, enabled },
    });
  },
};
