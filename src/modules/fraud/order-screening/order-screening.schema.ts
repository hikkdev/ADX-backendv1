import { z } from 'zod';
import { upperEnum } from '../../../shared/validation';

/** Order fraud screening — the desk's request bodies (2 Oct 2026). */

const reason = z.string().trim().min(3, 'Say why, in a few words').max(1000);
const note = z.string().trim().min(1).max(1000).optional();

/** `POST /orders/:id/hold { reason }` */
export const holdSchema = z.object({ reason });
/** `POST /orders/:id/release { note? }`, `POST /orders/:id/clear { note? }` */
export const noteSchema = z.object({ note });
/** `POST /orders/:id/confirm-fraud { reason }` */
export const confirmFraudSchema = z.object({ reason });

export const BULK_ACTIONS = ['HOLD', 'RELEASE', 'CLEAR', 'CONFIRM_FRAUD'] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];
/** The most orders one bulk call acts on. */
export const BULK_LIMIT = 100;

/**
 * `POST /orders/fraud-review/bulk { action, orderIds[], reason? }` — at most
 * a hundred distinct orders; a hold and a cancel as fraud need the reason,
 * a release and a clear take it as their note.
 */
export const bulkSchema = z
  .object({
    action: upperEnum(BULK_ACTIONS),
    orderIds: z
      .array(z.string().trim().min(1).max(64))
      .min(1)
      .max(BULK_LIMIT, `At most ${BULK_LIMIT} orders at a time`)
      .transform((ids) => [...new Set(ids)]),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((body) => !(body.action === 'HOLD' || body.action === 'CONFIRM_FRAUD') || (body.reason?.length ?? 0) >= 3, {
    message: 'Say why, in a few words',
    path: ['reason'],
  });
export type BulkInput = z.infer<typeof bulkSchema>;
