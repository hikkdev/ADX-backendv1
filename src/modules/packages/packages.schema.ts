import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE } from '../../shared/pagination';

/**
 * What the four screens are allowed to send.
 *
 * The wizard's first two screens choose from a catalogue rather than typing
 * anything, so the only free values here are the tier, the add-on codes and the
 * cycle — everything downstream is priced from the catalogue rather than from
 * the request, which is why a client cannot name its own price.
 */

const tier = z.enum(['STARTER', 'GROWTH', 'PRO']);
const cycle = z.enum(['MONTHLY', 'ANNUAL']);
const addOnCodes = z.array(z.string().min(2).max(60)).max(10).default([]);

export const quoteSchema = z.object({
  tier,
  addOnCodes,
  cycle: cycle.default('MONTHLY'),
});

export const sellSchema = z.object({
  /** Omitted when an advertiser buys for themselves; required when an agent sells. */
  advertiserId: z.string().min(1).optional(),
  tier,
  addOnCodes,
  cycle: cycle.default('MONTHLY'),
  /** Lot B (Q1): the field visit the sale is being made on — the agent's own, open today. */
  visitId: z.string().min(1).optional(),
});

export const markPaidSchema = z.object({
  method: z.enum(['WALLET', 'OFFLINE']),
  /** The bank reference for an offline payment. Required for one, ignored for the other. */
  reference: z.string().max(120).nullable().optional(),
});

export const cancelSchema = z.object({
  reason: z.string().min(3).max(500),
});

/** Lot J2 (5): a free trial of a tier — the term is the policy's `trialDays`, so nothing else is asked. */
export const trialSchema = z.object({ tier });

/** Lot J2 (6): the advertiser's own auto-renew switch. */
export const autoRenewSchema = z.strictObject({ autoRenew: z.boolean() });

/* ── Lot D (Q94): the catalogue editor ─────────────────────────────── */

const catalogueMoney = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount in rupees');
const addOnCode = z
  .string()
  .trim()
  .min(2)
  .max(60)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'An add-on code is UPPER_SNAKE_CASE');

/**
 * Entitlements are copy (Lot D, Q94): a JSON object the plan card lists and
 * nothing in the platform reads. Bounded so the editor cannot be used as a
 * document store; free-form inside that so a new promise needs no deploy.
 */
const entitlements = z.record(z.string().min(1).max(60), z.union([z.string().max(200), z.number(), z.boolean(), z.null()]));

export const updatePlanSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    pricePerMonth: catalogueMoney,
    description: z.string().trim().max(300).nullable(),
    isPopular: z.boolean(),
    entitlements,
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(100),
  })
  .partial()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'Nothing to change' });

export const createAddOnSchema = z.object({
  code: addOnCode,
  name: z.string().trim().min(1).max(80),
  pricePerMonth: catalogueMoney,
  description: z.string().trim().max(300).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100).optional(),
});

export const updateAddOnSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    pricePerMonth: catalogueMoney,
    description: z.string().trim().max(300).nullable(),
    isActive: z.boolean(),
    sortOrder: z.number().int().min(0).max(100),
  })
  .partial()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), { message: 'Nothing to change' });

export const tierParamSchema = z.enum(['STARTER', 'GROWTH', 'PRO']);

/**
 * How close to its end a plan has to be before the agent should be talking to
 * the advertiser about renewing it. Stated once, here, because it decides both
 * the EXPIRING chip and its count — a threshold buried in a query is one
 * nobody can find when the product changes its mind.
 */
export const EXPIRING_WITHIN_DAYS = 14;

/**
 * DR 06's Package Sales chips (`4420:915`): All / Active / Expiring / Expired.
 *
 * Not `PackageSaleStatus` values. "Expiring" is an ACTIVE plan whose end date
 * is within the window above, and a plan can be past its end date without
 * anything having moved its status yet — so the facet is the shelf the agent
 * sees rather than the column the platform keeps.
 */
export const PACKAGE_SHELVES = ['ACTIVE', 'EXPIRING', 'EXPIRED'] as const;
export type PackageShelf = (typeof PACKAGE_SHELVES)[number];

export const PACKAGE_SALE_STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'ACTIVE',
  'EXPIRED',
  'CANCELLED',
] as const;

export const listSalesQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  /**
   * The shelf and the status are both real and they compose.
   *
   * The chips are the shelf — a derived view the agent's book draws. The
   * status column is still queryable underneath it, because callers ask real
   * lifecycle questions of it: the advertiser app looks for a PENDING_PAYMENT
   * plan to finish paying for, which is not a shelf and never will be.
   */
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(PACKAGE_SALE_STATUSES)).optional()),
  shelf: z.enum(PACKAGE_SHELVES).optional(),
  sort: z.enum(['NEWEST', 'OLDEST', 'RENEWAL', 'VALUE_DESC']).default('NEWEST'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});
export type ListSalesQuery = z.infer<typeof listSalesQuerySchema>;

export const listQuerySchema = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(
      z
        .array(z.enum(['DRAFT', 'PENDING_PAYMENT', 'ACTIVE', 'EXPIRED', 'CANCELLED']))
        .optional()
    ),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
