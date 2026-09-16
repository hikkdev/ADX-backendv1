import { z } from 'zod';
import { SAFETY_KINDS, SAFETY_STATUSES } from './safety.types';

export const raiseAlertSchema = z.object({
  kind: z.enum(SAFETY_KINDS),
  orderId: z.string().min(1).optional(),
  milestoneId: z.string().min(1).optional(),
  note: z.string().trim().max(2000).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const updateAlertSchema = z
  .object({
    status: z.enum(SAFETY_STATUSES).optional(),
    opsNote: z.string().trim().max(2000).optional(),
  })
  .refine((patch) => patch.status !== undefined || patch.opsNote !== undefined, { message: 'Nothing to change' });

export const queueQuerySchema = z.object({
  status: z.enum(SAFETY_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
