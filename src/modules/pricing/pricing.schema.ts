import { z } from 'zod';

/**
 * Money arrives as a decimal string, never a number.
 *
 * `Decimal(14,2)` in the column and a binary float on the wire is how a rate
 * becomes 1249.9999999999998 somewhere between the form and the database. The
 * string survives the trip intact.
 */
const moneyString = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Expected an amount like "1200" or "1200.50"')
  // The column has a positivity CHECK; catching zero here makes it a 400 with a
  // sentence rather than a constraint violation rendered as a 500.
  .refine((v) => Number(v) > 0, 'A rate must be greater than zero');

const latitude = z.number().min(-90).max(90);
const longitude = z.number().min(-180).max(180);

const slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Expected a lowercase slug');

export const listingCategorySchema = z.enum(['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA']);

/* ── Evaluation ─────────────────────────────────────────────────────── */

export const evaluateSchema = z.object({
  /**
   * The venue the spot sits in, and part of the match key.
   *
   * Omitted means *no venue*, not "any venue": an outdoor hoarding stands on a
   * road rather than inside something, and it pools with the other spots that
   * also have none. Sending it matters — a caller who leaves it off for an
   * indoor spot is asking about a different market from the one their listing
   * will be filed under, and would be told a range that never applies to them.
   */
  venueTypeId: z.string().min(1).nullish(),
  mediaTypeId: z.string().min(1),
  sizeClassId: z.string().min(1),
  latitude,
  longitude,
  ratePerDay: moneyString,
  city: z.string().max(120).nullish(),
  excludeListingId: z.string().min(1).optional(),
});

export const comparablesSchema = evaluateSchema.omit({ ratePerDay: true });

/* ── Vocabularies ───────────────────────────────────────────────────── */

export const createMediaTypeSchema = z.object({
  // Long enough for the catalogue's own names, which are venue-qualified:
  // "Event Venues / Convention Centers / Expo Halls — Coffee Station Branding"
  // is 120 characters before anybody has typed anything unusual.
  name: z.string().min(2).max(200),
  slug: slug.optional(),
  category: listingCategorySchema,
  description: z.string().max(2000).nullish(),
  /**
   * The venue this format lives in.
   *
   * Without it here, a venue could only ever be attached by the seed script:
   * the console told an operator to "add some under Pricing -> Media types" for
   * an empty venue, and that screen could not produce a type belonging to it.
   * Null is a real answer — a roadside hoarding has no venue — but it has to be
   * a chosen one rather than the only one available.
   */
  venueTypeId: z.string().min(1).nullish(),
  /** Catalogue heading, for grouping a long list. Not part of the match key. */
  formatGroup: z.string().max(160).nullish(),
  /**
   * The sizes this type is actually built in, and what it is made of.
   *
   * Empty means unconstrained rather than "none" — a type nobody has pinned
   * down yet should still accept listings, or adding one would block the
   * catalogue until somebody finished the paperwork.
   */
  sizeClassIds: z.array(z.string().min(1)).max(100).optional(),
  materialIds: z.array(z.string().min(1)).max(100).optional(),
});

export const mediaTypeAttributesSchema = z
  .object({
    sizeClassIds: z.array(z.string().min(1)).max(100),
    materialIds: z.array(z.string().min(1)).max(100),
  })
  .partial()
  .refine((v) => v.sizeClassIds !== undefined || v.materialIds !== undefined, {
    message: 'Send sizeClassIds, materialIds, or both',
  });

/**
 * `isActive` is deliberately absent.
 *
 * Deactivating a media type used to write `status = MERGED` with no
 * `mergedIntoId`, producing a tombstone pointing nowhere: listings still on it
 * silently vanished from every comparable set, and imports naming it were told
 * it had been "merged away" into nothing. Retiring a type is a merge, and merge
 * is the only door to it.
 */
export const updateMediaTypeSchema = z
  .object({
    // Matching create. A shorter cap here meant the catalogue's own longest
    // names could be seeded and then never renamed through the API.
    name: z.string().min(2).max(200),
    description: z.string().max(2000).nullable(),
    category: listingCategorySchema,
    /** Re-filing a type under a venue moves every listing on it to a new pool. */
    venueTypeId: z.string().min(1).nullable(),
    formatGroup: z.string().max(160).nullable(),
  })
  .partial();

/**
 * Dimensions in feet, as decimal strings.
 *
 * Area is never accepted — it is derived from these. A stored area that
 * disagrees with its own dimensions is a silent pricing error the moment
 * anything normalises by it.
 */
const feet = z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, 'Expected a measurement like "20" or "10.5"');

export const createSizeClassSchema = z.object({
  name: z.string().min(1).max(60),
  slug: slug.optional(),
  widthFt: feet.nullish(),
  heightFt: feet.nullish(),
});

export const updateSizeClassSchema = z
  .object({
    name: z.string().min(1).max(60),
    widthFt: feet.nullable(),
    heightFt: feet.nullable(),
    isActive: z.boolean(),
  })
  .partial();

export const createMaterialSchema = z.object({
  name: z.string().min(2).max(80),
  slug: slug.optional(),
});

export const updateMaterialSchema = z
  .object({ name: z.string().min(2).max(80), isActive: z.boolean() })
  .partial();

/* ── Venues ─────────────────────────────────────────────────────────
 * The level between a category and a spot type, and the coarsest thing the
 * match key divides on. Adding one splits a pool; deactivating one leaves the
 * listings already filed under it where they are.
 */

export const createVenueTypeSchema = z.object({
  name: z.string().min(2).max(160),
  slug: slug.optional(),
  category: listingCategorySchema,
  description: z.string().max(500).nullish(),
  /**
   * The named areas inside this venue — a mall's atrium, its food court, its
   * lift lobbies. Offered to a publisher as the placement they are listing,
   * rather than asked for as free text nobody can group afterwards.
   */
  subVenues: z.array(z.string().min(1).max(160)).max(300).optional(),
});

export const updateVenueTypeSchema = z
  .object({
    name: z.string().min(2).max(160),
    /**
     * Correctable, because comparables match on the venue *id* and nothing else.
     * Category only decides which group the venue appears under in a picker and
     * which media types are offered beside it — so a venue filed as OUTDOOR that
     * is plainly indoor is a labelling mistake, and leaving it uncorrectable
     * would mean seeding a duplicate to fix it, which is the one thing this
     * level of the key must never invite.
     */
    category: listingCategorySchema,
    description: z.string().max(500).nullable(),
    subVenues: z.array(z.string().min(1).max(160)).max(300),
    isActive: z.boolean(),
  })
  .partial();

/* ── Scraper sources ────────────────────────────────────────────────── */

export const scraperSourceSchema = z.object({
  name: z.string().min(2).max(120),
  url: z.string().url(),
  kind: z.enum(['HTML', 'FEED', 'JSON', 'MANUAL']).default('HTML'),
  /** Canonical City slugs. Empty means the source is national. */
  citySlugs: z.array(slug).max(200).default([]),
  /** Selectors for HTML, paths for JSON. Shape follows `kind`. */
  fieldMap: z.record(z.string(), z.unknown()).nullish(),
  defaultUpliftPct: z.string().regex(/^0(\.\d{1,4})?$|^1(\.0{1,4})?$/).default('0.10'),
  intervalMinutes: z.number().int().min(5).max(44_640).default(360),
  /** Off by default: a new source proposes windows rather than acting. */
  autoEnableWindows: z.boolean().default(false),
});

export const updateScraperSourceSchema = scraperSourceSchema.partial();

export const setScraperEnabledSchema = z.object({
  enabled: z.boolean(),
  note: z.string().max(500).nullish(),
});

export const matchMediaTypeSchema = z.object({
  name: z.string().min(2).max(200),
  category: listingCategorySchema,
  /**
   * The venue the spot is in, so a type minted from a name inherits it.
   *
   * Without this, a publisher who describes their spot in words gets a
   * venue-less media type while their listing carries a venue — and the two
   * halves of the same real spot end up in different comparable pools.
   */
  venueTypeId: z.string().min(1).nullish(),
  listingId: z.string().min(1).nullish(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const mergeMediaTypesSchema = z.object({
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
});

export const resolveProposalSchema = z.object({
  resolvedTo: z.string().max(120).nullish(),
});

/* ── Factors ────────────────────────────────────────────────────────── */

/**
 * The predicate language for `suggestWhen`.
 *
 * Recursive, so it needs an explicit type annotation — zod cannot infer through
 * its own lazy reference. Kept to comparisons joined by all/any/not on purpose:
 * ops-authored JSON that reaches an evaluator is a remote code execution with
 * extra steps.
 */
export type PredicateInput =
  | { all: PredicateInput[] }
  | { any: PredicateInput[] }
  | { not: PredicateInput }
  | { field: string; eq: unknown }
  | { field: string; in: unknown[] }
  | { field: string; gt: number }
  | { field: string; gte: number }
  | { field: string; lt: number }
  | { field: string; lte: number };

/**
 * Nesting depth a rule may reach.
 *
 * `z.lazy` recurses as deep as the payload does, and so does the evaluator, so
 * a deeply nested `all` in a large body blows the stack inside zod itself and
 * surfaces as a 500. Ten is far past anything a real factor rule needs.
 */
const MAX_PREDICATE_DEPTH = 10;

/**
 * Depth of a JSON value, measured iteratively.
 *
 * Explicit stack rather than recursion: this runs on untrusted input precisely
 * because that input may be deep enough to blow the call stack, so measuring it
 * recursively would fail exactly when it matters.
 */
export function predicateDepth(root: unknown): number {
  let deepest = 0;
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > deepest) deepest = depth;
    // Bail as soon as the answer cannot change the verdict, so a pathological
    // payload costs a bounded walk rather than a full traversal.
    if (deepest > MAX_PREDICATE_DEPTH) return deepest;
    if (node === null || typeof node !== 'object') continue;
    // An array is the payload of the operator holding it, not a level of its
    // own. Charging for it made `all` cost two levels and `not` one, so the cap
    // was four nested `all` while the message promised ten.
    const children = Array.isArray(node)
      ? node.map((item) => ({ node: item, depth }))
      : Object.values(node as Record<string, unknown>).map((value) => ({
          node: value,
          depth: depth + 1,
        }));
    for (const child of children) {
      if (child.node !== null && typeof child.node === 'object') stack.push(child);
    }
  }
  return deepest;
}

export const predicateSchema: z.ZodType<PredicateInput> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(predicateSchema).min(1) }),
    z.object({ any: z.array(predicateSchema).min(1) }),
    z.object({ not: predicateSchema }),
    z.object({ field: z.string().min(1), eq: z.unknown() }),
    z.object({ field: z.string().min(1), in: z.array(z.unknown()).min(1) }),
    z.object({ field: z.string().min(1), gt: z.number() }),
    z.object({ field: z.string().min(1), gte: z.number() }),
    z.object({ field: z.string().min(1), lt: z.number() }),
    z.object({ field: z.string().min(1), lte: z.number() }),
  ])
);

/**
 * The public entry point. Depth is checked **before** the grammar runs.
 *
 * Order is the whole point. Refining the parsed value cannot help: `z.lazy`
 * recurses as deep as the payload, so a 10 KB body nested a thousand levels
 * threw a RangeError inside zod itself — an uncaught 500 — long before any
 * refine was reached. The cheap iterative check has to come first.
 */
export const boundedPredicateSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    if (predicateDepth(value) > MAX_PREDICATE_DEPTH) {
      ctx.addIssue({
        code: 'custom',
        message: `A factor rule may nest at most ${MAX_PREDICATE_DEPTH} levels deep`,
      });
    }
  })
  .pipe(predicateSchema);

export const createFactorSchema = z
  .object({
    name: z.string().min(2).max(120),
    slug: slug.optional(),
    description: z.string().max(500).nullish(),
    kind: z.enum(['BASE_ADJUST', 'MULTIPLIER']),
    mediaTypeId: z.string().min(1),
    /** Below 1 is a discount and legitimate; zero or negative inverts a price. */
    multiplier: z.string().regex(/^\d+(\.\d{1,4})?$/).nullish(),
    baseAdjust: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/).nullish(),
    suggestWhen: boundedPredicateSchema.nullish(),
    /**
     * Lot E (Q125): ADVISORY proposes a rate the publisher may accept; BINDING
     * reprices the listing when applied, within `maxBindingChangePct`.
     * `bindingDuringSurgeOnly` makes a BINDING factor advisory outside a surge.
     */
    mode: z.enum(['ADVISORY', 'BINDING']).optional(),
    bindingDuringSurgeOnly: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.kind === 'MULTIPLIER'
        ? typeof v.multiplier === 'string' && Number(v.multiplier) > 0 && v.baseAdjust == null
        : typeof v.baseAdjust === 'string' && v.multiplier == null,
    {
      message:
        'A MULTIPLIER needs a positive multiplier and no baseAdjust; a BASE_ADJUST needs a baseAdjust and no multiplier',
      path: ['kind'],
    }
  );

/**
 * A patch cannot cross a factor from one kind to the other.
 *
 * `kind` is not patchable, and setting the other kind's value is rejected here
 * rather than by the database. The PricingFactor_value_matches_kind CHECK does
 * catch it, but a constraint violation is not an ApiError, so the error handler
 * turns a plain validation failure into a 500.
 */
export const updateFactorSchema = z
  .object({
    name: z.string().min(2).max(120),
    description: z.string().max(500).nullable(),
    multiplier: z.string().regex(/^\d+(\.\d{1,4})?$/),
    baseAdjust: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/),
    suggestWhen: boundedPredicateSchema.nullable(),
    isActive: z.boolean(),
    mode: z.enum(['ADVISORY', 'BINDING']),
    bindingDuringSurgeOnly: z.boolean(),
  })
  .partial()
  .refine((v) => v.multiplier === undefined || Number(v.multiplier) > 0, {
    message: 'A multiplier must be greater than zero — zero or below inverts a price',
    path: ['multiplier'],
  })
  .refine((v) => v.multiplier === undefined || v.baseAdjust === undefined, {
    message: 'A factor is either a multiplier or a base adjustment, never both',
    path: ['baseAdjust'],
  });

export const applyFactorSchema = z.object({
  factorId: z.string().min(1),
  applied: z.boolean(),
});

/* ── Market data ────────────────────────────────────────────────────── */

export const importRowSchema = z.object({
  contributorName: z.string().min(1).max(160),
  /**
   * The venue the observed spot sits in. Omitted means none, which is right for
   * a roadside hoarding and wrong for a gym decal — a sweep that leaves it off
   * files every indoor observation into the venue-less pool, where no indoor
   * listing will ever look for it.
   */
  venueTypeSlug: slug.nullish(),
  /** Set when the researched company is also an ADX publisher, so they count once. */
  publisherId: z.string().min(1).nullish(),
  mediaTypeSlug: slug,
  sizeClassSlug: slug,
  materialSlug: slug.nullish(),
  latitude,
  longitude,
  city: z.string().max(120).nullish(),
  locality: z.string().max(160).nullish(),
  ratePerDay: moneyString,
  observedAt: z.string().min(4),
});

export const importMarketDataSchema = z.object({
  source: z.enum(['RESEARCH', 'RATE_CARD']),
  filename: z.string().max(260).nullish(),
  note: z.string().max(500).nullish(),
  publisherId: z.string().min(1).nullish(),
  // Bounded so one upload cannot hold a transaction open long enough to matter.
  rows: z.array(importRowSchema).min(1).max(5000),
});

/* ── Surge ──────────────────────────────────────────────────────────── */

export const surgeWindowSchema = z
  .object({
    name: z.string().min(2).max(160),
    scope: z.enum(['CITY', 'NATIONAL', 'INTERNATIONAL']),
    source: z.enum(['SCRAPER', 'OPS', 'AI_AGENT']).default('OPS'),
    externalRef: z.string().max(200).nullish(),
    city: z.string().max(120).nullish(),
    latitude: latitude.nullish(),
    longitude: longitude.nullish(),
    radiusMeters: z.number().int().positive().max(200_000).nullish(),
    startsAt: z.string().min(4),
    endsAt: z.string().min(4),
    /** 0.25 is a 25% lift on the ceiling. Never negative — surge only widens. */
    upliftPct: z.string().regex(/^\d(\.\d{1,4})?$/),
    isPublic: z.boolean().default(false),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: 'A surge window has to end after it starts',
    path: ['endsAt'],
  })
  .refine(
    (v) =>
      v.scope !== 'CITY' ||
      !!v.city ||
      (v.latitude != null && v.longitude != null && v.radiusMeters != null),
    {
      // A point without a radius used to be accepted, then matched nothing
      // forever: surgeApplies needs all three to test containment, and falls
      // through to city-name matching which a null city can never satisfy.
      message: 'A city-scoped window needs a city, or a point AND a radius',
      path: ['radiusMeters'],
    }
  )
  .refine((v) => v.source === 'OPS' || !!v.externalRef, {
    // Every *automated* source, not just the scraper. Without a provider id the
    // upsert takes the create branch, so a re-run of a source that ops had
    // disabled raises a fresh enabled duplicate beside it — and activeSurge
    // takes the strongest window. The kill switch has to survive the next run
    // to be a kill switch at all, and the planned generative agent republishes
    // on exactly the same terms as the scraper.
    //
    // OPS is exempt because a person creating a one-off window has no upstream
    // id to quote, and will not silently re-create it.
    message: 'An automated window must carry the upstream event id it was built from',
    path: ['externalRef'],
  });

export const setSurgeEnabledSchema = z.object({
  enabled: z.boolean(),
  note: z.string().max(500).nullish(),
});

/* ── Settings ───────────────────────────────────────────────────────── */

export const updateSettingsSchema = z
  .object({
    // Not unbounded: the radius is the engine's central claim about what counts
    // as "nearby", and a stray 200000 would quietly turn it into a city average.
    radiusMeters: z.number().int().min(50).max(5_000),
    highEdgePct: z.string().regex(/^0(\.\d{1,4})?$/),
    lowEdgePct: z.string().regex(/^0(\.\d{1,4})?$/),
    thinEvidenceCount: z.number().int().min(1).max(50),
    validatedTakeoverCount: z.number().int().min(1).max(50),
    minContributors: z.number().int().min(1).max(50),
    stalenessMonths: z.number().int().min(1).max(60),
    mediaTypeMatchThreshold: z.string().regex(/^0(\.\d{1,4})?$|^1(\.0{1,4})?$/),
    maxCompoundMultiplier: z.string().regex(/^\d{1,2}(\.\d{1,4})?$/),
    // Lot E (Q125): a fraction of the current rate. Zero would make every
    // binding factor a price case; one would let a factor double a rate unasked.
    maxBindingChangePct: z.string().regex(/^0(\.\d{1,4})?$|^1(\.0{1,4})?$/),
    // Capped well below 1: a tolerance approaching half a dimension would fold
    // every size in the catalogue into whichever class happened to be seeded
    // first, and the symptom would be a suspiciously wide range rather than an
    // error anybody could trace.
    sizeTolerancePct: z
      .string()
      .regex(/^0(\.\d{1,4})?$/)
      .refine((v) => Number(v) <= 0.25, {
        message: 'A size tolerance above 25% would merge genuinely different sizes',
      }),
  })
  .partial();

/**
 * Ops switching a geography on or off, or teaching the resolver another
 * spelling. Name and state are not editable here: a city is renamed by the
 * seed, and a row whose canonical name moved under the listings already
 * filed against it would be a different city wearing the same key.
 */
export const updateCitySchema = z
  .object({
    isActive: z.boolean().optional(),
    aliases: z.array(z.string().trim().min(1).max(80)).max(25).optional(),
  })
  .refine((body) => body.isActive !== undefined || body.aliases !== undefined, {
    message: 'Name isActive, aliases, or both',
  });
