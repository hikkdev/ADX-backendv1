import type { Prisma } from '../../shared/database';

/**
 * The aggregates behind the console's overview — Lot B (Q30/Q80).
 *
 * Every method is a sum or a count over a window and nothing else: this
 * module reads across the tables other modules own, and the port keeps that
 * to aggregates so nothing here can ever become a second write path. See the
 * README for why a reporting module is the one place that read is allowed.
 */

export type Window = { start: Date; end: Date };

export interface AdminOverviewRepository {
  /**
   * What advertisers committed in the window: Campaign.total by `paidAt`
   * (status not CANCELLED) and PackageSale.total by `paidAt` (likewise).
   */
  bookingsAuthorised(window: Window): Promise<{ campaigns: Prisma.Decimal; packages: Prisma.Decimal }>;
  /** E6: how many bookings (campaigns + package sales) were paid in the window, same filter as the sum. */
  bookingsCount(window: Window): Promise<number>;
  /**
   * What left advertiser wallets for media in the window: the platform-side
   * legs of CAMPAIGN_SPEND transactions by `occurredAt` — the whole booking,
   * captured when the campaign starts (B3a).
   */
  campaignSpend(window: Window): Promise<Prisma.Decimal>;
  /** Whether any CAMPAIGN_SPEND transaction has ever been posted. */
  hasCampaignSpendLegs(): Promise<boolean>;
  /** The accrual's gross for the days in the window — the fallback GMV. */
  accrualGross(window: Window): Promise<Prisma.Decimal>;
  /** Net movement on `platform:revenue` in the window, reversals included. */
  platformRevenue(window: Window): Promise<Prisma.Decimal>;
  /** EarningAccrual.net for the days in the window. */
  publisherEarnings(window: Window): Promise<Prisma.Decimal>;
  /** Campaigns that ran on any day of the window: LIVE, PAUSED or COMPLETED, flight overlapping it. */
  activeCampaigns(window: Window): Promise<number>;
  newPublishers(window: Window): Promise<number>;
  newAdvertisers(window: Window): Promise<number>;
  /** Submitted and still PENDING, across the four KYC tables. Not month-scoped: it is a queue. */
  kycPending(): Promise<number>;
  /** G13-B: listings whose `publishedAt` falls in the window — the "new this window" beside the active count. */
  listingsPublished(window: Window): Promise<number>;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Lot G (Q115 / Q112): the analytics set and the dashboard insights.
 *
 * The port grows a second kind of method beside the aggregates: a window-
 * scoped FACT read — narrow, id-keyed rows the service buckets by Indian day
 * and apportions across a campaign's spots. Every fact read is bounded by the
 * bookings in the window (one row per capture, per paid booking, per credited
 * incentive, per party onboarded), never by listing-days; the one table that
 * grows by listing-days, EarningAccrual, is only ever read through groupBy.
 * Nothing here returns a row a caller could write back.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * What narrows a series: a listing category, a city, or "agent-assisted
 * only". Lot X-B: `city` is a slug or a name; `cityId` the key it resolved
 * to (null for a typed town) — a fact is in the city by its key, the
 * spelling (case-insensitive) catching the facts whose key is null.
 */
export type AnalyticsFilter = {
  category?: string | undefined;
  city?: string | undefined;
  cityId?: string | null | undefined;
  agentAssisted?: boolean | undefined;
};

/** Lot X-B: a fact's city — the typed string and the key beside it, with the catalogue's slug and name for the breakdown. */
export type CityOfFact = { city: string | null; cityId: string | null; citySlug: string | null; cityName: string | null };

/** One platform-side CAMPAIGN_SPEND leg: the whole booking, captured when the campaign started. */
export type CaptureFact = { occurredAt: Date; campaignId: string; amount: Prisma.Decimal };

/** A campaign as the series and the breakdown see it: who bought it, who sold it, what it booked. */
export type CampaignFact = {
  id: string;
  name: string;
  advertiserId: string;
  advertiserName: string;
  agentId: string | null;
  agentName: string | null;
  spots: SpotFact[];
};

export type SpotFact = CityOfFact & {
  id: string;
  listingId: string;
  lineTotal: Prisma.Decimal;
  category: string;
  publisherId: string | null;
  publisherName: string | null;
};

export type PaidCampaignFact = { id: string; paidAt: Date; total: Prisma.Decimal; advertiserId: string; agentId: string | null };
export type PaidPackageFact = {
  paidAt: Date;
  total: Prisma.Decimal;
  advertiserId: string;
  advertiserName: string | null;
  agentId: string | null;
  agentName: string | null;
};
export type AccrualDayFact = { forDate: Date; gross: Prisma.Decimal; net: Prisma.Decimal };
export type AccrualSpotFact = { campaignSpotId: string; gross: Prisma.Decimal; net: Prisma.Decimal };
export type IncentiveFact = { verifiedAt: Date; amount: Prisma.Decimal; agentId: string; agentName: string | null; agentCity: string | null; agentCityId: string | null };
export type OnboardingFact = { at: Date; city: string | null; cityId: string | null };
export type ListingCapacityFact = { id: string; slotsTotal: number; publishedAt: Date | null };
export type BookedSpotFact = { listingId: string; startDate: Date; endDate: Date; quantity: number };

export interface AnalyticsRepository {
  /** CAMPAIGN_SPEND platform-side legs by `occurredAt`, each with the campaign it captured. */
  campaignCaptures(window: Window): Promise<CaptureFact[]>;
  /** The campaigns behind a set of captures or bookings, with their spots and the spots' listings. */
  campaignsWithSpots(campaignIds: readonly string[]): Promise<CampaignFact[]>;
  /** Campaign.total by `paidAt`, status not CANCELLED. */
  paidCampaigns(window: Window): Promise<PaidCampaignFact[]>;
  /** PackageSale.total by `paidAt`, status not CANCELLED. */
  paidPackageSales(window: Window): Promise<PaidPackageFact[]>;
  /** EarningAccrual gross and net per `forDate`, narrowed by the filter through the listing and the campaign. */
  accrualByDay(window: Window, filter: AnalyticsFilter): Promise<AccrualDayFact[]>;
  /** EarningAccrual gross and net per spot over the window, same narrowing. */
  accrualBySpot(window: Window, filter: AnalyticsFilter): Promise<AccrualSpotFact[]>;
  /** Which campaign each spot belongs to. */
  spotCampaigns(spotIds: readonly string[]): Promise<{ id: string; campaignId: string }[]>;
  /** AgentIncentive CREDITED by `verifiedAt`, with the agent's city for the filter. */
  creditedIncentives(window: Window): Promise<IncentiveFact[]>;
  /** Publisher.activatedAt in the window. */
  onboardedPublishers(window: Window): Promise<OnboardingFact[]>;
  /** Advertiser.activatedAt in the window. */
  onboardedAdvertisers(window: Window): Promise<OnboardingFact[]>;
  /** AgentKyc VERIFIED by `reviewedAt` — the desk's decision is what turns an agent on. */
  activatedAgents(window: Window): Promise<OnboardingFact[]>;
  /** Every ACTIVE listing's slot capacity and when it went live. */
  activeListingsCapacity(): Promise<ListingCapacityFact[]>;
  /** BOOKED, LIVE or COMPLETED spots on ACTIVE listings whose flight overlaps the window. */
  bookedSpots(window: Window): Promise<BookedSpotFact[]>;
}

/** Q112: the counts the dashboard's rules read. Each is one `count`, and the rule lives in the service. */
export interface InsightsRepository {
  /** Submitted, still PENDING, and submitted before the cutoff — across the four KYC tables. */
  kycPendingSubmittedBefore(cutoff: Date): Promise<number>;
  /** PayoutBatch IN_REVIEW: built by one admin, waiting for the second. */
  payoutBatchesInReview(): Promise<number>;
  /** WithdrawalRequest APPROVED and decided before the cutoff — vetted, never released. */
  withdrawalsApprovedBefore(cutoff: Date): Promise<number>;
  /** FraudCase OPEN, INVESTIGATING or ESCALATED, opened before the cutoff. */
  fraudCasesOpenBefore(cutoff: Date): Promise<number>;
  /** The support queue's own breach rule: not CLOSED, not paused, either clock past. */
  supportTicketsBreached(now: Date): Promise<number>;
  /** PriceApproval PENDING whose grace ends between now and `until`. */
  floorGraceEndingBetween(now: Date, until: Date): Promise<number>;
  /** Distinct PENDING_PAYMENT campaigns with a spot hold ending between now and `until`. */
  pendingPaymentHoldsEndingBetween(now: Date, until: Date): Promise<number>;
}
