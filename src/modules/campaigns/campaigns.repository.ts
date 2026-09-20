import type { KycStatus, Prisma } from '../../shared/database';

/** G10: what a clash check asks per listing — a bare id wants one slot. */
export type SlotAsk = string | { listingId: string; quantity: number };

/**
 * G10: thrown by `holdReservations` when, under the listing lock, a spot no
 * longer fits — the slots went to another booking between the review and
 * the hold. The service turns it into the same 409 the review's clash list
 * gives. A plain Error, so the repository stays free of HTTP.
 */
export class SlotClashError extends Error {
  constructor(public readonly listingIds: string[]) {
    super('NO_SLOT_LEFT');
    this.name = 'SlotClashError';
  }
}
import type {
  AudiencePersona,
  BrandAwarenessLevel,
  Campaign,
  CampaignCreative,
  CampaignRefund,
  CampaignRefundStatus,
  CampaignDailyMetric,
  CampaignGoal,
  CampaignPoi,
  CampaignSpot,
  CampaignSpotStatus,
  CampaignStatus,
  CampaignStrategy,
  CampaignTrackingCode,
  CampaignTriggerType,
  CreativePath,
  CreativeStatus,
  FulfilmentChoice,
  LandingPage,
  LandingPageStatus,
  TargetingMethod,
  TrackingEventType,
  TrackingMethod,
} from '../../shared/database';

/**
 * What the campaigns module needs from storage, stated as a port.
 *
 * The service layer never sees Prisma. That is the rule the architecture test
 * enforces, and it earns its keep here: the matching query is the only place in
 * the platform that reads listings by bounding box *and* by publisher status,
 * and keeping it behind an interface means the service can be tested against
 * ten listings in memory rather than a database full of them.
 */

export type CampaignRow = Campaign;
export type SpotRow = CampaignSpot;

/**
 * Lot B (Q41): a campaign cancelled after its money was captured. The credit
 * back to the advertiser waits for finance — the disputes pattern.
 */
export type CampaignRefundRow = CampaignRefund;
/** What the desk shows beside the refund: the campaign it is for, and (E10-1) the advertiser through it. */
export type CampaignRefundView = CampaignRefundRow & {
  campaign: { id: string; reference: string; name: string; advertiserId: string; status: CampaignStatus } | null;
  advertiser: { id: string; displayId: string | null; name: string } | null;
};
export const CAMPAIGN_REFUND_STATUSES = ['PENDING', 'RELEASED', 'REJECTED'] as const;
/* ── Landing pages — Lot E (Q7/Q106) ──────────────────────────────── */
export type LandingPageRow = LandingPage;
export type LandingPageSummaryRow = Pick<LandingPage, 'id' | 'slug' | 'status' | 'publishedAt'>;
export const LANDING_PAGE_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
/** The review list's row: the page beside the campaign it belongs to. */
export type LandingPageView = LandingPageRow & {
  campaign: {
    id: string;
    reference: string;
    name: string;
    status: CampaignStatus;
    advertiserId: string;
    advertiser: { id: string; name: string; companyName: string | null };
  } | null;
};
export type LandingPagePatch = Partial<{
  blocks: Prisma.InputJsonValue;
  theme: Prisma.InputJsonValue | null;
  status: LandingPageStatus;
  publishedAt: Date | null;
  generatedByAi: boolean;
  version: number;
}>;

export type CampaignRefundPatch = Partial<{
  status: CampaignRefundStatus;
  reason: string;
  releasedByUserId: string | null;
  releasedAt: Date | null;
  ledgerTransactionId: string | null;
}>;
export type PoiRow = CampaignPoi;
export type CreativeRow = CampaignCreative;

/** A creative the desk reads: the artwork with the little it needs of its campaign and spot. */
export type CreativeReviewRow = CampaignCreative & {
  campaign: {
    id: string;
    reference: string;
    name: string;
    status: CampaignStatus;
    advertiserId: string;
    agentId: string | null;
    createdByUserId: string;
    trackingMethod: TrackingMethod;
    contentCategoryId: string | null;
    advertiser: { id: string; name: string; companyName: string | null };
  };
  spot: {
    id: string;
    listingId: string;
    listing: { id: string; title: string; city: string | null; widthFt: Prisma.Decimal | null; heightFt: Prisma.Decimal | null };
  } | null;
};

export type NewCreative = {
  campaignId: string;
  spotId: string | null;
  path: CreativePath;
  status: CreativeStatus;
  fileUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  widthPx: number | null;
  heightPx: number | null;
  durationMs: number | null;
  /** Lot D (Q44/Q120): the moderation columns, written at submit. */
  submittedAt: Date | null;
  flags: string[];
  checks: Prisma.InputJsonValue | null;
  resubmissionOfId: string | null;
  designedByAdx: boolean;
  trackingCodeId: string | null;
};

export type CreativePatch = Partial<{
  status: CreativeStatus;
  reviewNote: string | null;
  reviewedById: string | null;
  reviewedAt: Date | null;
  flags: string[];
  checks: Prisma.InputJsonValue | null;
  advertiserAcceptedAt: Date | null;
  advertiserAcceptedById: string | null;
  submittedAt: Date | null;
  trackingCodeId: string | null;
}>;
export type TrackingCodeRow = CampaignTrackingCode;
export type MetricRow = CampaignDailyMetric;

/** A campaign with everything the detail screen and the checkout need. */
export type CampaignAggregate = Campaign & {
  spots: (CampaignSpot & {
    listing: {
      id: string;
      title: string;
      city: string | null;
      address: string;
      latitude: number | null;
      longitude: number | null;
      widthFt: Prisma.Decimal | null;
      heightFt: Prisma.Decimal | null;
      estimatedDailyFootfall: number | null;
      mediaType: { id: string; name: string; category: string } | null;
      photos: { url: string }[];
    };
  })[];
  pois: CampaignPoi[];
  creatives: CampaignCreative[];
  codes: CampaignTrackingCode[];
  advertiser: { id: string; name: string; companyName: string | null };
  brand: { id: string; name: string } | null;
};

/** A row in the campaign list — enough for a card, not the whole brief. */
export type CampaignListRow = {
  id: string;
  reference: string;
  name: string;
  status: CampaignStatus;
  goal: CampaignGoal | null;
  brandName: string | null;
  city: string | null;
  budget: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
  startDate: Date | null;
  endDate: Date | null;
  spotCount: number;
  /** Booked spots' daily rate over the days run, as Decimal; the list prints it as money. */
  spendToDate: Prisma.Decimal;
  /** Lot B: whose campaign it is, for the agent app's Orders tab — on every caller's rows. */
  advertiser: { id: string; displayId: string | null; name: string };
  createdAt: Date;
  updatedAt: Date;
};

/** A listing the matcher may offer, with everything the score is built from. */
export type CandidateListing = {
  id: string;
  title: string;
  city: string | null;
  address: string;
  latitude: number | null;
  longitude: number | null;
  ratePerDay: Prisma.Decimal | null;
  widthFt: Prisma.Decimal | null;
  heightFt: Prisma.Decimal | null;
  areaSqFt: Prisma.Decimal | null;
  illumination: string | null;
  estimatedDailyFootfall: number | null;
  minBookingDays: number | null;
  availableNow: boolean;
  mediaType: { id: string; name: string; category: string } | null;
  venueType: { id: string; name: string } | null;
  photos: { url: string }[];
};

export type CampaignPatch = Partial<{
  name: string;
  step: number;
  brandId: string | null;
  brandName: string | null;
  productName: string | null;
  industry: string | null;
  subCategory: string | null;
  goal: CampaignGoal | null;
  awareness: BrandAwarenessLevel | null;
  targetingMethod: TargetingMethod | null;
  targetLocation: string | null;
  targetLatitude: number | null;
  targetLongitude: number | null;
  targetRadiusKm: number | null;
  targetMarket: string | null;
  /** Lot X-B: the `City` row `targetMarket` denotes, stamped by the service through `pricing.cityKeyFor`; null for a typed town. */
  targetMarketCityId: string | null;
  /** Lot D (Q107): the whole list; `targetMarket` is kept as its first entry. */
  targetMarkets: string[];
  strategy: CampaignStrategy | null;
  persona: AudiencePersona | null;
  triggerType: CampaignTriggerType;
  triggerConfig: Prisma.InputJsonValue | null;
  budget: Prisma.Decimal | null;
  startDate: Date | null;
  endDate: Date | null;
  creativePath: CreativePath | null;
  creativeConfig: Prisma.InputJsonValue | null;
  trackingMethod: TrackingMethod;
  trackingConfig: Prisma.InputJsonValue | null;
  fulfilment: FulfilmentChoice | null;
  status: CampaignStatus;
  spotsSubtotal: Prisma.Decimal | null;
  feesTotal: Prisma.Decimal | null;
  discount: Prisma.Decimal | null;
  gstAmount: Prisma.Decimal | null;
  total: Prisma.Decimal | null;
  walletHoldId: string | null;
  reference: string;
  paidAt: Date | null;
  launchedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  /** Lot B (Q1): the field visit the campaign was made on, and the assist recorded at authorisation. */
  visitId: string | null;
  assistIncentiveId: string | null;
  /** Lot D (Q138): what the creative advertises — the venue-stance check reads it. */
  contentCategoryId: string | null;
  /** Lot C (Q88): ops prepared it and sent it to the advertiser to pay. */
  submittedForPaymentAt: Date | null;
  submittedByUserId: string | null;
}>;

export type NewSpot = {
  campaignId: string;
  listingId: string;
  matchScore: number | null;
  ratePerDay: Prisma.Decimal;
  days: number;
  quantity: number;
  lineTotal: Prisma.Decimal;
  startDate: Date | null;
  endDate: Date | null;
};

export type CandidateQuery = {
  /** Bounding box, when the campaign targets a radius or a set of pins. */
  box?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  /** City or market name, when it targets one. */
  city?: string;
  /** Lot D (Q107): several markets — city IN, case-insensitively. */
  cities?: string[];
  /** Spots already in the cart, so the matcher never offers them twice. */
  excludeListingIds: string[];
  limit: number;
};

export interface CampaignsRepository {
  createCampaign(data: {
    advertiserId: string;
    brandId: string | null;
    agentId: string | null;
    visitId: string | null;
    createdByUserId: string;
    name: string;
    reference: string;
  }): Promise<CampaignRow>;
  findCampaign(id: string): Promise<CampaignAggregate | null>;
  findCampaignBare(id: string): Promise<CampaignRow | null>;
  /** One page of the list, with the total and a count per status chip. */
  listCampaignsPage(filter: {
    advertiserId?: string;
    agentId?: string;
    status?: CampaignStatus[];
    q?: string;
    sort: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: CampaignListRow[]; total: number; counts: Record<string, number> }>;
  listCampaigns(filter: {
    advertiserId?: string;
    agentId?: string;
    status?: CampaignStatus[];
    search?: string;
    limit: number;
  }): Promise<CampaignListRow[]>;
  updateCampaign(id: string, patch: CampaignPatch): Promise<CampaignRow>;
  deleteCampaign(id: string): Promise<void>;
  referenceExists(reference: string): Promise<boolean>;

  replacePois(campaignId: string, pois: { label: string; address: string | null; latitude: number | null; longitude: number | null }[]): Promise<PoiRow[]>;

  /** The cart is written whole, because it is edited whole. */
  replaceSpots(campaignId: string, spots: NewSpot[]): Promise<SpotRow[]>;
  findSpots(campaignId: string): Promise<SpotRow[]>;
  /**
   * The spots behind a set of orders, with their campaign's flight and owner.
   * Lot A's STOP_OPEN_WORK cancels orders on a suspended spot and has to give
   * the unused days back to whoever paid for them.
   */
  findSpotsByOrderIds(
    orderIds: string[],
  ): Promise<
    (SpotRow & {
      campaign: { id: string; reference: string; advertiserId: string; status: CampaignStatus; startDate: Date | null; endDate: Date | null; walletHoldId: string | null };
    })[]
  >;
  updateSpot(
    id: string,
    patch: Partial<{
      status: CampaignSpotStatus;
      orderId: string | null;
      /** Lot B (Q38): written once, at authorisation, by checkout. */
      commissionPct: Prisma.Decimal | null;
      commissionSource: string | null;
      /** Lot C (Q88): the 24-hour hold a prepared campaign puts on its spots. */
      reservedUntil: Date | null;
    }>,
  ): Promise<SpotRow>;
  /**
   * Lot C (Q88): stamps `reservedUntil` on every RESERVED spot of a campaign
   * sent to the advertiser to pay, and clears the stamps that have lapsed —
   * the lifecycle job's sweep. Both answer how many rows they touched.
   *
   * G10: the hold is written inside one transaction that first takes the
   * per-listing advisory lock placement takes — one per distinct listing,
   * in id order — then counts the holds again under it, each spot's
   * `quantity` against its listing's `slotsTotal`, and throws
   * `SlotClashError` (nothing written) when a spot no longer fits.
   */
  holdReservations(campaignId: string, until: Date, now?: Date): Promise<number>;
  clearExpiredReservations(now: Date): Promise<number>;

  candidateListings(query: CandidateQuery): Promise<CandidateListing[]>;
  /**
   * Listing ids with too few slots left over the dates (Lot G, Q116/136):
   * the orders still running on each, plus (Lot C, Q88) the reservations
   * another campaign holds under a live `reservedUntil`, quantities summed
   * and counted against the listing's `slotsTotal` — a static wall at 1, a
   * screen's loop above it. G10: each ask carries how many slots it wants
   * (a bare id wants one, the way the matcher asks); a spot clashes when
   * `held + quantity > slotsTotal`. `excludeCampaignId` keeps a campaign's
   * own reservations out of its own answer.
   */
  clashingListingIds(asks: readonly SlotAsk[], from: Date, to: Date, options?: { excludeCampaignId?: string; now?: Date }): Promise<string[]>;

  /**
   * Lot D (Q44): a creative is a row per submission. A re-upload after a
   * refusal is a new row pointing at the one it replaces
   * (`resubmissionOfId`), never an edit of it, so the desk keeps what it
   * refused. The service decides which; the repository only writes.
   */
  createCreative(data: NewCreative): Promise<CreativeRow>;
  updateCreative(id: string, patch: CreativePatch): Promise<CreativeRow>;
  findCreative(id: string): Promise<CreativeReviewRow | null>;
  findCreatives(campaignId: string): Promise<CreativeRow[]>;
  deleteCreative(id: string): Promise<void>;
  /** The desk's queue, on the list contract. E7-2: `counts` carries `flagged`, `static`, `video`, `resubmitted` beside the status histogram. */
  listCreativesPage(filter: {
    status?: CreativeStatus[];
    kind?: CreativePath;
    flagged?: boolean;
    resubmitted?: boolean;
    q?: string;
    sort: string;
    page: number;
    pageSize: number;
  }): Promise<{ items: CreativeReviewRow[]; total: number; counts: Record<string, number> }>;

  createTrackingCodes(
    rows: {
      campaignId: string;
      spotId: string | null;
      code: string;
      method: TrackingMethod;
      destination: string | null;
      vanityPath: string | null;
      promoCode: string | null;
    }[]
  ): Promise<TrackingCodeRow[]>;
  findTrackingCode(code: string): Promise<(TrackingCodeRow & { campaign: { id: string; status: CampaignStatus } }) | null>;
  codeExists(code: string): Promise<boolean>;
  /** QR-1: records the engine's hold on each code — its id and the URL the hoarding carries. */
  linkTrackingCodesToEngine(rows: { id: string; engineCodeId: string; shortUrl: string }[], at: Date): Promise<void>;
  recordTrackingEvent(data: {
    codeId: string;
    type: TrackingEventType;
    city: string | null;
    device: string | null;
    referer: string | null;
    /** Lot D (Q7): the IST hour and the CTA pressed, for the interactions breakdown. */
    hourIst?: number | null;
    ctaLabel?: string | null;
  }): Promise<void>;
  /**
   * Lot D (Q7): the landing-page interactions folded four ways. Every row is
   * a TrackingEvent ADX recorded itself, so the breakdown is MEASURED.
   */
  interactionTotals(campaignId: string): Promise<{
    byDevice: { device: string | null; count: number }[];
    byHour: { hourIst: number | null; count: number }[];
    byCity: { city: string | null; count: number }[];
    byCta: { ctaLabel: string | null; count: number }[];
  }>;
  /** One statement, so a scan is counted exactly once even under load. */
  bumpTrackingCounter(codeId: string, field: 'scans' | 'clicks' | 'redemptions', by: number): Promise<void>;

  upsertDailyMetric(data: {
    campaignId: string;
    day: Date;
    spotsLive: number;
    spend: Prisma.Decimal;
    scans: number;
    clicks: number;
    redemptions: number;
    estimatedReach: number | null;
    reachFromSpots: number;
  }): Promise<void>;
  findDailyMetrics(campaignId: string, from: Date, to: Date): Promise<MetricRow[]>;
  /**
   * E11-2: the stored rows of several campaigns over one span, day ascending —
   * the two windows the analytics comparison reads in one query. `from` and
   * `to` are inclusive UTC days.
   */
  dailyMetricsFor(campaignIds: string[], from: Date, to: Date): Promise<MetricRow[]>;
  /** Scan, click and redemption totals per day for one campaign. */
  eventTotalsByDay(campaignId: string, from: Date, to: Date): Promise<{ day: string; type: TrackingEventType; count: number }[]>;
  trackingTotals(campaignId: string): Promise<{ scans: number; clicks: number; redemptions: number }>;

  /**
   * Enough of an advertiser to decide whether this actor may book for them.
   * Read here rather than borrowed from the advertisers module because it is a
   * permission check on every write, and a cross-module call per write is a
   * dependency this module does not need.
   */
  /** QR-16: `kycStatus` rides along — the launch gate reads it; absent on a narrow read. */
  advertiserContext(advertiserId: string): Promise<{ id: string; agentId: string | null; userId: string | null; kycStatus?: KycStatus } | null>;

  /** The listings behind a cart, priced and measured. */
  listingsByIds(ids: string[]): Promise<CandidateListing[]>;

  /** Campaigns whose dates say they should be live, scheduled or finished. */
  campaignsToTransition(now: Date): Promise<{ id: string; status: CampaignStatus; startDate: Date | null; endDate: Date | null }[]>;

  /* ── Campaign refunds (Lot B, Q41) ─────────────────────────────── */
  /** One per campaign — `campaignId` is unique, so a second cancel finds the first. */
  createCampaignRefund(data: {
    campaignId: string;
    amount: Prisma.Decimal;
    reason: string;
    requestedByUserId: string;
  }): Promise<CampaignRefundRow>;
  findCampaignRefund(id: string): Promise<CampaignRefundView | null>;
  findCampaignRefundByCampaign(campaignId: string): Promise<CampaignRefundRow | null>;
  /** E7-3: `campaignId` narrows the queue to one campaign; the chips count the rest of the filter. */
  listCampaignRefunds(query: { status?: readonly string[] | undefined; campaignId?: string | undefined; page: number; pageSize: number }): Promise<{
    items: CampaignRefundView[];
    total: number;
    counts: Record<string, number>;
  }>;
  updateCampaignRefund(id: string, patch: CampaignRefundPatch): Promise<CampaignRefundRow>;

  /* ── Landing pages (Lot E, Q7/Q106) ───────────────────────────── */
  /** One per campaign — `campaignId` is unique. */
  findLandingPage(campaignId: string): Promise<LandingPageRow | null>;
  /** T-B: the row with the campaign the review list draws beside it — what the unpublish answers. */
  findLandingPageView(campaignId: string): Promise<LandingPageView | null>;
  /**
   * E11-2: the narrow read `GET /campaigns/:id` carries — through the
   * campaign's `landingPage` relation, four columns, never the blocks.
   */
  landingPageSummary(campaignId: string): Promise<LandingPageSummaryRow | null>;
  /** The public read: by slug, PUBLISHED only, with the campaign's name for the title. */
  findPublishedLandingPageBySlug(slug: string): Promise<(LandingPageRow & { campaignName: string }) | null>;
  landingSlugExists(slug: string): Promise<boolean>;
  createLandingPage(data: {
    campaignId: string;
    slug: string;
    blocks: Prisma.InputJsonValue;
    theme: Prisma.InputJsonValue | null;
    generatedByAi: boolean;
    createdByUserId: string;
  }): Promise<LandingPageRow>;
  updateLandingPage(campaignId: string, patch: LandingPagePatch): Promise<LandingPageRow>;
  listLandingPages(query: { status?: readonly string[] | undefined; page: number; pageSize: number }): Promise<{
    items: LandingPageView[];
    total: number;
    counts: Record<string, number>;
  }>;
}
