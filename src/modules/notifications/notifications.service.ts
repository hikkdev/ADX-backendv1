import { prismaNotificationRepository as repository } from './prisma-notifications.repository';
import { NOTIFICATION_TYPES } from './notifications.types';
import type {
  ListNotificationsOptions,
  NewNotification,
  NotificationPreferenceInput,
} from './notifications.types';

export async function getNotifications(userId: string, opts: ListNotificationsOptions = {}) {
  const [notifications, unreadCount] = await Promise.all([
    repository.findManyForUser(userId, opts),
    repository.countUnread(userId),
  ]);

  return { notifications, unreadCount };
}

export async function getNotificationById(notificationId: string) {
  return repository.findById(notificationId);
}

/**
 * A notification is only visible to its owner. Returns null rather than
 * throwing so the caller decides between 404 and a silent skip.
 */
export async function getOwnedNotification(notificationId: string, userId: string) {
  const notification = await repository.findById(notificationId);
  return notification && notification.userId === userId ? notification : null;
}

export async function markRead(notificationId: string) {
  return repository.markRead(notificationId);
}

export async function markAllRead(userId: string) {
  return repository.markAllRead(userId);
}

export async function createNotification(data: NewNotification) {
  return repository.create(data);
}

/**
 * Every notification type is reported, defaulting to enabled when the user has
 * never saved a preference for it.
 */
export async function getPreferences(userId: string) {
  const saved = await repository.findPreferences(userId);
  return NOTIFICATION_TYPES.map((type) => {
    const preference = saved.find((p) => p.type === type);
    return { type, enabled: preference ? preference.enabled : true };
  });
}

export async function savePreferences(
  userId: string,
  preferences: NotificationPreferenceInput[],
): Promise<void> {
  await Promise.all(
    preferences.map((preference) =>
      repository.upsertPreference(userId, preference.type, preference.enabled),
    ),
  );
}
