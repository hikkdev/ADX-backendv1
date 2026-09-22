import type { NotificationChannel, NotificationType } from '../../shared/database';
import { prismaNotificationRepository as repository } from './prisma-notifications.repository';
import { defaultEnabled, isMandatory, NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from './notifications.types';
import type {
  ListNotificationsOptions,
  NewNotification,
  NotificationPreferenceInput,
} from './notifications.types';

export async function getNotifications(userId: string, opts: ListNotificationsOptions = {}) {
  // E10-1: `readCount` beside `unreadCount`, both over the whole feed.
  const [notifications, unreadCount, readCount] = await Promise.all([
    repository.findManyForUser(userId, opts),
    repository.countUnread(userId),
    repository.countRead(userId),
  ]);

  return { notifications, unreadCount, readCount };
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
 * Every kind on every channel, with the default where nothing is saved.
 *
 * The whole matrix rather than the saved rows, because the screen draws the
 * whole matrix and a missing row means "never touched", not "off".
 */
export async function getPreferences(userId: string) {
  const saved = await repository.findPreferences(userId);
  return NOTIFICATION_TYPES.flatMap((type) =>
    NOTIFICATION_CHANNELS.map((channel) => {
      const preference = saved.find((p) => p.type === type && p.channel === channel);
      return {
        type,
        channel,
        enabled: isMandatory(type, channel)
          ? true
          : (preference?.enabled ?? defaultEnabled(type, channel)),
        mandatory: isMandatory(type, channel),
      };
    }),
  );
}

/** A row the person cannot switch off is not saved off, whatever was sent. */
export async function savePreferences(
  userId: string,
  preferences: NotificationPreferenceInput[],
): Promise<void> {
  await Promise.all(
    preferences.map((preference) => {
      const channel = preference.channel ?? 'IN_APP';
      const enabled = isMandatory(preference.type, channel) ? true : preference.enabled;
      return repository.upsertPreference(userId, preference.type, channel, enabled);
    }),
  );
}

/**
 * Whether a notification of this kind may go out on this channel — what a
 * delivery worker asks before it sends. Nothing calls it yet: in-app delivery
 * is a row in the list and asks nobody. It is here so the preference the
 * screen saves has one reader when push lands, rather than a second rule
 * written somewhere else.
 */
export async function mayDeliver(
  userId: string,
  type: NotificationType,
  requested: NotificationChannel,
): Promise<boolean> {
  // LH6: WhatsApp follows the SMS preference — one switch for the two doors to the same number.
  const channel: NotificationChannel = requested === 'WHATSAPP' ? 'SMS' : requested;
  if (isMandatory(type, channel)) return true;
  const saved = await repository.findPreferences(userId);
  const preference = saved.find((p) => p.type === type && p.channel === channel);
  return preference?.enabled ?? defaultEnabled(type, channel);
}
