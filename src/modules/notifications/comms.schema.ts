import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { SMS_KINDS } from '../../shared/sms';
import { DELIVERY_SORTS, DELIVERY_STATUSES, TEMPLATE_SORTS, TEMPLATE_STATUSES } from './comms.repository';
import { NOTIFICATION_CHANNELS, TEMPLATE_CHANNELS } from './notifications.types';

const key = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lower-case letters, digits and dashes');
const event = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE');
const text = (max: number) => z.string().trim().max(max);
const instant = z.coerce.date();

export const listTemplatesQuerySchema = listQuerySchema(TEMPLATE_STATUSES, TEMPLATE_SORTS).extend({
  event: event.optional(),
});

export const createTemplateSchema = z.object({
  key,
  event,
  channels: z.array(z.enum(TEMPLATE_CHANNELS)).min(1),
  subject: text(200).nullable().optional(),
  emailBody: text(20_000).nullable().optional(),
  smsKind: z.enum(SMS_KINDS).nullable().optional(),
  smsBody: text(1_000).nullable().optional(),
  isSensitive: z.boolean().optional(),
  /** Lot G (Q117): false puts the copy under the quiet hours and the weekly cap. Defaults to true. */
  transactional: z.boolean().optional(),
  /** G10 (Q103): push copy of its own; null or absent falls back to subject / smsBody. */
  pushTitle: text(200).nullable().optional(),
  pushBody: text(1_000).nullable().optional(),
  status: z.enum(TEMPLATE_STATUSES).optional(),
});

/**
 * Lot G (Q117): the test send names at most which of the template's channels
 * to try. It never names an address — the operator's own is the only
 * destination — and an unknown key is refused, so a body carrying `to` or
 * `email` is a 400, not a message to a stranger.
 */
export const sendTestSchema = z.strictObject({
  channels: z.array(z.enum(['EMAIL', 'SMS'])).min(1).max(2).optional(),
});

/** Everything but the key: a template's key is its identity and its callers' handle. */
export const updateTemplateSchema = createTemplateSchema.omit({ key: true }).partial().refine((patch) => Object.keys(patch).length > 0, {
  message: 'Nothing to change',
});

const deliveryFilterFields = {
  channel: z.enum(TEMPLATE_CHANNELS).optional(),
  templateKey: key.optional(),
  userId: z.string().trim().min(1).max(64).optional(),
  from: instant.optional(),
  to: instant.optional(),
};
const fromBeforeTo = { message: 'from must not be after to', path: ['from'] };
const orderedWindow = (f: { from?: Date | undefined; to?: Date | undefined }) => !f.from || !f.to || f.from <= f.to;

export const listDeliveriesQuerySchema = listQuerySchema(DELIVERY_STATUSES, DELIVERY_SORTS).extend(deliveryFilterFields).refine(orderedWindow, fromBeforeTo);

/** E10-2: the export takes the log's filters and its sort, never a page — it walks the whole result under the cap. */
export const exportDeliveriesQuerySchema = listQuerySchema(DELIVERY_STATUSES, DELIVERY_SORTS)
  .omit({ page: true, pageSize: true })
  .extend(deliveryFilterFields)
  .refine(orderedWindow, fromBeforeTo);

export const templateKeyParamSchema = z.object({ key });
export const deliveryIdParamSchema = z.object({ id: z.string().trim().min(1).max(64) });
export const unsubscribeParamSchema = z.object({ token: z.string().trim().min(8).max(512) });
