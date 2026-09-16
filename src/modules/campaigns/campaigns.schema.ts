import { z } from 'zod';
import { listQuerySchema } from '../../shared/pagination';

/**
 * What the seventeen screens are allowed to send.
 *
 * Every field is optional on the patch, because the wizard saves one screen at a
 * time and a half-answered brief is the normal state of a draft. Completeness is
 * checked once, at review, where it can name everything that is missing instead
 * of refusing a screen at a time.
 *
 * The three config blobs — triggers, creative, tracking — are the one place JSON
 * reaches the database, and each is parsed by a discriminated union first, so
 * what lands in the column is a shape this module wrote rather than whatever the
 * client felt like sending.
 */

const moneyString = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount in rupees');
const isoDate = z.string().datetime({ offset: true }).or(z.string().date());

/* ── Step 8: external triggers ─────────────────────────────────────── */

const weatherConfig = z.object({
  conditions: z.array(z.enum(['RAIN_OR_DRIZZLE', 'COLD_BELOW_15', 'HEAT_ABOVE_35', 'CLEAR'])).min(1),
  /** What the campaign does when the condition holds. */
  response: z.enum(['ACTIVATE', 'PAUSE', 'BOOST']).default('ACTIVATE'),
});

const timeOfDayConfig = z.object({
  slots: z.array(z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT'])).min(1),
  /** MON..SUN. Empty means every day. */
  days: z.array(z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])).default([]),
});

const eventConfig = z.object({
  eventName: z.string().min(2).max(120),
  startsAt: isoDate,
  endsAt: isoDate,
  eventType: z.enum(['SPORTS', 'FESTIVAL', 'HOLIDAY', 'CONCERT', 'OTHER']).default('OTHER'),
});

export const triggerSchema = z.discriminatedUnion('triggerType', [
  z.object({ triggerType: z.literal('NONE') }),
  z.object({ triggerType: z.literal('WEATHER'), triggerConfig: weatherConfig }),
  z.object({ triggerType: z.literal('TIME_OF_DAY'), triggerConfig: timeOfDayConfig }),
  z.object({ triggerType: z.literal('EVENT'), triggerConfig: eventConfig }),
]);

/* ── Step 12: creative path ────────────────────────────────────────── */

const html5Config = z.object({
  endpointUrl: z.string().url(),
  refreshSeconds: z.number().int().min(5).max(3600).default(60),
});

const briefConfig = z.object({
  objective: z.string().min(2).max(200),
  keyMessage: z.string().min(2).max(500),
  style: z.enum(['BOLD_AND_ENERGETIC', 'CLEAN_AND_MINIMAL', 'WARM_AND_FRIENDLY']),
});

/*
 * The config is optional on a draft and required to launch.
 *
 * The wizard asks the question in two moves — choose a path on step 12, then
 * fill its detail on the branch screen — and a schema that demanded the detail
 * with the choice made the branch screen unreachable: the save that was meant
 * to advance to it was rejected for not already containing what that screen
 * exists to collect. `missingAnswers` is where completeness belongs, because a
 * draft is allowed to be half-answered and a launch is not.
 */
export const creativeSchema = z.discriminatedUnion('creativePath', [
  z.object({ creativePath: z.literal('STATIC_IMAGES') }),
  z.object({ creativePath: z.literal('VIDEO_OR_MOTION') }),
  z.object({ creativePath: z.literal('DYNAMIC_HTML5'), creativeConfig: html5Config.optional() }),
  z.object({ creativePath: z.literal('ADX_DESIGN_AGENCY'), creativeConfig: briefConfig.optional() }),
]);

/* ── Step 13: measurement ──────────────────────────────────────────── */

/**
 * Lot D (Q139): the destination is optional. A code with none resolves to
 * the plain "Thanks for scanning" page until Lot E's page builder gives the
 * campaign a landing page of its own; the scan is still counted.
 */
const qrConfig = z.object({
  destinationUrl: z.string().url().optional(),
  utmCampaign: z.string().max(120).optional(),
});

const vanityConfig = z.object({
  vanityUrl: z.string().url().optional(),
  promoCode: z.string().max(40).optional(),
  redemptionWindow: z.enum(['SEVEN_DAYS', 'THIRTY_DAYS', 'CAMPAIGN_DURATION']).default('CAMPAIGN_DURATION'),
});

const locationLiftConfig = z.object({
  businessAddress: z.string().min(2).max(300),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  measurementWindowDays: z.union([z.literal(7), z.literal(14), z.literal(30)]).default(14),
  baselinePeriod: z.enum(['PRIOR_MONTH', 'SAME_MONTH_LAST_YEAR', 'NONE']).default('PRIOR_MONTH'),
});

/** Optional on a draft, required to launch — same reason as the creative path. */
export const trackingSchema = z.discriminatedUnion('trackingMethod', [
  z.object({ trackingMethod: z.literal('NONE') }),
  z.object({ trackingMethod: z.literal('QR_OR_DEEPLINK'), trackingConfig: qrConfig.optional() }),
  z.object({ trackingMethod: z.literal('VANITY_OR_PROMO'), trackingConfig: vanityConfig.optional() }),
  z.object({ trackingMethod: z.literal('LOCATION_LIFT'), trackingConfig: locationLiftConfig.optional() }),
]);

/* ── The wizard ────────────────────────────────────────────────────── */

export const createCampaignSchema = z.object({
  /** Omitted when an advertiser books for themselves; required when an agent does. */
  advertiserId: z.string().min(1).optional(),
  brandId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).max(160).optional(),
  /** Lot B (Q1): the field visit this campaign is being made on — the agent's own, open today. */
  visitId: z.string().min(1).optional(),
});

export const patchCampaignSchema = z
  .object({
    name: z.string().min(1).max(160),
    step: z.number().int().min(1).max(17),

    brandId: z.string().min(1).nullable(),
    brandName: z.string().min(1).max(160).nullable(),
    productName: z.string().max(160).nullable(),
    industry: z.string().max(120).nullable(),
    subCategory: z.string().max(120).nullable(),

    goal: z.enum(['BRAND_AWARENESS', 'DIGITAL_LIFT', 'LOCAL_FOOTFALL']).nullable(),
    awareness: z.enum(['BRAND_NEW', 'ALREADY_ESTABLISHED']).nullable(),

    targetingMethod: z.enum(['RADIUS', 'MARKET_OR_DMA', 'POI_VENUE']).nullable(),
    targetLocation: z.string().max(200).nullable(),
    targetLatitude: z.number().min(-90).max(90).nullable(),
    targetLongitude: z.number().min(-180).max(180).nullable(),
    targetRadiusKm: z.number().int().min(1).max(50).nullable(),
    targetMarket: z.string().max(120).nullable(),
    /**
     * Lot D (Q8/Q107): every market the campaign targets. The cap is the
     * platform setting `marketplace.maxMarketsPerCampaign`, enforced in the
     * service where the setting can be read; the schema only bounds the wire.
     * `targetMarket` stays the first entry for every reader that predates it.
     */
    targetMarkets: z.array(z.string().trim().min(1).max(120)).max(50),
    pois: z
      .array(
        z.object({
          label: z.string().min(1).max(160),
          address: z.string().max(300).nullable().optional(),
          latitude: z.number().min(-90).max(90).nullable().optional(),
          longitude: z.number().min(-180).max(180).nullable().optional(),
        })
      )
      .max(25),

    strategy: z.enum(['DEFENSIVE', 'GENERAL', 'ATTACK']).nullable(),
    persona: z
      .enum([
        'B2B_DECISION_MAKERS',
        'STUDENTS_OR_GEN_Z',
        'HIGH_INCOME_CONSUMERS',
        'FAMILIES_OR_SUBURBAN',
      ])
      .nullable(),

    budget: moneyString.nullable(),
    startDate: isoDate.nullable(),
    endDate: isoDate.nullable(),

    fulfilment: z.enum(['ADX_PRINTS', 'ADVERTISER_SHIPS']).nullable(),

    /** Admin- or agent-applied, and only ever downward. */
    discount: moneyString.nullable(),

    /** Lot B (Q1): the field visit this draft was made on; null clears it. */
    visitId: z.string().min(1).nullable(),

    /**
     * Lot D (Q138): what the creative advertises, from the seeded
     * ContentCategory list (`listings.listContentCategories`). The venue-stance
     * check runs against every booked spot's rules when it is set; unset, the
     * desk sees a CONTENT_CATEGORY_MISSING flag instead.
     */
    contentCategoryId: z.string().min(1).nullable(),
  })
  .partial()
  // The three branch blocks are merged in whole so their unions stay intact —
  // a triggerConfig without its triggerType would be unvalidatable.
  .and(z.object({ trigger: triggerSchema.optional() }))
  .and(z.object({ creative: creativeSchema.optional() }))
  .and(z.object({ tracking: trackingSchema.optional() }));

/* ── Steps 10 and 11: inventory and the cart ───────────────────────── */

export const inventoryQuerySchema = z.object({
  sort: z.enum(['BEST_MATCH', 'LOWEST_RATE', 'MOST_REACH']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const cartSchema = z.object({
  items: z
    .array(
      z.object({
        listingId: z.string().min(1),
        quantity: z.number().int().min(1).max(20).optional(),
        matchScore: z.number().int().min(0).max(100).nullable().optional(),
      })
    )
    .max(50),
});

/* ── Creatives ─────────────────────────────────────────────────────── */

export const uploadCreativeSchema = z.object({
  /** Null for a campaign-level creative — a brief, or a feed. */
  spotId: z.string().min(1).nullable().optional(),
  fileUrl: z.string().url(),
  fileName: z.string().max(200).optional(),
  fileSize: z.number().int().positive().max(200 * 1024 * 1024).optional(),
  mimeType: z.string().max(120).optional(),
  widthPx: z.number().int().positive().max(20000).optional(),
  heightPx: z.number().int().positive().max(20000).optional(),
  durationMs: z.number().int().positive().max(600_000).optional(),
  /** Lot D (Q7): the tracking code this artwork embeds, so the desk can check it. */
  trackingCodeId: z.string().min(1).nullable().optional(),
  /**
   * Lot D (Q120): ADX designed it. Only an ADMIN may say so; the artwork
   * lands AWAITING_ADVERTISER and the advertiser tap-accepts before ops review.
   */
  designedByAdx: z.boolean().optional(),
});

/* ── Lot D (Q44/Q120): moderation ──────────────────────────────────── */

export const CREATIVE_STATUSES = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'IN_REVIEW',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'AWAITING_ADVERTISER',
] as const;

export const CREATIVE_DECISIONS = ['APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] as const;

/** The computed checks the desk sees, and may confirm or override. */
export const CREATIVE_CHECK_CODES = ['DIMENSIONS_MATCH', 'VENUE_STANCE', 'QR_PRESENT', 'TEXT_LEGIBLE', 'BRAND_SAFE'] as const;
export const CREATIVE_CHECK_RESULTS = ['PASS', 'FAIL', 'UNKNOWN'] as const;

const creativeCheck = z.object({
  code: z.enum(CREATIVE_CHECK_CODES),
  result: z.enum(CREATIVE_CHECK_RESULTS),
  note: z.string().trim().max(300).optional(),
});

/** A refusal or a change request has to say why; an approval need not. */
export const creativeReviewSchema = z
  .object({
    decision: z.enum(CREATIVE_DECISIONS),
    note: z.string().trim().max(1000).optional(),
    checks: z.array(creativeCheck).max(10).optional(),
  })
  .refine((body) => body.decision === 'APPROVED' || Boolean(body.note && body.note.length > 0), {
    message: 'Say what is wrong: a note is required unless the artwork is approved',
    path: ['note'],
  });

export const bulkCreativeReviewSchema = z
  .object({
    creativeIds: z.array(z.string().min(1)).min(1).max(50),
    decision: z.enum(CREATIVE_DECISIONS),
    note: z.string().trim().max(1000).optional(),
  })
  .refine((body) => body.decision === 'APPROVED' || Boolean(body.note && body.note.length > 0), {
    message: 'Say what is wrong: a note is required unless the artwork is approved',
    path: ['note'],
  });

/** The advertiser sending ADX-designed artwork back. */
export const requestChangesSchema = z.object({
  note: z.string().trim().min(3).max(1000),
});

/**
 * The review queue, on the list contract: `status` chips, plus `kind` (the
 * creative path), `flagged` (carries at least one flag), `resubmitted` (a
 * re-upload after a refusal) and `q` over the campaign's name and reference.
 */
export const reviewQueueQuerySchema = listQuerySchema(CREATIVE_STATUSES, ['OLDEST', 'NEWEST']).extend({
  kind: z.enum(['STATIC_IMAGES', 'VIDEO_OR_MOTION', 'DYNAMIC_HTML5', 'ADX_DESIGN_AGENCY']).optional(),
  flagged: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  resubmitted: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});
export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;

/* ── Lot D (Q7/Q139): landing-page interactions ────────────────────── */

export const interactionSchema = z.object({
  type: z.enum(['VIEW', 'CTA_CLICK', 'FORM_SUBMIT']),
  ctaLabel: z.string().trim().min(1).max(80).optional(),
});

/* ── Landing pages — Lot E (Q7/Q106) ───────────────────────────────── */

/**
 * The five kinds of block the builder lays out, each a closed shape.
 *
 * Closed on purpose: the page is rendered by the backend into HTML, and every
 * string here reaches a browser. A block the renderer does not know is a
 * block it cannot escape, so the union is the whole vocabulary.
 */
const httpUrl = z.string().trim().url().max(2000).refine((value) => /^https?:\/\//i.test(value), {
  message: 'Expected an http(s) URL',
});

export const landingBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hero'),
    headline: z.string().trim().min(1).max(120),
    subheadline: z.string().trim().max(240).optional(),
    imageUrl: httpUrl.nullable().optional(),
  }),
  z.object({
    type: z.literal('offer'),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().max(800),
    highlight: z.string().trim().max(80).optional(),
  }),
  z.object({
    type: z.literal('cta'),
    label: z.string().trim().min(1).max(60),
    /** Where the button goes. Without one it opens the contact form below. */
    href: httpUrl.nullable().optional(),
  }),
  z.object({
    type: z.literal('contact'),
    phone: z.string().trim().max(20).optional(),
    email: z.string().trim().email().max(160).optional(),
    address: z.string().trim().max(240).optional(),
    hours: z.string().trim().max(120).optional(),
    note: z.string().trim().max(240).optional(),
    /** Draws the name-and-phone form whose submit is a FORM_SUBMIT event. */
    formEnabled: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('gallery'),
    images: z.array(z.object({ url: httpUrl, alt: z.string().trim().max(120).optional() })).max(12).default([]),
    /** Empty frames the advertiser fills in later, drawn as such. */
    placeholders: z.number().int().min(0).max(6).default(0),
  }),
]);
export type LandingBlock = z.infer<typeof landingBlockSchema>;

export const landingThemeSchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  font: z.enum(['sans', 'serif']).optional(),
});
export type LandingTheme = z.infer<typeof landingThemeSchema>;

export const landingPagePatchSchema = z
  .object({
    blocks: z.array(landingBlockSchema).min(1).max(20),
    theme: landingThemeSchema.nullable(),
  })
  .partial()
  .refine((value) => value.blocks !== undefined || value.theme !== undefined, {
    message: 'Send blocks, a theme, or both',
  });

export const LANDING_PAGE_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
export const landingPageListQuerySchema = listQuerySchema(LANDING_PAGE_STATUSES, ['NEWEST']);
export type LandingPageListQuery = z.infer<typeof landingPageListQuerySchema>;

export const unpublishLandingPageSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

/* ── Money and the end of the flow ─────────────────────────────────── */

export const cancelSchema = z.object({
  reason: z.string().min(3).max(500),
});

export const redemptionSchema = z.object({
  count: z.number().int().min(1).max(100_000),
});

/**
 * Lot C (Q88): an ADMIN authorising on the advertiser's behalf types the
 * campaign reference back and, above the platform threshold, names the
 * second admin. Both optional at the schema: the advertiser's own authorise
 * sends nothing, and the service decides what an admin has to carry.
 */
export const authorizeSchema = z.object({
  confirm: z.string().trim().max(64).optional(),
  approvedByUserId: z.string().trim().min(1).max(64).optional(),
});

/* ── Reading ───────────────────────────────────────────────────────── */

/** Every state a campaign can be in — named so the chip row can count each. */
export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'PENDING_PAYMENT',
  'SCHEDULED',
  'LIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;

const statusEnum = z.enum([
  'DRAFT',
  'PENDING_PAYMENT',
  'SCHEDULED',
  'LIVE',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
]);

/**
 * DR 06's campaign list and DR 10's worklist, one contract.
 *
 * `search` is kept beside the canonical `q` because both apps already send it;
 * renaming in one step would have left two campaign lists silently unfiltered.
 * The service folds them together so the repository only ever sees `q`.
 *
 * `ENDING_SOON` sorts on `endDate` with nulls last — a draft has no dates, and
 * a list of what is about to finish should not open with things that never
 * started.
 */
export const listCampaignsQuerySchema = listQuerySchema(CAMPAIGN_STATUSES, [
  'NEWEST',
  'OLDEST',
  'BUDGET_DESC',
  'ENDING_SOON',
  'NAME',
]).extend({
  /** Deprecated alias for `q`. */
  search: z.string().trim().min(1).max(120).optional(),
  /**
   * One advertiser's campaigns — the console's advertiser page.
   *
   * Honoured for ADMIN only: for anybody else the scope is already their own,
   * and letting them name an advertiser would be a way to read someone else's
   * book. The service drops it rather than trusting it.
   */
  advertiserId: z.string().trim().min(1).max(64).optional(),
});
export type ListCampaignsQuery = z.infer<typeof listCampaignsQuerySchema>;

export const analyticsQuerySchema = z.object({
  search: z.string().max(120).optional(),
  days: z.coerce.number().int().min(1).max(90).optional(),
  status: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(',') : undefined))
    .pipe(z.array(statusEnum).optional()),
});

/** E11-2: the comparison window on one campaign's analytics — the previous window is the same length before it. */
export const campaignAnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});
