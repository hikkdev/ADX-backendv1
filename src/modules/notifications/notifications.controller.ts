import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import type { NotificationChannel, NotificationType } from '../../shared/database';
import { listNotificationsQuerySchema, savePreferencesSchema } from './notifications.schema';
import {
  getNotifications,
  getOwnedNotification,
  getPreferences,
  markAllRead,
  markRead,
  savePreferences,
} from './notifications.service';

export async function getNotificationsHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = listNotificationsQuerySchema.safeParse(req.query);

  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const result = await getNotifications(userId, {
    ...parsed.data,
    type: parsed.data.type as NotificationType | undefined,
  });
  res.json({ success: true, data: result });
}

export async function getNotificationHandler(req: Request, res: Response): Promise<void> {
  const notificationId = req.params['notificationId'] as string;
  const notification = await getOwnedNotification(notificationId, req.user!.sub);
  if (!notification) throw new ApiError(404, 'NOT_FOUND', 'Notification not found');
  res.json({ success: true, data: notification });
}

export async function markReadHandler(req: Request, res: Response): Promise<void> {
  const notificationId = req.params['notificationId'] as string;
  const notification = await getOwnedNotification(notificationId, req.user!.sub);
  if (!notification) throw new ApiError(404, 'NOT_FOUND', 'Notification not found');
  await markRead(notificationId);
  res.json({ success: true, data: { message: 'Marked as read' } });
}

export async function markAllReadHandler(req: Request, res: Response): Promise<void> {
  await markAllRead(req.user!.sub);
  res.json({ success: true, data: { message: 'All marked as read' } });
}

export async function getPreferencesHandler(req: Request, res: Response): Promise<void> {
  const result = await getPreferences(req.user!.sub);
  res.json({ success: true, data: result });
}

export async function savePreferencesHandler(req: Request, res: Response): Promise<void> {
  const parsed = savePreferencesSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  await savePreferences(
    req.user!.sub,
    parsed.data.map((p) => ({
      type: p.type as NotificationType,
      ...(p.channel ? { channel: p.channel as NotificationChannel } : {}),
      enabled: p.enabled,
    })),
  );

  res.json({ success: true, data: { message: 'Preferences saved' } });
}
