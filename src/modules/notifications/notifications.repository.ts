import type { NotificationChannel, Notification, NotificationPreference, NotificationType } from '../../shared/database';
import type { ListNotificationsOptions, NewNotification } from './notifications.types';

/**
 * Persistence seam for the notifications module. The service depends on this
 * shape; only prisma-notifications.repository.ts knows about Prisma.
 *
 * The interface speaks in row types rather than a separate domain model: the
 * API already returns these shapes verbatim, and inventing a mapper here would
 * change response bodies, which this refactor must not do.
 */
export interface NotificationRepository {
  findManyForUser(userId: string, opts: ListNotificationsOptions): Promise<Notification[]>;
  countUnread(userId: string): Promise<number>;
  /** E10-1: the other half — how many the user has already read, over the whole feed. */
  countRead(userId: string): Promise<number>;
  findById(notificationId: string): Promise<Notification | null>;
  markRead(notificationId: string): Promise<Notification>;
  markAllRead(userId: string): Promise<{ count: number }>;
  create(data: NewNotification): Promise<Notification>;
  findPreferences(userId: string): Promise<NotificationPreference[]>;
  upsertPreference(
    userId: string,
    type: NotificationType,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<NotificationPreference>;
}
