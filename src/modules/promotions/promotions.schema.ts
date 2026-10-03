import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';
import { MEDIA_SPEC_KEYS } from '../media';

/** LM-1: the request shapes of `promotions` — every body and query parsed here, never cast. */

export const PROMOTION_STATUSES = ['DRAFT', 'PENDING_PAYMENT', 'PENDING_REVIEW', 'SCHEDULED', 'LIVE', 'ENDED', 'REJECTED', 'CANCELLED'] as const;
export const BOOST_PLACEMENTS = ['SEARCH_TOP', 'SIMILAR_TOP'] as const;
export const LAYOUT_SURFACES = ['WEB_HOME', 'WEB_EXPLORE', 'WEB_FORMATS', 'WEB_LISTING', 'APP_ADVERTISER_HOME', 'APP_PUBLISHER_HOME', 'APP_PARTNER_HOME', 'AGENT_HOME'] as const;

const day = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date like 2026-10-12');
const moneyString = z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'A rupee amount with up to two decimal places');
const id = z.string().trim().min(1).max(64);
/** A link an ad opens: http(s) only — never `javascript:` or a data URL. */
const targetUrl = z
  .string()
  .trim()
  .max(500)
  .url('A full web address, starting https://')
  .refine((value) => /^https?:\/\//i.test(value), 'A web address starting http:// or https://');

/** `?placements=SEARCH_TOP,SIMILAR_TOP` or a JSON array body. */
const placementList = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => (Array.isArray(value) ? value : value.split(',')).map((entry) => entry.trim()).filter(Boolean))
  .pipe(z.array(z.enum(BOOST_PLACEMENTS)).min(1, 'Choose at least one placement').max(2))
  .transform((list) => [...new Set(list)]);

export const windowQuerySchema = z.object({ from: day, to: day });

export const createAdSchema = z.object({
  slotKey: z.string().trim().min(1).max(64),
  /** An agent or ADX acting for an advertiser names them; the owner leaves it out. */
  advertiserId: id.optional(),
  title: z.string().trim().min(2).max(120),
  headline: z.string().trim().max(90).nullable().optional(),
  ctaLabel: z.string().trim().max(24).nullable().optional(),
  targetUrl,
  /** Catalogue cities — each a City id or its slug (what `/app/geo/cities` answers); stored as ids. Empty or absent = everywhere. */
  cityIds: z.array(id).max(50).optional(),
  startDate: day,
  endDate: day,
});
export type CreateAdInput = z.infer<typeof createAdSchema>;

/** Any field; `slotKey` only while the booking is a DRAFT (it re-prices). */
export const updateAdSchema = createAdSchema.omit({ advertiserId: true }).partial();
export type UpdateAdInput = z.infer<typeof updateAdSchema>;

export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
export const optionalReasonSchema = z.object({ reason: z.string().trim().max(500).optional() });

export const mineQuerySchema = z.object({
  advertiserId: id.optional(),
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(z.enum(PROMOTION_STATUSES)).optional()),
});

export const boostQuoteQuerySchema = z.object({ listingId: id, placements: placementList, startDate: day, endDate: day });
export const boostAvailabilityQuerySchema = z.object({ listingId: id, placements: placementList.optional(), from: day, to: day });
export const createBoostSchema = z.object({ listingId: id, placements: placementList, startDate: day, endDate: day });
export type CreateBoostInput = z.infer<typeof createBoostSchema>;

export const artworkBodySchema = z.object({ altText: z.string().trim().max(250).optional() });

/* ── The desk ─────────────────────────────────────────────────────── */

export const createSlotSchema = z.object({
  key: z.string().trim().min(3).max(64).regex(/^[A-Z][A-Z0-9_]+$/, 'Upper-case letters, digits and underscores — WEB_LISTING_SIDEBAR'),
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).nullable().optional(),
  surfaces: z.array(z.enum(LAYOUT_SURFACES)).min(1).max(8),
  spec: z.enum(MEDIA_SPEC_KEYS),
  maxConcurrent: z.number().int().min(1).max(20),
  ratePerDay: moneyString,
  minDays: z.number().int().min(1).max(90).optional(),
  isActive: z.boolean().optional(),
});
export type CreateSlotInput = z.infer<typeof createSlotSchema>;
export const updateSlotSchema = createSlotSchema.omit({ key: true }).partial();
export type UpdateSlotInput = z.infer<typeof updateSlotSchema>;

export const updatePlacementSchema = z
  .object({
    label: z.string().trim().min(2).max(80),
    ratePerDay: moneyString,
    maxConcurrent: z.number().int().min(1).max(20),
    minDays: z.number().int().min(1).max(90),
    isActive: z.boolean(),
  })
  .partial();
export type UpdatePlacementInput = z.infer<typeof updatePlacementSchema>;

export const adminAdsQuerySchema = listQuerySchema(PROMOTION_STATUSES, ['NEWEST', 'START']).extend({ slotKey: z.string().trim().max(64).optional() });
export type AdminAdsQuery = z.infer<typeof adminAdsQuerySchema>;
export const adminBoostsQuerySchema = listQuerySchema(PROMOTION_STATUSES, ['NEWEST', 'START']).extend({ placement: z.enum(BOOST_PLACEMENTS).optional() });
export type AdminBoostsQuery = z.infer<typeof adminBoostsQuerySchema>;

export const approveSchema = z.object({ note: z.string().trim().max(500).optional() });
export const adminCancelBoostSchema = z.object({ reason: z.string().trim().min(3).max(500), refund: z.boolean() });

export const statsQuerySchema = z.object({ from: day.optional(), to: day.optional() });

/* ── Events ───────────────────────────────────────────────────────── */

export const eventsSchema = z.object({
  events: z
    .array(
      z
        .object({
          kind: z.enum(['IMPRESSION', 'CLICK']),
          adBookingId: id.optional(),
          boostId: id.optional(),
          surface: z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_:\-./]+$/),
        })
        .refine((event) => Boolean(event.adBookingId) !== Boolean(event.boostId), 'Each event names exactly one of adBookingId or boostId'),
    )
    .min(1)
    .max(50),
});
export type PromotionEventInput = z.infer<typeof eventsSchema>['events'][number];
