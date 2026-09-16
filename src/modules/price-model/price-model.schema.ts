import { z } from 'zod';

const multiplier = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Expected a multiplier like "1.15"')
  .refine((value) => Number(value) > 0, 'A multiplier must be greater than zero');

const area = z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, 'Expected an area in square feet');

const slug = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Expected a lowercase slug');

/* ── Dimensions ──────────────────────────────────────────────────────── */

export const createDimensionSchema = z.object({
  name: z.string().min(2).max(80),
  slug,
  description: z.string().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

export const updateDimensionSchema = createDimensionSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const dimensionValuesSchema = z.object({
  values: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        multiplier,
        // Both null on everything but a size band.
        minAreaSqFt: area.nullable().optional(),
        maxAreaSqFt: area.nullable().optional(),
        isActive: z.boolean().optional(),
      })
    )
    .max(100),
});

/* ── Category rules ──────────────────────────────────────────────────── */

const effect = z.enum(['MULTIPLIER', 'BLOCKED', 'LEGAL_APPROVAL']);

export const createCategoryRuleSchema = z.object({
  sector: z.string().min(2).max(80),
  mediaTypeId: z.string().min(1).nullable().optional(),
  effect,
  multiplier: multiplier.nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const updateCategoryRuleSchema = createCategoryRuleSchema.partial().extend({
  isActive: z.boolean().optional(),
});

/* ── Rules ───────────────────────────────────────────────────────────── */

export const createRuleSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  matchAny: z.boolean().optional(),
  adjustment: z.enum(['MULTIPLIER', 'BASE_ADJUST', 'OVERRIDE']),
  // Signed, because a rupee adjustment downwards is an ordinary thing to write.
  value: z.string().regex(/^-?\d{1,12}(\.\d{1,4})?$/, 'Expected a number'),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});

export const updateRuleSchema = createRuleSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const conditionsSchema = z.object({
  conditions: z
    .array(
      z.object({
        field: z.string().min(1).max(60),
        operator: z.enum(['eq', 'ne', 'in', 'gt', 'gte', 'lt', 'lte']),
        value: z.string().min(1).max(200),
      })
    )
    .max(20),
});

/* ── Quotes ──────────────────────────────────────────────────────────── */

const quoteLine = z.object({
  mediaTypeId: z.string().min(1),
  grade: z.enum(['PREMIUM', 'A', 'B', 'C']),
  cityId: z.string().min(1).nullable().optional(),
  listingId: z.string().min(1).nullable().optional(),
  label: z.string().max(160).nullable().optional(),
  quantity: z.number().int().min(1).max(999).optional(),
  days: z.number().int().min(1).max(3650).optional(),
  dimensionValueIds: z.array(z.string().min(1)).max(20).optional(),
  areaSqFt: area.nullable().optional(),
});

export const quoteSchema = z.object({
  advertiserId: z.string().min(1).nullable().optional(),
  sector: z.string().max(80).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** A percentage, so "10" is ten per cent. */
  discountPct: z
    .string()
    .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Expected a percentage between 0 and 99')
    .nullable()
    .optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  lines: z.array(quoteLine).min(1).max(200),
});

export const quoteListQuerySchema = z.object({
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'EXPIRED', 'WITHDRAWN']).optional(),
});

export const quoteStatusSchema = z.object({
  status: z.enum(['SENT', 'ACCEPTED', 'EXPIRED', 'WITHDRAWN']),
});

/* ── Settings ────────────────────────────────────────────────────────── */

const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Expected a percentage');

export const settingsPatchSchema = z.object({
  roundingRupees: z.number().int().min(0).max(100000).optional(),
  minimumRatePerDay: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).optional(),
  minimumBookingDays: z.number().int().min(1).max(3650).optional(),
  floorProtection: z.boolean().optional(),
  durationDiscounts: z
    .array(z.object({ minDays: z.number().int().min(1).max(3650), pct: z.number().min(0).max(99) }))
    .max(12)
    .optional(),
  approvalThresholdPct: pct.optional(),
  discountCeilingPct: pct.optional(),
  maxStackedUplift: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/).optional(),
  blockBelowFloor: z.boolean().optional(),
});

/* ── Simulator ───────────────────────────────────────────────────────── */

export const simulateSchema = z.object({
  listingId: z.string().min(1),
  days: z.number().int().min(1).max(3650),
  spots: z.number().int().min(1).max(999).optional(),
  sector: z.string().max(80).nullable().optional(),
  grade: z.enum(['PREMIUM', 'A', 'B', 'C']).nullable().optional(),
  dimensionValueIds: z.array(z.string().min(1)).max(20).optional(),
  discountPct: pct.nullable().optional(),
  previewRule: z
    .object({
      name: z.string().min(1).max(120),
      matchAny: z.boolean(),
      adjustment: z.enum(['MULTIPLIER', 'BASE_ADJUST', 'OVERRIDE']),
      value: z.string().regex(/^-?\d{1,12}(\.\d{1,4})?$/),
      conditions: z
        .array(z.object({ field: z.string().min(1), operator: z.string().min(1), value: z.string() }))
        .max(20),
    })
    .nullable()
    .optional(),
});
