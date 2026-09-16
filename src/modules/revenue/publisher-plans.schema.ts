import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';

/** Lot J (B1): the publisher plan catalogue and the self-service orders. */

const fraction = z
  .string()
  .regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, 'Expected a fraction like "0.12" — 12% is 0.12, not 12');

const moneyString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount like "999" or "999.50"');

export const tierSchema = z.enum(['STANDARD', 'PLUS', 'PRO']);
export const cycleSchema = z.enum(['MONTHLY', 'ANNUAL']);

export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    pricePerMonth: moneyString,
    ratePct: fraction,
    description: z.string().trim().max(500).nullable(),
    entitlements: z.record(z.string(), z.unknown()),
    isPopular: z.boolean(),
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(1000),
  })
  .partial()
  .strict();

export const orderQuoteSchema = z.object({
  tier: tierSchema,
  cycle: cycleSchema,
});

export const createOrderSchema = orderQuoteSchema;

export const recordOrderPaymentSchema = z.object({
  reference: z.string().trim().min(2).max(120),
  method: z.string().trim().min(2).max(40),
});

/** Lot J2 (5): a free trial of a tier — the term is the policy's `trialDays`, so nothing else is asked. */
export const trialSchema = z.object({ tier: tierSchema });

/** Lot J2 (6): the subscriber's own switch. */
export const autoRenewSchema = z.strictObject({ autoRenew: z.boolean() });

/** Lot J2 (d): `GET /revenue/subscriptions` on the list contract. */
export const SUBSCRIPTION_STATES = ['RUNNING', 'UPCOMING', 'ENDED'] as const;
export const listSubscriptionsQuerySchema = z.object({
  state: z.enum(SUBSCRIPTION_STATES).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  publisherId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});
export type ListSubscriptionsQuery = z.infer<typeof listSubscriptionsQuerySchema>;

export const ORDER_STATUSES = ['PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED'] as const;

export const listOrdersQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(ORDER_STATUSES)).optional()),
  publisherId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;
