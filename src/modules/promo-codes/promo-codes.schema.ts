import { z } from 'zod';

const moneyString = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'A rupee amount with up to two decimal places');
const isoDate = z.string().datetime({ offset: true });

export const PROMO_DISCOUNT_KINDS = ['PERCENT', 'FLAT'] as const;

/** POST /promo-codes — ops make a code. */
export const createPromoCodeSchema = z.object({
  code: z.string().trim().min(2).max(32).regex(/^[A-Za-z0-9 _-]+$/, 'Letters, digits, dashes and underscores'),
  description: z.string().trim().max(200).nullable().optional(),
  kind: z.enum(PROMO_DISCOUNT_KINDS),
  /** Percent (0–100) for PERCENT, rupees for FLAT. */
  value: moneyString,
  maxDiscount: moneyString.nullable().optional(),
  minSpend: moneyString.nullable().optional(),
  startsAt: isoDate.nullable().optional(),
  endsAt: isoDate.nullable().optional(),
  usageLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  perAdvertiserLimit: z.number().int().min(1).max(1_000).nullable().optional(),
  isActive: z.boolean().optional(),
});
export type CreatePromoCodeInput = z.infer<typeof createPromoCodeSchema>;

/** PATCH /promo-codes/:id — any of the fields; the rules re-run on the merged row. */
export const updatePromoCodeSchema = createPromoCodeSchema.partial();
export type UpdatePromoCodeInput = z.infer<typeof updatePromoCodeSchema>;

/** POST /campaigns/:id/promo — the advertiser types a code. */
export const applyPromoCodeSchema = z.object({ code: z.string().trim().min(2).max(40) });
