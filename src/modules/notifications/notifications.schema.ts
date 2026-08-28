import { z } from 'zod';
import { upperEnum } from '../../shared/validation';
import { NOTIFICATION_TYPES } from './notifications.types';

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
  unreadOnly: z.coerce.boolean().default(false),
  type: upperEnum(NOTIFICATION_TYPES).optional(),
});

export const savePreferencesSchema = z.array(
  z.object({
    type: upperEnum(NOTIFICATION_TYPES),
    enabled: z.boolean(),
  }),
);
