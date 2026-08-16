import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { upperEnum } from '../lib/zod';
import {
  getNotifications, getNotificationById, markRead, markAllRead,
} from '../services/notification.service';
import { prisma } from '../lib/prisma';
import type { NotificationType } from '../generated/prisma';

export async function getNotificationsHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = z.object({
    limit: z.coerce.number().default(50),
    offset: z.coerce.number().default(0),
    unreadOnly: z.coerce.boolean().default(false),
    type: upperEnum(['BOOKING', 'PAYOUT', 'KYC', 'MESSAGE', 'SYSTEM'] as const).optional(),
  }).safeParse(req.query);

  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const result = await getNotifications(userId, {
    ...parsed.data,
    type: parsed.data.type as NotificationType | undefined,
  });
  res.json({ success: true, data: result });
}

export async function getNotificationHandler(req: Request, res: Response): Promise<void> {
  const notificationId = req.params['notificationId'] as string;
  const userId = req.user!.sub;
  const notification = await getNotificationById(notificationId);
  if (!notification || notification.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Notification not found');
  res.json({ success: true, data: notification });
}

export async function markReadHandler(req: Request, res: Response): Promise<void> {
  const notificationId = req.params['notificationId'] as string;
  const userId = req.user!.sub;
  const notification = await getNotificationById(notificationId);
  if (!notification || notification.userId !== userId) throw new ApiError(404, 'NOT_FOUND', 'Notification not found');
  await markRead(notificationId);
  res.json({ success: true, data: { message: 'Marked as read' } });
}

export async function markAllReadHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  await markAllRead(userId);
  res.json({ success: true, data: { message: 'All marked as read' } });
}

// ─── Notification Preferences ─────────────────────────────────────────────────

const ALL_TYPES: NotificationType[] = ['BOOKING', 'PAYOUT', 'KYC', 'MESSAGE', 'SYSTEM'];

export async function getPreferencesHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const prefs = await prisma.notificationPreference.findMany({ where: { userId } });

  // Return all types, defaulting to enabled if no row exists yet
  const result = ALL_TYPES.map((type) => {
    const pref = prefs.find((p) => p.type === type);
    return { type, enabled: pref ? pref.enabled : true };
  });

  res.json({ success: true, data: result });
}

const savePreferencesSchema = z.array(
  z.object({
    type: upperEnum(['BOOKING', 'PAYOUT', 'KYC', 'MESSAGE', 'SYSTEM'] as const),
    enabled: z.boolean(),
  }),
);

export async function savePreferencesHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const parsed = savePreferencesSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  await Promise.all(
    parsed.data.map((pref) =>
      prisma.notificationPreference.upsert({
        where: { userId_type: { userId, type: pref.type as NotificationType } },
        update: { enabled: pref.enabled },
        create: { userId, type: pref.type as NotificationType, enabled: pref.enabled },
      }),
    ),
  );

  res.json({ success: true, data: { message: 'Preferences saved' } });
}
