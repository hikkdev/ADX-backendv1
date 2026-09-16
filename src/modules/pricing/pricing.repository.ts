import type {
  ListingCategory,
  MarketDataSource,
  MediaType,
  MediaTypeMatchOutcome,
  Material,
  PricingFactor,
  PricingFactorKind,
  PricingFactorMode,
  PricingSettings,
  ScraperRun,
  ScraperRunStatus,
  ScraperSource,
  SizeClass,
  SurgeEvent,
  SurgeEventScope,
  VenueType,
  VocabularyKind,
} from '../../shared/database';

/**
 * Money crosses this boundary as a decimal string, never a number.
 *
 * The columns are `Decimal(14,2)`; JavaScript numbers are binary floats and
 * cannot hold every two-decimal rupee value exactly. A price range that is off
 * by a paisa is not a rounding curiosity here — it decides whether a publisher
 * is told their price is too high.
 */
export type Money = string;

/**
 * One opinion about what a spot is worth, already reduced to a rate per day.
 *
 * `contributorKey` is who is speaking. A competitor with ten hoardings on one
 * road is one opinion, not ten, so the engine collapses a contributor's points
 * to their median before the range is taken. The key is the same shape whether
 * the point came from an ADX listing (the publisher) or from research (the
 * competitor), which is what lets one rule cover both.
 */
export type Comparable = {
  id: string;
  contributorKey: string;
  contributorName: string | null;
  ratePerDay: Money;
  latitude: number;
  longitude: number;
  /** Distance from the subject spot, filled in by the service. */
  distanceMeters: number;
  /** When the price was observed. Drives the six-month staleness label. */
  observedAt: Date;
  tier: ComparableTier;
  origin: 'LISTING' | 'MARKET_DATA';
  label: string | null;
};

/**
 * Descending order of trust.
 *
 * VALIDATED is an ADX listing that actually drew orders at its asking price —
 * the strongest evidence there is. LISTED is an untested ask, whether ours or a
 * competitor's; an ADX listing nobody bought is worth no more than a rate we
 * observed in the field. PROVISIONAL is a publisher's own rate card, which is
 * unverified and displaced the moment anything better exists.
 */
export type ComparableTier = 'VALIDATED' | 'LISTED' | 'PROVISIONAL';

/** The match key. All of it exactly — see docs/pricing-engine.md. */
export type ComparableQuery = {
  /**
   * Null means a spot with no venue — an outdoor hoarding is on a road, not
   * inside anything — and it matches other spots that also have none. It does
   * not mean "any venue": a hoarding and a gym decal are not comparable merely
   * because one of them is unhoused.
   */
  venueTypeId: string | null;
  mediaTypeId: string;
  sizeClassId: string;
  latitude: number;
  longitude: number;
  /** Bounding box the repository prefilters on; the service narrows to radius. */
  latDelta: number;
  lngDelta: number;
  /** Excluded so a listing never compares against itself. */
  excludeListingId?: string;
  /**
   * The moment being asked about. Injected rather than read from the clock so
   * staleness and the surge exclusion cannot disagree — a backfill or a "what
   * did this say last month" tool has to see one consistent instant.
   */
  now: Date;
};

export type NewSizeClass = {
  name: string;
  slug: string;
  widthFt: string | null;
  heightFt: string | null;
};

export type NewScraperSource = {
  name: string;
  url: string;
  kind: 'HTML' | 'FEED' | 'JSON' | 'MANUAL';
  citySlugs: string[];
  fieldMap: unknown;
  defaultUpliftPct: string;
  intervalMinutes: number;
  autoEnableWindows: boolean;
};

export type NewMediaType = {
  name: string;
  slug: string;
  category: ListingCategory;
  description?: string | null;
  /** The venue this format lives in. Null for outdoor, which has none. */
  venueTypeId?: string | null;
  /** Catalogue heading. Presentation only; the match key never reads it. */
  formatGroup?: string | null;
  origin?: 'SEEDED' | 'OPS' | 'AUTO_MATCHED';
  /** Sizes this type is actually built in. Empty means every size is allowed. */
  sizeClassIds?: string[];
  /** Materials it is made from. Empty means unconstrained. */
  materialIds?: string[];
};

/** A media type with the sizes and materials it comes in. */
export type MediaTypeDetail = MediaType & {
  sizeClassIds: string[];
  materialIds: string[];
};

/**
 * No `isActive`. Retiring a media type is a *merge* into another one, and
 * nothing else.
 *
 * A flag here used to write `status = MERGED` with no `mergedIntoId`, leaving a
 * tombstone pointing nowhere: listings still on it vanished from every
 * comparable set, and imports naming it were told it had been merged away into
 * nothing. The API stopped offering the flag; this removes the branch behind it
 * so it cannot be reached from anywhere else either.
 */
export type MediaTypePatch = Partial<{
  name: string;
  description: string | null;
  category: ListingCategory;
}>;

export type NewMarketDataPoint = {
  source: MarketDataSource;
  importId: string | null;
  contributorKey: string;
  contributorName: string | null;
  publisherId: string | null;
  venueTypeId: string | null;
  mediaTypeId: string;
  sizeClassId: string;
  materialId: string | null;
  latitude: number;
  longitude: number;
  city: string | null;
  locality: string | null;
  ratePerDay: Money;
  observedAt: Date;
};

export type NewSurgeEvent = {
  name: string;
  scope: SurgeEventScope;
  source: 'SCRAPER' | 'OPS' | 'AI_AGENT';
  externalRef: string | null;
  city: string | null;
  latitude: number | null;
  longitude: number | null;
  radiusMeters: number | null;
  /** `city` resolved through the City table, so matching compares keys. */
  citySlug: string | null;
  startsAt: Date;
  endsAt: Date;
  upliftPct: string;
  isPublic: boolean;
};

/** Only what the engine needs to derive factor suggestions and comparables. */
export type ListingPricingContext = {
  id: string;
  publisherId: string | null;
  venueTypeId: string | null;
  mediaTypeId: string | null;
  sizeClassId: string | null;
  materialId: string | null;
  latitude: number | null;
  longitude: number | null;
  city: string | null;
  category: ListingCategory;
  ratePerDay: Money | null;
  mediaTypeSlug: string | null;
  sizeClassSlug: string | null;
  materialSlug: string | null;
  /** Physical attributes a factor rule can key on. */
  illumination: string | null;
  facing: string | null;
  elevation: string | null;
  visibility: string | null;
  trafficGrade: string | null;
  areaSqFt: string | null;
};

export type FactorApplication = {
  factorId: string;
  suggested: boolean;
  applied: boolean;
  /** Lot E: the rate a BINDING apply wrote, or null. */
  appliedRatePerDay: Money | null;
};

/**
 * Lot V (the owner, 15 Sep 2026): the six functions a city's rollout stage
 * switches on and off, one per gate. `geo` owns the stage machine and the
 * writes; this module reads the switches on every gated write.
 */
export const CITY_FUNCTIONS = [
  'supplyIntake',
  'publishing',
  'demand',
  'agentOnboarding',
  'printPartners',
  'leadFeeds',
] as const;
export type CityFunction = (typeof CITY_FUNCTIONS)[number];
export type CitySwitches = Record<CityFunction, boolean>;
/** The Prisma `CityStage` enum, spelled here so the interface needs no ORM import. */
export const CITY_STAGES = ['PLANNED', 'SEEDING', 'LAUNCHED', 'PAUSED', 'WITHDRAWN'] as const;
export type CityStageValue = (typeof CITY_STAGES)[number];

/**
 * A city as ops manage it: the canonical key, its spellings, the switch —
 * and, since Lot V, the rollout stage and the six function switches behind
 * it. `isActive` stays as the mirror of the stage (SEEDING, LAUNCHED and
 * PAUSED are active; PLANNED and WITHDRAWN are not) for every older reader.
 */
export type CityRow = {
  /** Lot X-B: the row id — the key every party table carries as `cityId`. */
  id: string;
  slug: string;
  name: string;
  state: string | null;
  aliases: string[];
  isActive: boolean;
  stage: CityStageValue;
  switches: CitySwitches;
  population: number | null;
};

/**
 * Lot X-B: the eight tables that carry a city key beside their free-text
 * city. `campaigns` keys `targetMarket` as `targetMarketCityId`; the rest
 * key `city` as `cityId`.
 */
export const CITY_KEYED_TABLES = ['publishers', 'advertisers', 'agents', 'printPartners', 'listings', 'leads', 'fieldVisits', 'campaigns'] as const;
export type CityKeyedTable = (typeof CITY_KEYED_TABLES)[number];
export type UnresolvedCityString = { table: CityKeyedTable; city: string; count: number };

export interface PricingRepository {
  /* Settings — one row, read on every evaluation. */
  getSettings(): Promise<PricingSettings | null>;
  updateSettings(patch: Record<string, unknown>, userId: string | null): Promise<PricingSettings>;

  /* Vocabularies. */
  listMediaTypes(includeMerged?: boolean): Promise<MediaTypeDetail[]>;
  findMediaType(id: string): Promise<MediaType | null>;
  findMediaTypeBySlug(slug: string): Promise<MediaType | null>;
  /** T-B: the create and the patch answer the detail the list answers — `sizeClassIds`, `materialIds` beside the row. */
  createMediaType(data: NewMediaType): Promise<MediaTypeDetail>;
  updateMediaType(id: string, patch: MediaTypePatch): Promise<MediaTypeDetail>;
  /** Replaces the whole set. Passing an empty array clears the constraint. */
  setMediaTypeAttributes(
    id: string,
    attributes: { sizeClassIds?: string[]; materialIds?: string[] }
  ): Promise<MediaTypeDetail>;
  /**
   * Folds `sourceId` into `targetId`: re-points listings, market data and
   * factors, then marks the source MERGED rather than deleting it, so existing
   * references still resolve.
   */
  mergeMediaTypes(sourceId: string, targetId: string): Promise<MediaType>;

  listSizeClasses(includeInactive?: boolean): Promise<SizeClass[]>;
  /**
   * The class a width and a height belong to, creating one when nothing is near.
   *
   * DR 02 measures a spot rather than asking a publisher to pick a class, so the
   * class has to be derived. Same shape as media-type matching, and now for the
   * same reason as well: the taxonomy grows from what is actually listed, and
   * near-misses are absorbed rather than allowed to fragment it.
   *
   * `tolerancePct` is a fraction of each dimension. Exact matching was the first
   * cut and it was too sharp — the industry builds to standard sizes, so 20 x
   * 10.5 is a 20 x 10 somebody measured with a tape, and minting a class for it
   * puts an identical spot in a pool of one.
   */
  resolveSizeClassForDimensions(
    widthFt: string,
    heightFt: string,
    tolerancePct: string
  ): Promise<SizeClass>;

  /* Venues — the level between a category and a spot type. */
  listVenueTypes(includeInactive?: boolean): Promise<VenueType[]>;
  findVenueType(id: string): Promise<VenueType | null>;
  /**
   * A venue by slug.
   *
   * `includeInactive` separates two different questions that share a lookup.
   * Resolving a slug on the listing path wants active rows only, or a venue ops
   * retired would keep quietly accepting new spots. Checking whether a slug is
   * free before creating one wants *every* row, because the column is unique —
   * asking the active-only question there turned re-adding a retired venue into
   * a P2002 rendered as a 500 instead of the 409 the handler was written for.
   */
  findVenueTypeBySlug(slug: string, includeInactive?: boolean): Promise<VenueType | null>;
  createVenueType(data: {
    name: string;
    slug: string;
    category: ListingCategory;
    description: string | null;
    subVenues?: string[];
  }): Promise<VenueType>;
  updateVenueType(
    id: string,
    patch: {
      name?: string;
      category?: ListingCategory;
      description?: string | null;
      subVenues?: string[];
      isActive?: boolean;
    }
  ): Promise<VenueType>;
  findSizeClass(id: string): Promise<SizeClass | null>;
  createSizeClass(data: NewSizeClass): Promise<SizeClass>;
  updateSizeClass(id: string, patch: Partial<NewSizeClass> & { isActive?: boolean }): Promise<SizeClass>;
  /** Active classes only — a deactivated one must not resolve on any path. */
  findSizeClassBySlug(slug: string): Promise<SizeClass | null>;
  listMaterials(includeInactive?: boolean): Promise<Material[]>;
  findMaterial(id: string): Promise<Material | null>;
  createMaterial(data: { name: string; slug: string }): Promise<Material>;
  updateMaterial(id: string, patch: { name?: string; isActive?: boolean }): Promise<Material>;

  /**
   * Every active city with its aliases, for resolving free-text names.
   *
   * Returned whole rather than queried per name: the list is small, and a bulk
   * import resolving five hundred rows would otherwise be five hundred round
   * trips to answer a dozen distinct questions.
   */
  listCities(): Promise<{ id: string; slug: string; name: string; aliases: string[] }[]>;
  /**
   * Every city, retired ones included, for the ops screen and for the
   * question `listCities` cannot answer: is this name unknown, or switched
   * off? The two get different answers at a listing form.
   */
  listAllCities(): Promise<CityRow[]>;
  findCity(slug: string): Promise<CityRow | null>;
  /** Lot X-B: the row behind a key a party row carries. */
  findCityById(id: string): Promise<CityRow | null>;
  /**
   * Lot V: the rows one typed name may denote — by slug, by a stored alias
   * (both already slugified) or by the display name, case-insensitively.
   * Several rows come back for a name India has many of (Rampur); the
   * service picks. Asked per gated write instead of `listAllCities`, which
   * is six and a half thousand rows since the catalogue covers the country.
   */
  findCitiesBySpelling(spelling: string, rawName: string): Promise<CityRow[]>;
  updateCity(slug: string, patch: { isActive?: boolean; aliases?: string[] }): Promise<CityRow>;

  /* ── Lot X-B: the city key on the party tables ─────────────────── */
  /**
   * Stamps `cityId` on every row of `table` whose key is null and whose
   * free-text city is one of `spellings` (case-insensitive). Answers how
   * many rows folded. The alias edit and the backfill both run on this.
   */
  foldCityKey(table: CityKeyedTable, cityId: string, spellings: string[]): Promise<number>;
  /**
   * The distinct typed city strings with no key, per table, with how many
   * rows carry each — what ops fold in by adding an alias or a manual city.
   */
  listUnresolvedCityStrings(): Promise<UnresolvedCityString[]>;
  findMaterialBySlug(slug: string): Promise<Material | null>;

  /** Unrecognised vocabulary values, counted rather than silently created. */
  recordVocabularyProposal(
    kind: VocabularyKind,
    rawValue: string,
    context: { listingId?: string | null; importId?: string | null }
  ): Promise<void>;
  listVocabularyProposals(resolved: boolean): Promise<
    { id: string; kind: VocabularyKind; rawValue: string; occurrences: number; createdAt: Date }[]
  >;
  findVocabularyProposal(id: string): Promise<{ id: string } | null>;
  resolveVocabularyProposal(id: string, resolvedTo: string | null, userId: string): Promise<void>;

  /* The match log — how taxonomy drift gets noticed. */
  logMediaTypeMatch(entry: {
    proposedName: string;
    attributes: Record<string, unknown>;
    mediaTypeId: string | null;
    similarity: number | null;
    outcome: MediaTypeMatchOutcome;
    listingId: string | null;
  }): Promise<void>;
  listMediaTypeMatchLogs(limit: number): Promise<
    {
      id: string;
      proposedName: string;
      mediaTypeId: string | null;
      similarity: string | null;
      outcome: MediaTypeMatchOutcome;
      createdAt: Date;
    }[]
  >;

  /* Comparables. */
  listingComparables(query: ComparableQuery): Promise<Comparable[]>;
  marketDataComparables(query: ComparableQuery): Promise<Comparable[]>;

  /* Market data import. */
  createImport(data: {
    source: MarketDataSource;
    filename: string | null;
    note: string | null;
    uploadedById: string | null;
  }): Promise<{ id: string }>;
  insertMarketDataPoints(points: NewMarketDataPoint[]): Promise<number>;
  finishImport(
    importId: string,
    counts: { rowCount: number; acceptedCount: number; rejectedCount: number },
    rejections: unknown
  ): Promise<void>;
  deactivateImport(importId: string): Promise<number>;

  /* Factors. */
  listFactors(mediaTypeId?: string): Promise<PricingFactor[]>;
  findFactor(id: string): Promise<PricingFactor | null>;
  /** How many listings have this factor applied. Zero means it is safe to delete. */
  countFactorApplications(id: string): Promise<number>;
  deleteFactor(id: string): Promise<void>;
  createFactor(data: {
    name: string;
    slug: string;
    description: string | null;
    kind: PricingFactorKind;
    mediaTypeId: string;
    multiplier: string | null;
    baseAdjust: string | null;
    suggestWhen: unknown;
    /** Lot E (Q125). Defaults to ADVISORY, which is what every factor was before. */
    mode?: PricingFactorMode;
    bindingDuringSurgeOnly?: boolean;
  }): Promise<PricingFactor>;
  updateFactor(id: string, patch: Record<string, unknown>): Promise<PricingFactor>;
  listingFactorApplications(listingId: string): Promise<FactorApplication[]>;
  setFactorSuggestions(listingId: string, factorIds: string[]): Promise<void>;
  /** `appliedRatePerDay` is the rate a BINDING apply wrote; null for an advisory decision. */
  setFactorApplied(
    listingId: string,
    factorId: string,
    applied: boolean,
    userId: string,
    appliedRatePerDay: Money | null
  ): Promise<void>;

  /* Surge. */
  activeSurgeWindows(at: Date): Promise<SurgeEvent[]>;
  findSurgeWindow(id: string): Promise<SurgeEvent | null>;
  listSurgeWindows(filter: { includeDisabled: boolean; from?: Date; to?: Date }): Promise<SurgeEvent[]>;
  upsertSurgeWindow(data: NewSurgeEvent): Promise<SurgeEvent>;
  setSurgeEnabled(id: string, enabled: boolean, userId: string, note: string | null): Promise<SurgeEvent>;

  /* Scraper sources — where the surge calendar comes from. */
  listScraperSources(): Promise<ScraperSource[]>;
  findScraperSource(id: string): Promise<ScraperSource | null>;
  createScraperSource(data: NewScraperSource): Promise<ScraperSource>;
  updateScraperSource(id: string, patch: Record<string, unknown>): Promise<ScraperSource>;
  setScraperSourceEnabled(
    id: string,
    enabled: boolean,
    userId: string,
    note: string | null
  ): Promise<ScraperSource>;
  listScraperRuns(sourceId: string, limit: number): Promise<ScraperRun[]>;
  /** Opens a run row before the work starts, so a crash leaves a trace. */
  startScraperRun(sourceId: string): Promise<ScraperRun>;
  finishScraperRun(
    runId: string,
    sourceId: string,
    outcome: {
      status: ScraperRunStatus;
      message: string | null;
      found: number;
      windowsUpserted: number;
    }
  ): Promise<void>;
  findSurgeWindowByRef(source: string, externalRef: string): Promise<SurgeEvent | null>;
  /**
   * Switches off a window the scraper just created.
   *
   * Separate from `setSurgeEnabled` because that one records *who* disabled it,
   * and this is not a person deciding — it is a new window from a source that
   * has not earned the right to publish live ones yet.
   */
  setScraperCreatedWindowDisabled(id: string): Promise<void>;

  /* Listings. */
  listingContext(listingId: string): Promise<ListingPricingContext | null>;
  /** The login behind a publisher, so a reprice can tell them. Null when the record has none. */
  publisherUserId(publisherId: string): Promise<string | null>;
}
