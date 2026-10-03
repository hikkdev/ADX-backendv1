import type { Prisma } from '../../shared/database';
import type { Money } from '../../shared/money';
import type { DatedHold, SlotWindow } from './slot-holds';

/**
 * The console's listing page (3 Oct 2026) — the owner: "I need to see
 * everything what we store on a listing."
 *
 * Two reads live here, both ADMIN-only and both read-only:
 *
 *  - the record: every column of the listing and every row that hangs off
 *    it, in ONE `findUnique` whose includes are chosen for the page (Prisma
 *    runs one query per relation, never one per row), plus one lookup for
 *    the names behind the bare user ids and one for the custom fields;
 *  - the insights: aggregates only — counts and sums grouped by Indian day
 *    in one `UNION ALL`, and the slot holds the occupancy is counted from.
 *
 * Kept apart from `ListingsRepository` on purpose: the publisher's PATCH
 * still answers `findOneForAdmin`'s narrow view, and nothing here may leak
 * into a read a non-admin can call.
 */

/** How many rows of each history the page draws; the counts beside them say how many there are. */
export const RECORD_HISTORY_TAKE = 10;

const person = { select: { id: true, name: true } } as const;

/**
 * Every relation the listing page draws, each with an explicit `select` on
 * any person or party so no whole User or Publisher row is ever joined.
 */
export const ADMIN_RECORD_INCLUDE = {
  publisher: { select: { id: true, name: true, displayId: true, city: true, type: true, isPartnerPublisher: true } },
  agent: { select: { id: true, displayId: true, user: { select: { name: true } } } },
  attempt: {
    select: { id: true, origin: true, status: true, sourceFilename: true, note: true, createdAt: true, createdBy: person },
  },
  photos: { orderBy: { createdAt: 'asc' } },
  mediaType: { select: { name: true, formatGroup: true } },
  venueType: { select: { id: true, name: true, slug: true, category: true } },
  sizeClass: { select: { id: true, name: true, slug: true } },
  material: { select: { id: true, name: true, slug: true } },
  plan: { select: { id: true, name: true } },
  cityRef: { select: { id: true, name: true, slug: true, state: true } },
  documents: {
    orderBy: { submittedAt: 'desc' },
    select: {
      id: true,
      kind: true,
      url: true,
      status: true,
      rejectionReason: true,
      expiresAt: true,
      submittedAt: true,
      reviewedAt: true,
      reviewedBy: person,
    },
  },
  verifications: {
    orderBy: { createdAt: 'desc' },
    take: RECORD_HISTORY_TAKE,
    select: {
      id: true,
      type: true,
      status: true,
      photoUrl: true,
      latitude: true,
      longitude: true,
      distanceMeters: true,
      qrScanned: true,
      capturedAt: true,
      orderId: true,
      reviewedAt: true,
      rejectionReason: true,
      createdAt: true,
      submittedBy: person,
      reviewedBy: person,
      photos: { orderBy: { order: 'asc' }, select: { id: true, url: true, label: true, order: true } },
    },
  },
  contentRules: { select: { stance: true, category: { select: { id: true, name: true, slug: true, isSensitive: true } } } },
  pricingFactors: {
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      suggested: true,
      applied: true,
      appliedRatePerDay: true,
      decidedById: true,
      decidedAt: true,
      createdAt: true,
      factor: { select: { id: true, name: true, mode: true, kind: true } },
    },
  },
  priceApprovals: {
    orderBy: { createdAt: 'desc' },
    take: RECORD_HISTORY_TAKE,
    select: {
      id: true,
      status: true,
      source: true,
      requestedRatePerDay: true,
      cardRatePerDay: true,
      floorRatePerDay: true,
      reason: true,
      requestedById: true,
      decidedById: true,
      decidedAt: true,
      decisionNote: true,
      graceUntil: true,
      heldByRunningOrder: true,
      createdAt: true,
    },
  },
  priceLocks: {
    orderBy: { createdAt: 'desc' },
    take: RECORD_HISTORY_TAKE,
    select: { id: true, ratePerDay: true, expiresAt: true, consumedAt: true, createdAt: true, advertiser: { select: { id: true, name: true, companyName: true } } },
  },
  blockedDates: { orderBy: { from: 'asc' }, select: { id: true, from: true, to: true, reason: true, createdById: true, createdAt: true } },
  claims: {
    orderBy: { createdAt: 'desc' },
    take: RECORD_HISTORY_TAKE,
    select: { id: true, status: true, decisionNote: true, decidedAt: true, createdAt: true, claimant: { select: { id: true, name: true, displayId: true } } },
  },
  complianceCases: {
    orderBy: { openedAt: 'desc' },
    take: RECORD_HISTORY_TAKE,
    select: { id: true, reason: true, status: true, openedAt: true, dueAt: true, resolvedAt: true, assignedTo: person },
  },
  earningsHolds: {
    orderBy: { heldFrom: 'desc' },
    take: RECORD_HISTORY_TAKE,
    select: { id: true, amount: true, status: true, heldFrom: true, convertsAt: true, releasedAt: true, forfeitedAt: true, note: true },
  },
  disputes: {
    orderBy: { createdAt: 'desc' },
    take: RECORD_HISTORY_TAKE,
    select: { id: true, displayId: true, reason: true, status: true, outcome: true, createdAt: true, resolvedAt: true },
  },
  _count: {
    select: {
      orders: true,
      campaignSpots: true,
      photos: true,
      documents: true,
      verifications: true,
      claims: true,
      complianceCases: true,
      earningsHolds: true,
      disputes: true,
      priceLocks: true,
      priceApprovals: true,
      blockedDates: true,
      earningAccruals: true,
    },
  },
} satisfies Prisma.ListingInclude;

export type AdminListingRecordRow = Prisma.ListingGetPayload<{ include: typeof ADMIN_RECORD_INCLUDE }>;

/** One answer to an extra question Settings › Custom fields asks of a listing, labelled by its definition. */
export type ListingCustomFieldRow = {
  key: string;
  label: string;
  kind: string;
  archived: boolean;
  value: unknown;
  updatedAt: Date;
};

/**
 * GC-1: what the upload register kept about a photograph — when it was
 * taken and where, when the camera's GPS stamp was on. LD-1: matched on the
 * photograph's `uploadedFileId` where it has one, else on the URL (indexed).
 */
export type PhotoStampRow = {
  id: string;
  url: string;
  takenAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  geoStamped: boolean;
};

/**
 * LM-1's sponsored placements bought for this spot — `ListingBoost` names
 * the listing by id with no relation, so it is its own small read.
 */
export type ListingBoostRow = {
  id: string;
  displayId: string | null;
  placements: string[];
  status: string;
  startDate: Date;
  endDate: Date;
  days: number;
  total: Prisma.Decimal;
  paidAt: Date | null;
  createdAt: Date;
};

/* ── Insights ─────────────────────────────────────────────────────── */

/** The day series the insights read, each a count (and a sum where it is money or a rating). */
/** LD-1: `views` and `uniqueVisitors` are the spot page's daily counts (`ListingView`); a window's visitors are the days' visitors summed. */
export const INSIGHT_METRICS = ['saves', 'bookings', 'bookedValue', 'scans', 'clicks', 'enquiries', 'landingViews', 'reviews', 'gmv', 'views', 'uniqueVisitors'] as const;
export type InsightMetric = (typeof INSIGHT_METRICS)[number];

/** One metric on one Indian day: how many, and the sum (money as a decimal string, or the stars) where it has one. */
export type InsightDayRow = { metric: InsightMetric; day: string; count: number; sum: Money | null };

/** The whole life of a listing, counted once. */
export type InsightLifetimeRow = { metric: InsightMetric; count: number; sum: Money | null };

/** What the insights need of the listing itself. */
export type InsightListingFacts = {
  id: string;
  slotsTotal: number;
  publishedAt: Date | null;
  createdAt: Date;
  ratingAvg: Prisma.Decimal | null;
  reviewCount: number;
};

/** A span of instants: `[start, end)`. */
export type InstantSpan = { start: Date; end: Date };

export interface ListingDeskRepository {
  /** The page's one read; null when there is no such listing. */
  findRecordForAdmin(listingId: string): Promise<AdminListingRecordRow | null>;
  /** `{ id, name }` per user id, one query. */
  userNamesById(ids: string[]): Promise<{ id: string; name: string | null }[]>;
  /** GC-1: the register's capture stamp for these photographs — by upload id where known, else by URL; one query. */
  photoStamps(photos: { url: string; uploadedFileId?: string | null }[]): Promise<PhotoStampRow[]>;
  /** The latest sponsored placements bought for this spot, and how many there are. */
  boostsFor(listingId: string, take: number): Promise<{ items: ListingBoostRow[]; total: number }>;
  /** Every custom-field answer on this listing, in the definitions' order. */
  customFieldValuesFor(listingId: string): Promise<ListingCustomFieldRow[]>;

  insightFacts(listingId: string): Promise<InsightListingFacts | null>;
  /**
   * Every insight metric per Indian day over the span, in one `UNION ALL`:
   * `[start, end)` instants for the timestamped rows, and the inclusive days
   * `fromDay`..`toDay` for the accruals, whose `forDate` is already a day.
   */
  insightDays(listingId: string, span: InstantSpan, days: { fromDay: string; toDay: string }): Promise<InsightDayRow[]>;
  /** The same metrics over the listing's whole life. */
  insightLifetime(listingId: string): Promise<InsightLifetimeRow[]>;
  /** The slot holds (orders that hold a slot, and the publisher's blocks) touching the window, with their days. */
  occupancyHolds(listingId: string, window: SlotWindow): Promise<DatedHold[]>;
}
