import { z } from 'zod';
import { upperEnum } from '../../shared/validation';
import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from './notifications.types';

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
  unreadOnly: z.coerce.boolean().default(false),
  type: upperEnum(NOTIFICATION_TYPES).optional(),
});

export const savePreferencesSchema = z.array(
  z.object({
    type: upperEnum(NOTIFICATION_TYPES),
    /** Absent means IN_APP: a client written before the channel axis still works. */
    channel: upperEnum(NOTIFICATION_CHANNELS).optional(),
    enabled: z.boolean(),
  }),
);
