import { z } from 'zod';

/**
 * A fraction, never a percentage typed as a whole number.
 *
 * `15` instead of `0.15` would hand a publisher fifteen times their earnings, or
 * charge an advertiser fifteen times the platform fee. The column has a CHECK
 * for the same reason; this catches it as a 400 with a sentence rather than a
 * constraint violation the error handler renders as a 500.
 */
const fraction = z
  .string()
  .regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, 'Expected a fraction like "0.15" — 15% is 0.15, not 15');

const moneyString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount like "1200" or "1200.50"');

const listingCategory = z.enum(['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA']);

/* ── Quote ──────────────────────────────────────────────────────────── */

export const quoteSchema = z.object({
  listingId: z.string().min(1),
  days: z.number().int().min(1).max(3650),
  spots: z.number().int().min(1).max(500).optional(),
  /** Reduces taxable value before GST. Not interchangeable with goodwill. */
  rateDiscount: moneyString.optional(),
  /** Applied to the gross after GST, because it is a payment. */
  goodwill: moneyString.optional(),
});

/* ── Commission ─────────────────────────────────────────────────────── */

export const commissionRateSchema = z.object({
  /** Null is the platform default. Exclusive with `mediaTypeId`. */
  category: listingCategory.nullish(),
  /** Lot B (Q10/Q38): the pricing engine's media type. Beats a category row. */
  mediaTypeId: z.string().min(1).max(64).nullish(),
  /**
   * An optional rental band on the per-day media value, `[min, max)`. Either
   * bound may be open. Needs `mediaTypeId`; the service refuses otherwise.
   */
  minMediaValue: moneyString.nullish(),
  maxMediaValue: moneyString.nullish(),
  ratePct: fraction,
  note: z.string().max(500).nullish(),
});

export const subscriptionSchema = z.object({
  publisherId: z.string().min(1),
  tier: z.enum(['STANDARD', 'PLUS', 'PRO']),
  /** Lot J (B1): omitted, both are filled from the tier's plan; explicit values still win. */
  ratePct: fraction.optional(),
  pricePerMonth: moneyString.optional(),
  startsAt: z.string().min(4),
  endsAt: z.string().min(4).nullish(),
});

export const overrideSchema = z.object({
  publisherId: z.string().min(1),
  ratePct: fraction,
  /** Required. ADX giving up its own revenue needs a stated reason. */
  reason: z.string().min(4).max(500),
  startsAt: z.string().min(4),
  endsAt: z.string().min(4).nullish(),
});

/* ── Fees ───────────────────────────────────────────────────────────── */

export const feeSchema = z
  .object({
    kind: z.enum(['PLATFORM', 'INSTALLATION', 'PRINTING', 'DESIGN']),
    name: z.string().min(2).max(120),
    percentPct: fraction.nullish(),
    flatAmount: moneyString.nullish(),
    gstPct: fraction.default('0.18'),
    amountShownInCart: z.boolean().default(false),
    perSpot: z.boolean().default(true),
  })
  .refine((v) => (v.percentPct == null) !== (v.flatAmount == null), {
    message: 'A fee is either a percentage or a flat amount, never both and never neither',
    path: ['percentPct'],
  });

export const updateFeeSchema = z
  .object({
    name: z.string().min(2).max(120),
    percentPct: fraction,
    flatAmount: moneyString,
    gstPct: fraction,
    amountShownInCart: z.boolean(),
    perSpot: z.boolean(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => v.percentPct === undefined || v.flatAmount === undefined, {
    // `kind` is not patchable, so the schema cannot know which shape this fee
    // is. Rejecting both-at-once here keeps the column CHECK from surfacing as
    // a 500; the controller compares against the stored shape.
    message: 'A fee is either a percentage or a flat amount, never both',
    path: ['flatAmount'],
  });

/* ── Tax ────────────────────────────────────────────────────────────── */

export const taxSchema = z.object({ mediaGstPct: fraction });

/* ── Price locks ────────────────────────────────────────────────────── */

export const lockSchema = z.object({
  listingId: z.string().min(1),
  /** How many spots are already in the cart — decides the lock duration. */
  spotsInCart: z.number().int().min(1).max(500).default(1),
});
