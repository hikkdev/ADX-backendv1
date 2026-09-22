import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE, listQuerySchema } from '../../shared/pagination';
import { upperEnum } from '../../shared/validation';

export const LISTING_CATEGORIES = ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] as const;

/**
 * The canonical rate, as a decimal string.
 *
 * `monthlyPrice` below is the old shape: a JSON float into a `Float` column,
 * which is the wrong type for money. Both are accepted and each is derived from
 * the other, so existing callers keep working while new ones move across.
 */
const ratePerDayString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount like "1200" or "1200.50"')
  .refine((v) => Number(v) > 0, 'A rate must be greater than zero');

/**
 * A measurement in feet.
 *
 * Strings for the same reason money is a string, and four integer digits rather
 * than six because `areaSqFt` is `Decimal(10,2)`: 9999.99 x 9999.99 is just
 * under the column's ceiling, and 20000 x 10000 was a numeric overflow rendered
 * as a 500. Every other bad measurement in this module is caught as a 400 with
 * a sentence; there is no reason for this one to be the exception.
 */
const feet = z
  .string()
  .regex(/^\d{1,4}(\.\d{1,2})?$/, 'Expected a measurement like "6" or "6.5"')
  .refine((v) => Number(v) > 0, 'A measurement must be greater than zero');

/**
 * How many ways this request states the price.
 *
 * Three shapes are accepted and exactly one may be used. They are not
 * alternatives that happen to agree — `{monthlyPrice: 30000, pricingUnit:
 * "PER_DAY", basePrice: "100"}` says both 1000 a day and 100 a day — and with
 * two resolution orders in the codebase, create and update picked different
 * ones and stored rates that differed by a factor of ten from the same body.
 * Rejecting is the only answer that cannot be quietly wrong.
 */
const priceShapes = (v: {
  ratePerDay?: unknown;
  monthlyPrice?: unknown;
  basePrice?: unknown;
  pricingUnit?: unknown;
}): number =>
  (v.ratePerDay !== undefined ? 1 : 0) +
  (v.monthlyPrice !== undefined ? 1 : 0) +
  (v.basePrice !== undefined || v.pricingUnit !== undefined ? 1 : 0);

/**
 * What a publisher will and will not carry — DR 02 step 6.
 *
 * Two strengths of one statement, drawn differently because they mean different
 * things. A restricted category can run with the owner's approval; a prohibited
 * one never runs at all. The design puts the first behind dropdowns and the
 * second behind checkboxes, and that is the whole difference.
 */
export const CONTENT_STANCES = [
  'ALLOWED',
  'REQUIRES_APPROVAL',
  'NOT_ALLOWED',
  'PROHIBITED',
] as const;

export const contentRulesSchema = z
  .array(
    z.object({
      contentCategoryId: z.string().min(1),
      stance: z.enum(CONTENT_STANCES),
    })
  )
  .max(50);

export const PRICING_UNITS = [
  'PER_DAY',
  'PER_WEEK',
  'PER_MONTH',
  'PER_SQFT_PER_DAY',
  'PER_SQFT_PER_MONTH',
] as const;

/**
 * Everything DR 02 asks about a spot beyond its price and its address.
 *
 * One object spread into both create and update, because a listing that can be
 * described on the way in but not corrected afterwards is a listing whose
 * mistakes are permanent — and these fields feed the match key and the factor
 * rules, so a mistake here is a listing quietly compared against the wrong
 * market.
 */
const spotAttributes = {
  /* Step 2 — the venue. Part of the comparable match key. */
  venueTypeId: z.string().min(1).optional(),
  venueTypeSlug: z.string().min(1).max(80).optional(),

  /* Step 4 — where in the venue, and how big. `areaSqFt` is derived from the
     pair rather than accepted, so nothing can store an area that disagrees
     with its own dimensions. */
  placement: z.string().max(200).optional(),
  widthFt: feet.optional(),
  heightFt: feet.optional(),

  /* Step 5 — the selling story. Separate fields rather than one blob because
     each is a distinct claim an advertiser may act on. */
  targetAudience: z.string().max(500).optional(),
  /** The argument, not the sightline. `visibility` below is the observable. */
  uniqueSellingPoint: z.string().max(500).optional(),
  footfallNote: z.string().max(500).optional(),

  /* Physical attributes a pricing factor can key on. Controlled strings rather
     than enums so ops can extend the vocabulary without a migration. */
  illumination: z.string().max(60).optional(),
  facing: z.string().max(60).optional(),
  elevation: z.string().max(60).optional(),
  visibility: z.string().max(60).optional(),
  trafficGrade: z.string().max(60).optional(),

  /* Step 7 — availability. */
  minBookingDays: z.number().int().min(1).max(3650).optional(),
  availableFrom: z.coerce.date().optional(),
  availableHoursFrom: z.string().max(20).optional(),
  availableHoursTo: z.string().max(20).optional(),
  /** "Evenings and weekends" — when the spot is worth most, not when it is free. */
  peakPeriodNote: z.string().max(300).optional(),
  rateCardUrl: z.string().url().max(2000).optional(),
  /** AG-4: a vehicle put up as a spot — an auto, a cab, a van wrap — by its registration (KA01AB1234); the desk checks it against the RC. */
  vehicleNumber: z
    .string()
    .trim()
    .max(20)
    .transform((value) => value.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    .optional(),
} as const;

/**
 * The publisher's own unit and figure.
 *
 * A mall quotes rupees per square foot per month; a billboard owner quotes per
 * day. Converting in the publisher's head is how a rate gets mistyped by a
 * factor of thirty, so the form takes the pair and the service derives
 * `ratePerDay` from it. Both are stored — the derived one is what the engine
 * compares, the typed one is what the publisher will recognise.
 */
/** Lot G (Q116/136): a loop of 1..24. Integer, because a slot is a whole advertiser. */
const slotsTotalField = z.number().int().min(1).max(24).optional();

const pricingModelFields = {
  pricingUnit: z.enum(PRICING_UNITS).optional(),
  basePrice: ratePerDayString.optional(),
} as const;

export const createListingSchema = z.object({
  /**
   * Whose spot this is.
   *
   * Optional, because a publisher listing their own does not have to tell the
   * server who they are — and must not be able to say somebody else. The
   * controller fills it from their own record and ignores anything sent here.
   */
  publisherId: z.string().min(1).optional(),
  /** QR-8: the saved draft this listing finishes; its reference becomes the listing's and the draft is removed. */
  draftId: z.string().min(1).optional(),
  title: z.string().min(1),
  category: upperEnum(LISTING_CATEGORIES),
  subType: z.string().optional(),
  description: z.string().optional(),
  address: z.string().min(1),
  city: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  size: z.string().optional(),
  monthlyPrice: z.number().positive().optional(),
  ratePerDay: ratePerDayString.optional(),
  /* Structured attributes the pricing engine matches comparables on. All three
     are needed for a listing to enter a comparable pool — the match key is not
     partial. Ids or slugs; a slug must already be in the controlled list. */
  sizeClassId: z.string().min(1).optional(),
  sizeClassSlug: z.string().min(1).max(80).optional(),
  materialId: z.string().min(1).optional(),
  materialSlug: z.string().min(1).max(80).optional(),
  mediaTypeId: z.string().min(1).optional(),
  /**
   * A media type by name rather than id, resolved through the similarity
   * threshold. This is the door requirement nine comes through: a spot
   * described in words is matched against the taxonomy, or logged as new.
   */
  mediaTypeName: z.string().min(2).max(120).optional(),
  ...spotAttributes,
  ...pricingModelFields,
  /**
   * Replaces the whole set, so unticking a category actually removes it.
   *
   * A partial merge would mean a publisher could never take a stance back — the
   * only way out of "no alcohol" would be a category that no longer exists.
   */
  contentRules: contentRulesSchema.optional(),
  pricingModel: z.string().optional(),
  availableNow: z.boolean().optional(),
  /**
   * Lot D (Q105): the publisher's opt-in to automatic acceptance. Off by
   * default and never recommended; the service refuses it without the flag
   * (409 FEATURE_OFF) or without an address on file (409 NO_MEETING_PLACE).
   */
  instantBooking: z.boolean().optional(),
  /**
   * Lot G (Q116/136): how many advertisers the spot carries at once — a
   * digital screen's loop, 1..24. Only a spot that names a screen may say
   * more than 1; the service refuses the rest (400). See `slots.service`.
   */
  slotsTotal: slotsTotalField,
  photos: z.array(z.object({ url: z.string().url(), type: z.string() })).optional(),
  planId: z.string().optional(),
  /**
   * QR-24: how the publisher holds the space and, for a lease, licence or
   * permit, the day it runs out (YYYY-MM-DD, stored as the last instant of
   * that day). The vocabulary is the database's `RightsBasis`; spelt out
   * here rather than imported, since `listings` does not reach into `supply`.
   */
  rightsBasis: upperEnum(['OWNED', 'LEASED', 'LICENSED', 'PERMIT']).optional(),
  rightsValidUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    // The last instant of that day in India, as `supply` stores a renewal's date.
    .transform((day) => new Date(`${day}T23:59:59.999+05:30`))
    .optional(),
  // ADMIN-only: create on behalf of a specific agent (identified by their
  // AgentProfile id, e.g. from GET /agents) rather than the caller's own.
  agentId: z.string().optional(),
})
  .refine(
    (v) =>
      v.monthlyPrice !== undefined ||
      v.ratePerDay !== undefined ||
      (v.basePrice !== undefined && v.pricingUnit !== undefined),
    {
      message:
        'A listing needs a price — send basePrice with pricingUnit, or ratePerDay, or monthlyPrice for the old shape',
      path: ['basePrice'],
    }
  )
  // A unit without a figure prices nothing, and a figure without a unit is
  // ambiguous by exactly the factor of thirty this pair exists to prevent.
  .refine((v) => (v.basePrice === undefined) === (v.pricingUnit === undefined), {
    message: 'Send basePrice and pricingUnit together, or neither',
    path: ['pricingUnit'],
  })
  .refine((v) => priceShapes(v) <= 1, {
    message:
      'Send one price: basePrice with pricingUnit, or ratePerDay, or monthlyPrice — not two that disagree',
    path: ['basePrice'],
  })
  // Per-square-foot pricing needs an area, and the area comes from the tape.
  .refine(
    (v) =>
      v.pricingUnit !== 'PER_SQFT_PER_DAY' && v.pricingUnit !== 'PER_SQFT_PER_MONTH'
        ? true
        : v.widthFt !== undefined && v.heightFt !== undefined,
    {
      message: 'A per-square-foot price needs widthFt and heightFt, so the area can be worked out',
      path: ['widthFt'],
    }
  );

/**
 * The desk's two ways of saying no — DR 10's listing review.
 *
 * `CHANGES_REQUESTED` sends the spot back to the publisher as a draft they can
 * fix and resubmit; `REJECTED` is the end of the road. Both carry a reason
 * because the publisher is shown it verbatim, and "no" with nothing after it is
 * a support ticket rather than a correction. Five characters is the floor
 * below which nothing is a sentence.
 */
/**
 * DR 01's browse query — the drawer's facets (4189:2440) plus a point to
 * search around for "Popular near you". Money arrives as a decimal string;
 * dates as ISO; everything optional.
 */
export const browseQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(80).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    category: z.enum(LISTING_CATEGORIES).optional(),
    /** QR-20: the sub-category — a `VenueType` id, as the home's and the Explore grid's venue tiles hand it over. */
    venueTypeId: z.string().trim().min(1).max(64).optional(),
    /** QR-27: one publisher's live spaces, by the publisher's id. */
    publisherId: z.string().trim().min(1).max(64).optional(),
    display: z.enum(['DIGITAL', 'STATIC']).optional(),
    minRate: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    maxRate: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
    from: z.string().datetime().optional(),
    /**
     * E7-2: the end of the availability window. A spot whose `availableFrom`
     * is after `to`, or that has a booking overlapping [from, to], is left out.
     */
    to: z.string().datetime().optional(),
    minFootfall: z.coerce.number().int().min(0).optional(),
    illuminated: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(1).max(100).default(10),
    /**
     * Lot D (Q5): the advertiser the `saved` mark is resolved for, when the
     * caller is an agent selling from this list rather than the advertiser
     * themselves. Checked through the demand-side policy, never trusted.
     */
    advertiserId: z.string().trim().min(1).max(64).optional(),
    // Lot D (Q105): the drawer's "instant booking" switch. Three states like
    // `illuminated` — absent is no filter.
    instant: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    // DR 06's sort sheet: Newest first, Price low to high, Price high to low,
    // Name A to Z. Its fifth row, "Status", is not offered — browse answers only
    // ACTIVE listings, so there is no status to sort on. RATING (Lot D, Q104)
    // is best-rated first, with the unrated last.
    sort: z.enum(['NEWEST', 'PRICE_ASC', 'PRICE_DESC', 'NAME', 'RATING']).default('NEWEST'),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: 'lat and lng go together',
    path: ['lng'],
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, { message: 'from must not be after to', path: ['to'] });
export type BrowseQuery = z.infer<typeof browseQuerySchema>;

/**
 * G12-B: where the category grid looks — the browse query's place facets
 * and nothing else: a city by name, or a point with a radius.
 */
export const browseCategoriesQuerySchema = z
  .object({
    city: z.string().trim().min(1).max(80).optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(1).max(100).default(10),
  })
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: 'lat and lng go together',
    path: ['lng'],
  });
export type BrowseCategoriesQuery = z.infer<typeof browseCategoriesQuerySchema>;

/** QR-20: the venue tiles take the same place as the category tiles. */
export const browseVenuesQuerySchema = browseCategoriesQuerySchema;

/** Lot G (Q116/136): the window `GET /listings/browse/:id` counts `slotsLeft` over — the campaign's dates, else today. */
export const browseWindowSchema = z
  .object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() })
  .refine((query) => !query.from || !query.to || query.from <= query.to, { message: 'from must not be after to', path: ['to'] });

/**
 * Every state a listing can be in, in the order the lifecycle runs.
 *
 * Named here rather than read off the generated enum because the chip row on
 * the DR 10 table counts each one, including the ones with no rows — a facet
 * that vanishes when it is empty is a facet nobody can get back to.
 */
export const LISTING_STATUSES = [
  'UNCLAIMED',
  'DRAFT',
  'AWAITING_AGREEMENT',
  'AWAITING_DOCUMENTS',
  'PENDING_REVIEW',
  'AWAITING_SITE_VERIFICATION',
  'ACTIVE',
  'SUSPENDED',
  'REJECTED',
  'INACTIVE',
] as const;

/**
 * DR 10's admin listings table (`5102:37197`) — search, the review-status
 * filter, three sortable columns and a page.
 *
 * `SUBMITTED` sorts on `submittedAt`, which is null for anything never sent
 * for review; those sort last rather than first, because the column is there
 * to work the queue.
 */
export const adminListingsQuerySchema = listQuerySchema(LISTING_STATUSES, [
  'NEWEST',
  'OLDEST',
  'RATE_ASC',
  'RATE_DESC',
  'TITLE',
  'SUBMITTED',
]).extend({
  city: z.string().trim().min(1).max(80).optional(),
  category: z.enum(LISTING_CATEGORIES).optional(),
});
export type AdminListingsQuery = z.infer<typeof adminListingsQuerySchema>;

/**
 * The review desk's queue (`/listings/review`, DR 10 `5102:37197`'s sibling).
 *
 * One status by definition, so there is no chip row and no histogram — what
 * the desk needs is to find a case and to not load every pending listing at
 * once, each row of which costs a rate-card gate check.
 *
 * `WAITING` is the default and the working order: oldest submission first, and
 * a row that was never dated (submitted before the column existed) still sorts
 * to the top rather than the bottom, because it has waited longest of all.
 */
export const reviewQueueQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  sort: z.enum(['WAITING', 'NEWEST']).default('WAITING'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});
export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;

/** Lot D (Q5): the saved-spaces page. No status, no sort — newest save first. */
/** G7 (Q109): the month the audience panel is asked about — this month unless said. */
export const audienceQuerySchema = z.object({
  period: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM')
    .optional(),
  /** Lot D-style: an agent names the advertiser they are reading for. */
  advertiserId: z.string().trim().min(1).optional(),
});

export const savedSpacesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});
export type SavedSpacesQuery = z.infer<typeof savedSpacesQuerySchema>;

export const SEND_BACK_OUTCOMES = ['CHANGES_REQUESTED', 'REJECTED'] as const;
export type SendBackOutcome = (typeof SEND_BACK_OUTCOMES)[number];

export const sendBackListingSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(5, 'Say what the publisher has to fix — they are shown this')
    .max(1000),
  outcome: z.enum(SEND_BACK_OUTCOMES).default('CHANGES_REQUESTED'),
});

// Deliberately narrower than create: status is NOT patchable here — publishing
// goes through POST /:listingId/publish so the state machine stays in one place.
/**
 * Classification is patchable, and has to be.
 *
 * Every listing created before the pricing engine existed, and every one
 * created without these fields, carries no media type or size class — and the
 * comparable match key needs both, so none of them can enter a pool. Without a
 * way to classify after the fact the only route back in is a direct database
 * write, which makes the whole engine a feature that only applies to listings
 * created after a particular deploy.
 */
export const updateListingSchema = z.object({
  ...spotAttributes,
  ...pricingModelFields,
  title: z.string().optional(),
  description: z.string().optional(),
  monthlyPrice: z.number().positive().optional(),
  ratePerDay: ratePerDayString.optional(),
  availableNow: z.boolean().optional(),
  /** Lot D (Q105): see the create schema. Switching it off asks nothing. */
  instantBooking: z.boolean().optional(),
  /** Lot G (Q116/136): see the create schema. */
  slotsTotal: slotsTotalField,
  subType: z.string().max(120).optional(),
  category: upperEnum(LISTING_CATEGORIES).optional(),
  sizeClassId: z.string().min(1).optional(),
  sizeClassSlug: z.string().min(1).max(80).optional(),
  materialId: z.string().min(1).optional(),
  materialSlug: z.string().min(1).max(80).optional(),
  mediaTypeId: z.string().min(1).optional(),
  mediaTypeName: z.string().min(2).max(120).optional(),
  contentRules: contentRulesSchema.optional(),
})
  /**
   * A patch may move one half of the pair.
   *
   * Unlike a create, the other half is already on the listing: changing the unit
   * reprices the stored figure, and changing the figure keeps the stored unit.
   * Requiring both would mean restating a number nobody is changing — and the
   * service has implemented the merge since this schema forbade it, so the
   * merge was dead code and the test covering it bypassed the endpoint.
   */
  .refine((v) => priceShapes(v) <= 1, {
    message:
      'Send one price: basePrice or pricingUnit, or ratePerDay, or monthlyPrice — not two that disagree',
    path: ['basePrice'],
  });
