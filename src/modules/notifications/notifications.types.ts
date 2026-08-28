import type { NotificationType } from '../../shared/database';

export const NOTIFICATION_TYPES = ['BOOKING', 'PAYOUT', 'KYC', 'MESSAGE', 'SYSTEM'] as const;

export type ListNotificationsOptions = {
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
  type?: NotificationType;
};

export type NewNotification = {
  userId: string;
  type: NotificationType;
  title: string;
  subtitle?: string;
  message: string;
  suggestedAction?: string;
  relatedId?: string;
};

export type NotificationPreferenceInput = {
  type: NotificationType;
  enabled: boolean;
};
