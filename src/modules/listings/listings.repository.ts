import type {
  ContentCategory,
  ContentStance,
  Listing,
  ListingCategory,
  ListingDocumentKind,
  ListingDocumentStatus,
  ListingPhoto,
  ListingStatus,
  PricingUnit,
} from '../../shared/database';
import type { AdminListingsQuery, ReviewQueueQuery } from './listings.schema';
import type { SlotHoldOptions, SlotWindow } from './slot-holds';

/** A listing's position on one content category. */
export type ContentRule = { contentCategoryId: string; stance: ContentStance };

/** One listing as the admin detail page reads it; G11-1: the media type it was filed under rides the same read. */
export type AdminListingDetail = Listing & {
  publisher: { id: string; name: string; displayId: string | null; city: string | null } | null;
  agent: { id: string; displayId: string | null } | null;
  photos: ListingPhoto[];
  mediaType: { name: string; formatGroup: string | null } | null;
};

/** One page of the DR 10 admin table. */
export type AdminListingsPage = {
  items: Listing[];
  total: number;
  counts: Record<string, number>;
};

/**
 * What DR 02 records about a spot beyond its price and its address.
 *
 * Shared between a create and a patch: every one of these is a claim a
 * publisher can get wrong, and several of them decide which market the listing
 * is compared against, so none of them may be write-once.
 */
export type SpotAttributes = {
  /** Step 2. Part of the comparable match key. */
  venueTypeId: string;
  /** Step 4 — where in the venue, and how big. Area is derived from the pair. */
  placement: string;
  widthFt: string;
  heightFt: string;
  areaSqFt: string;
  /** Step 5 — the selling story. */
  targetAudience: string;
  uniqueSellingPoint: string;
  footfallNote: string;
  /** Physical attributes a pricing factor can key on. */
  illumination: string;
  facing: string;
  elevation: string;
  visibility: string;
  trafficGrade: string;
  /** Step 7 — the publisher's own unit and figure. `ratePerDay` is derived. */
  pricingUnit: PricingUnit;
  basePrice: string;
  minBookingDays: number;
  availableFrom: Date;
  availableHoursFrom: string;
  availableHoursTo: string;
  peakPeriodNote: string;
  rateCardUrl: string;
};

export type NewListing = Partial<SpotAttributes> & {
  publisherId: string;
  /** QR-8: the reference (`LST-DDMM-YYNN`), minted by the service at creation or carried over from a draft. */
  displayId?: string;
  /**
   * The agent who keyed this in, when one did.
   *
   * Null on a self-serve listing. DR 02 draws two variants of the same seven
   * steps — a publisher on their own phone, and an agent sitting with them —
   * and the difference between the two is exactly this field.
   */
  agentId?: string;
  title: string;
  category: ListingCategory;
  subType?: string;
  description?: string;
  address: string;
  city?: string;
  /** Lot X-B: the `City` row `city` denotes, stamped by the service through `pricing.withCityKey`; null for a typed town. */
  cityId?: string | null;
  latitude?: number;
  longitude?: number;
  size?: string;
  /** Canonical. The repository derives `monthlyPrice` from it. */
  ratePerDay: string;
  pricingModel?: string;
  sizeClassId?: string;
  materialId?: string;
  mediaTypeId?: string;
  /**
   * When the surge window in force as this rate was set ends. Such a rate is
   * not a baseline and stays out of everyone else's pool until then.
   */
  ratePerDaySurgeUntil?: Date | null;
  /** Preserved verbatim when the caller sent the deprecated monthly shape. */
  monthlyPrice?: number;
  availableNow?: boolean;
  /** Lot D (Q105): the publisher's opt-in to automatic acceptance. Gated in the service. */
  instantBooking?: boolean;
  /** Lot G (Q116/136): the loop — how many advertisers at once, 1..24. Gated in the service; see `slots.service`. */
  slotsTotal?: number;
  photos?: { url: string; type: string }[];
  planId?: string;
};

export type ListingPatch = Partial<SpotAttributes> & Partial<{
  title: string;
  /** Lot X-B: a corrected city; the service stamps `cityId` beside it. */
  city: string;
  cityId: string | null;
  /** Lot G: patchable, because it is half the evidence the loop rule reads. */
  subType: string;
  description: string;
  ratePerDay: string;
  availableNow: boolean;
  instantBooking: boolean;
  /** Lot G (Q116/136): see `NewListing.slotsTotal`. */
  slotsTotal: number;
  status: ListingStatus;
  ratePerDaySurgeUntil: Date | null;
  monthlyPrice: number;
  /** Classification is patchable so listings predating the engine can join it. */
  category: ListingCategory;
  mediaTypeId: string;
  sizeClassId: string;
  materialId: string;
}>;

/**
 * The joins the orders module needs when placing and progressing an order.
 * The three address fields are Lot D's (Q105): an instant booking is accepted
 * at placement, so the meeting place has to be readable there.
 */
export type ListingWithPublisher = Listing & {
  publisher: {
    id: string;
    userId: string | null;
    agentId: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
  } | null;
};

/* ── Browse — DR 01's advertiser discovery ─────────────────────────
 *
 * What an advertiser may search: ACTIVE listings only, by the facets the
 * filter drawer draws (4189:2440). Nothing here reaches the publisher's
 * contact details — a browse card names the spot, not the person.
 */
/** `RATING` (Lot D, Q104): best-rated first, the unrated last. */
export type BrowseSort = 'NEWEST' | 'PRICE_ASC' | 'PRICE_DESC' | 'NAME' | 'RATING';

export type BrowseFilter = {
  /** Free text against the title, address and city. */
  q?: string;
  city?: string;
  /**
   * Lot X-L: the key the typed `city` resolved to (`browse.service` stamps
   * it through `pricing.cityKeyFor`). Browse stays on the spelling by design
   * — a shopper types — but when the typed value resolves, rows keyed to it
   * match too, so 'Bangalore' finds the Bengaluru spots. Null when nothing
   * resolved: the spelling alone, as before.
   */
  cityId?: string | null;
  category?: 'INDOOR' | 'OUTDOOR' | 'TRANSIT' | 'MEDIA';
  /** QR-20: the sub-category — one `VenueType`. */
  venueTypeId?: string;
  /** DIGITAL matches a sub-type naming a screen; STATIC is everything else. */
  display?: 'DIGITAL' | 'STATIC';
  minRate?: string;
  maxRate?: string;
  /** The campaign's dates: a spot must be available from the start. */
  from?: Date;
  /** E7-2: … and not booked out before the end — see `findActive`. */
  to?: Date;
  /** Daily footfall floor — the drawer's 25K+ / 50K+ / 1L+. */
  minFootfall?: number;
  illuminated?: boolean;
  /** A bounding box around a point; the service sorts by exact distance. */
  near?: { latitude: number; longitude: number; radiusKm: number };
  /** Lot D (Q105): only spots that accept a booking without the publisher's tap. */
  instant?: boolean;
  sort: BrowseSort;
};

export type BrowseListing = Listing & {
  photos: { url: string; type: string }[];
  /** QR-5: `kycStatus` rides along for the verified mark and the ranking; QR-7: the person's picture. */
  publisher: { name: string | null; kycStatus?: string | null; user?: { avatarUrl: string | null } | null } | null;
  /**
   * G12-B: the media type the spot was filed under — the second half of the
   * evidence `slots.service.carriesLoop` reads for the card's `display`.
   * Optional so a row read without the join still makes a card (a static
   * wall unless the sub-type says otherwise).
   */
  mediaType?: { name: string; formatGroup?: string | null } | null;
};

/** G12-B: where a browse looks — the same two facets `findActive` resolves a place by. */
export type BrowsePlace = Pick<BrowseFilter, 'city' | 'cityId' | 'near'>;

/** G12-B: one live spot as the category grid counts it — the category, the point, when it went live, its photographs. */
export type CategoryTileListing = {
  id: string;
  category: ListingCategory;
  /** QR-20: the venue the spot lives in, for the sub-category tiles; null on a spot listed before venues. */
  venueTypeId: string | null;
  latitude: number | null;
  longitude: number | null;
  publishedAt: Date | null;
  photos: { url: string; type: string }[];
};

/** QR-20: one venue type of the catalogue — the sub-categories the home strip and the Explore grid draw. */
export type VenueTypeRow = { id: string; name: string; slug: string; category: ListingCategory };

/** E11-2: the public spot page's row — the browse row plus the media type it prints. */
export type SpotPageListing = BrowseListing & {
  mediaType: { name: string } | null;
};

/* ── The review desk — DR 10 ──────────────────────────────────────
 *
 * A per-listing document as the reviewer reads it. Owned and written by
 * `supply`; this module only ever reads them alongside the listing they hang
 * on, because a desk review is one person looking at the spot, its photographs
 * and its paperwork on one screen. */
export type ReviewDocument = {
  id: string;
  kind: ListingDocumentKind;
  url: string;
  status: ListingDocumentStatus;
  rejectionReason: string | null;
  submittedAt: Date;
  reviewedAt: Date | null;
};

/** One row of the queue: the listing with everything a reviewer scans first. */
export type ReviewQueueListing = Listing & {
  publisher: {
    id: string;
    name: string;
    displayId: string | null;
    city: string | null;
    mobile: string;
  } | null;
  agent: { id: string; displayId: string | null; user: { name: string | null } } | null;
  photos: ListingPhoto[];
  documents: ReviewDocument[];
};

/** The full case: the queue row plus the vocabulary the spot was filed under. */
export type ReviewCaseListing = ReviewQueueListing & {
  mediaType: { id: string; name: string } | null;
  sizeClass: { id: string; name: string } | null;
  material: { id: string; name: string } | null;
  venueType: { id: string; name: string } | null;
  contentRules: { stance: ContentStance; category: { id: string; name: string } }[];
};

/**
 * Where a send-back leaves the listing.
 *
 * `DRAFT` is "fix this and send it again" — the publisher edits and resubmits,
 * and the reason travels with the row so both sides can see what was asked.
 * `REJECTED` is terminal. `ListingStatus` has no CHANGES_REQUESTED value; a
 * draft carrying a `rejectionReason` is that state, and nothing else writes
 * that combination.
 */
export type SendBackStatus = Extract<ListingStatus, 'DRAFT' | 'REJECTED'>;

/* ── Audience snapshots — G7 (Q109) ───────────────────────────────
 * One row per (listing, vendor, period): the vendor's answer for the
 * catchment, kept until a week past the end of the month it describes so a
 * vendor is asked once per spot per month however many screens open. The
 * payload is the seam's `AudienceCatchment`, stored as JSON as it came. */
export type AudienceSnapshotRow = {
  id: string;
  listingId: string;
  vendor: string;
  period: string;
  data: unknown;
  fetchedAt: Date;
  expiresAt: Date | null;
};

export interface ListingsRepository {
  create(data: NewListing): Promise<Listing>;
  findForPublisher(publisherId: string): Promise<Listing[]>;
  /**
   * The admin table's page: the rows, the total behind them, and a count per
   * status for the chip row. The histogram ignores the caller's own status
   * facet — see the implementation for why.
   */
  /** Lot X-B: `cityId` is the key `query.city` resolved to — rows match on it, or on the spelling for the rows whose key is null. */
  findAllForAdmin(query: AdminListingsQuery & { cityId?: string | null }): Promise<AdminListingsPage>;
  findById(listingId: string): Promise<Listing | null>;
  /** One listing with the joins the console's detail page draws. */
  findOneForAdmin(listingId: string): Promise<AdminListingDetail | null>;
  update(listingId: string, data: ListingPatch): Promise<Listing>;
  publish(listingId: string): Promise<Listing>;
  /* ── Sending a listing for review ───────────────────────────────
   *
   * Separate from `publish` because they are different acts by different
   * people: the publisher submits, ADX publishes. Submitting was the missing
   * half — a created listing sat at DRAFT for ever and inventory matching only
   * ever looks at ACTIVE, so supply and demand were never joined. */
  submitForReview(listingId: string, displayId: string | null, at: Date): Promise<Listing>;
  displayIdExists(displayId: string): Promise<boolean>;
  countAll(): Promise<number>;
  /**
   * Comparable active listings: same city and category, price within ±30%.
   * Lot X-L: "same city" is by the key when the listing carries one (a spot
   * typed 'Bangalore' compares with the Bengaluru ones), else the string.
   */
  findSimilar(listing: Listing): Promise<Listing[]>;
  agentExists(agentId: string): Promise<boolean>;
  /**
   * The publisher record behind a login, for a publisher listing their own spot.
   *
   * Here rather than borrowed from the `publishers` module because `publishers`
   * already imports this one — reaching the other way would close a cycle for
   * the sake of a two-column lookup.
   */
  /** The publisher behind a login; QR-3: with the basics the listing door checks. */
  findPublisherByUserId(
    userId: string,
  ): Promise<{ id: string; name: string; mobile: string; email: string | null; address: string | null; dateOfBirth: Date | null; activatedAt: Date | null } | null>;
  /** The publisher and the agent who onboarded them, for the create guard; QR-2: and their KYC state, for the publish gate. */
  findPublisherById(
    publisherId: string
  ): Promise<{ id: string; userId: string | null; agentId: string | null; kycStatus: string; name: string; mobile: string; email: string | null; address: string | null; dateOfBirth: Date | null } | null>;

  /* ── Content rules — DR 02 step 6 ─────────────────────────────────
   * The categories are a controlled list for the same reason media types are:
   * a publisher who types "no alcohol" and one who types "No Alcohol" have said
   * the same thing, and nothing downstream could ever match them. */
  listContentCategories(): Promise<ContentCategory[]>;
  /** Replaces the whole set for a listing, in one transaction. */
  setContentRules(listingId: string, rules: ContentRule[]): Promise<void>;
  contentRulesFor(listingId: string): Promise<ContentRule[]>;
  /** Listing joined to its publisher and that publisher's user, for orders. */
  findWithPublisher(listingId: string): Promise<ListingWithPublisher | null>;
  /* ── Slots — Lot G (Q116/136) ─────────────────────────────────────
   * The rule — which order holds a slot, which reservation does — is
   * `slots.service`'s; the repository only counts. */
  /** The words the loop decision reads off a media type: its name and the catalogue heading it sits under. Null for no such type. */
  mediaTypeLoopHint(mediaTypeId: string): Promise<{ name: string; formatGroup: string | null } | null>;
  /**
   * Slots held per listing over the window: the slot-holding orders
   * overlapping it plus the live campaign reservations on it — G10: each
   * holding its quantity (the campaign spot behind an order, one when there
   * is none), summed. A listing with nothing on it is absent from the map.
   * `excludeCampaignId` keeps a campaign's own reservations out of its own
   * answer, the way checkout's clash check always has.
   */
  slotsHeld(listingIds: string[], window: SlotWindow, options?: SlotHoldOptions): Promise<Map<string, number>>;
  /** DR 01 browse: ACTIVE listings matching the drawer's facets, a page at a time. */
  findActive(filter: BrowseFilter, page: number, pageSize: number): Promise<{ items: BrowseListing[]; total: number }>;
  /** One ACTIVE listing with its photographs; null when it is not live. */
  findActiveById(listingId: string): Promise<BrowseListing | null>;
  /**
   * G12-B: every ACTIVE spot in the place, newest published first, with only
   * what the category grid needs. The place clause is the one `findActive`
   * uses (a city by name, a bounding box around a point); the service cuts
   * the box to the circle, the way browse does.
   */
  findActiveForCategories(place: BrowsePlace): Promise<CategoryTileListing[]>;
  /** QR-20: every active venue type, the catalogue's sub-categories. */
  venueTypes(): Promise<VenueTypeRow[]>;
  /** E11-2: the public spot page — one ACTIVE listing by its display id, with its media type; null otherwise. */
  findActiveByDisplayId(displayId: string): Promise<SpotPageListing | null>;
  setAvailability(listingId: string, availableNow: boolean): Promise<unknown>;

  /* ── Saved spaces — Lot D (Q5/Q104) ─────────────────────────────────
   * Per advertiser account, never per person: an agent under a grant saves
   * into the advertiser's book. The card's `saved` mark is resolved for a
   * whole page in one IN query, never one lookup per row. */
  /** Of these listing ids, the ones this advertiser has saved. */
  savedListingIds(advertiserId: string, listingIds: string[]): Promise<string[]>;
  /** Idempotent: a second save of the same spot is the same row. */
  saveListing(advertiserId: string, listingId: string): Promise<void>;
  /** Idempotent: unsaving what was never saved is not an error. */
  unsaveListing(advertiserId: string, listingId: string): Promise<void>;
  /** The advertiser's saved spots that are still live, newest save first. */
  findSavedForAdvertiser(advertiserId: string, page: number, pageSize: number): Promise<{ items: BrowseListing[]; total: number }>;

  /**
   * Lot D (Q104): `reviews` recomputed this spot's stars and hands the
   * aggregate here — denormalised so browse needs no join. A decimal string
   * with two places, or null while nobody has reviewed it.
   */
  setRatingSnapshot(listingId: string, snapshot: { ratingAvg: string | null; reviewCount: number }): Promise<void>;
  /**
   * Lot D (Q105): where an agent would be sent for this publisher's spots —
   * the same three fields the accept screen falls back through. Null when
   * there is no such publisher.
   */
  publisherMeetingPlace(publisherId: string): Promise<{ address: string | null; city: string | null; state: string | null } | null>;
  /**
   * Lot A (Q21): the spots of a closing publisher go INACTIVE and off the
   * market. Never deleted — an order that ran on one still points at it, and
   * a retired listing is how the history stays readable.
   */
  retireForPublisher(publisherId: string): Promise<{ id: string }[]>;

  /* ── The review desk ───────────────────────────────────────────────
   * Oldest submission first: the queue is a promise of "within 24 hours",
   * so the listing that has waited longest is the one at the top. */
  findPendingReview(query: ReviewQueueQuery): Promise<{ items: ReviewQueueListing[]; total: number }>;
  findReviewCase(listingId: string): Promise<ReviewCaseListing | null>;
  /**
   * Records the reviewer's reason on the row and moves it. A draft loses its
   * `submittedAt` so the SLA clock starts afresh when it comes back.
   */
  sendBack(listingId: string, input: { status: SendBackStatus; reason: string }): Promise<Listing>;

  /* ── Audience — G7 (Q109) ───────────────────────────────────────── */
  findAudienceSnapshot(listingId: string, vendor: string, period: string): Promise<AudienceSnapshotRow | null>;
  /** Y-B: every vendor's row for these listings (or synthetic `city:<slug>:<n>` keys) in the period, expired or not — the city profile folds what is there. */
  findAudienceSnapshots(listingIds: string[], period: string): Promise<AudienceSnapshotRow[]>;
  /** Idempotent on (listing, vendor, period): a refetch after expiry replaces the row. */
  upsertAudienceSnapshot(input: { listingId: string; vendor: string; period: string; data: unknown; expiresAt: Date }): Promise<AudienceSnapshotRow>;
  /**
   * Whether this advertiser has the spot in any campaign of theirs that is
   * not a draft — the advertiser's claim to the spot's audience. Read here,
   * on the campaign tables, because `campaigns` imports this module and
   * reaching back would close a cycle (the same reason `findPublisherByUserId`
   * is here).
   */
  advertiserHasSpot(advertiserId: string, listingId: string): Promise<boolean>;
  /** K-B1: `{ id, label, displayId }` per id in one query — the QR desk names the code's subject with it. */
  findLabelsByIds(ids: string[]): Promise<{ id: string; label: string; displayId: string | null }[]>;
}
