import { readThrough } from '../../shared/cache';
import { csvCell } from '../../shared/csv';
import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money, ZERO } from '../../shared/money';
import { listArgs, toListPage, type ListPage } from '../../shared/pagination';
import { cityKeyFor } from '../pricing';
import type { AccrualSpotFact, AnalyticsFilter, CampaignFact, CaptureFact, PaidCampaignFact, PaidPackageFact, SpotFact, Window } from './admin-overview.repository';
import { prismaAdminOverviewRepository as repository } from './prisma-admin-overview.repository';

/**
 * The analytics set — Lot G (Q115).
 *
 * Four reads over one idea: a day-granular walk over the ledger and the
 * orders, bucketed by Indian day, with the previous window of the same length
 * beside it. The series answers the charts, the breakdown answers the tables
 * (top publishers is `by=publisher`), the tiles answer the KPI row, and the
 * CSV is the series streamed. Every read is cached a minute keyed by its
 * query, because the console polls and each answer walks the ledger.
 *
 * What each figure is, and where it comes from:
 *
 *   gmvRecognised       the platform-side CAMPAIGN_SPEND legs by the Indian
 *                       day they were posted — the whole booking, captured
 *                       when the campaign starts (B3a). Until any such leg
 *                       exists on the database, the accrual's gross, and
 *                       `gmvSource` says which
 *   bookingsAuthorised  Campaign.total by paidAt plus PackageSale.total by
 *                       paidAt, neither CANCELLED — count and value
 *   publisherEarnings   EarningAccrual.net by forDate
 *   advertiserSpend     gmvRecognised plus the package sales paid — what left
 *                       advertisers' wallets, media or not
 *   agentCommissions    AgentIncentive CREDITED by the day it was verified
 *   onboardingStats     Publisher.activatedAt, Advertiser.activatedAt, and
 *                       AgentKyc VERIFIED by reviewedAt — the desk's decision
 *                       is what turns an agent on
 *
 * A category or city filter narrows through the listing. A capture is the
 * whole booking, so a filtered read sees the part of it the matching spots
 * carry, in the ratio of their line totals; a package sale has no listing and
 * drops out. The city filter also reaches the agent's city (commissions) and
 * the parties' cities (onboarding); a category filter leaves those two alone,
 * because neither has one. The AGENTS segment narrows the money to
 * agent-assisted bookings — a campaign or a package sale with an agent on it.
 */

export const ANALYTICS_CACHE_SECONDS = 60;
/** At most a year in one read: each day is a bucket and every fact in it is walked. */
export const MAX_ANALYTICS_DAYS = 366;

export const GRANULARITIES = ['day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];
export const SEGMENTS = ['ALL', 'PUBLISHERS', 'ADVERTISERS', 'AGENTS'] as const;
export type Segment = (typeof SEGMENTS)[number];
export const BREAKDOWN_DIMENSIONS = ['category', 'city', 'publisher', 'advertiser', 'agent'] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];
export const BREAKDOWN_SORTS = [
  'GMV_DESC',
  'GMV_ASC',
  'BOOKINGS_DESC',
  'BOOKINGS_ASC',
  'VALUE_DESC',
  'VALUE_ASC',
  'EARNINGS_DESC',
  'EARNINGS_ASC',
  'LABEL_ASC',
  'LABEL_DESC',
] as const;
export type BreakdownSort = (typeof BREAKDOWN_SORTS)[number];

export type SeriesQuery = {
  from: string;
  to: string;
  granularity: Granularity;
  segment: Segment;
  category?: string | undefined;
  city?: string | undefined;
};
export type BreakdownQuery = {
  from: string;
  to: string;
  by: BreakdownDimension;
  sort: BreakdownSort;
  page: number;
  pageSize: number;
  q?: string | undefined;
};
export type TilesQuery = { from: string; to: string };

export const SERIES_METRICS = [
  'gmvRecognised',
  'bookingsCount',
  'bookingsValue',
  'publisherEarnings',
  'advertiserSpend',
  'agentCommissions',
  'publishersOnboarded',
  'advertisersOnboarded',
  'agentsActivated',
] as const;
export type SeriesMetric = (typeof SERIES_METRICS)[number];

/** Which series each segment draws. The buckets always carry every figure. */
const SEGMENT_SERIES: Record<Segment, SeriesMetric[]> = {
  ALL: [...SERIES_METRICS],
  PUBLISHERS: ['gmvRecognised', 'publisherEarnings', 'publishersOnboarded'],
  ADVERTISERS: ['bookingsCount', 'bookingsValue', 'gmvRecognised', 'advertiserSpend', 'advertisersOnboarded'],
  AGENTS: ['bookingsCount', 'bookingsValue', 'gmvRecognised', 'agentCommissions', 'agentsActivated'],
};

export type SeriesFigures = {
  gmvRecognised: Money;
  bookingsAuthorised: { count: number; value: Money };
  publisherEarnings: Money;
  advertiserSpend: Money;
  agentCommissions: Money;
  onboardingStats: { publishersOnboarded: number; advertisersOnboarded: number; agentsActivated: number };
};

export type SeriesBucket = SeriesFigures & {
  /** The bucket's natural start as an Indian day — the day, the Monday, or the first of the month. */
  bucket: string;
  /** The bucket's bounds as instants, clamped to the window. */
  start: string;
  end: string;
};

export type Comparison<T extends Money | number> = { current: T; previous: T; deltaPct: string | null };

export type AnalyticsSeries = {
  from: string;
  to: string;
  granularity: Granularity;
  segment: Segment;
  filters: { category: string | null; city: string | null };
  /** The series this segment draws — see the README. */
  series: SeriesMetric[];
  gmvSource: 'CAMPAIGN_SPEND' | 'ACCRUAL_GROSS';
  window: { start: string; end: string };
  previousWindow: { start: string; end: string };
  buckets: SeriesBucket[];
  totals: SeriesFigures;
  previous: { buckets: SeriesBucket[]; totals: SeriesFigures };
  comparison: {
    gmvRecognised: Comparison<Money>;
    bookingsCount: Comparison<number>;
    bookingsValue: Comparison<Money>;
    publisherEarnings: Comparison<Money>;
    advertiserSpend: Comparison<Money>;
    agentCommissions: Comparison<Money>;
    publishersOnboarded: Comparison<number>;
    advertisersOnboarded: Comparison<number>;
    agentsActivated: Comparison<number>;
  };
};

export type BreakdownRow = {
  key: string;
  label: string;
  /** The console route for the row — a party's page, or the listings list filtered. */
  href: string;
  gmvRecognised: Money;
  bookingsCount: number;
  bookingsValue: Money;
  publisherEarnings: Money;
  /** This row's GMV over the whole window's, two decimals. */
  sharePct: string;
  /** G11-1: the same row over the window shifted back; null when it had nothing then. */
  previous: { gmvRecognised: Money; bookings: number } | null;
  /** G11-1: the GMV movement against `previous`; null with nothing to compare with. */
  deltaPct: string | null;
};

export type FillRate = { pct: string; bookedListingDays: number; availableListingDays: number };

export type AnalyticsTiles = {
  from: string;
  to: string;
  window: { start: string; end: string };
  previousWindow: { start: string; end: string };
  gmvSource: 'CAMPAIGN_SPEND' | 'ACCRUAL_GROSS';
  /**
   * `count` is listings ACTIVE now — a state, not a window figure. G13-B:
   * `newInWindow` / `previousNewInWindow` are `Listing.publishedAt` in the
   * window and the one before, `delta` their difference — the "1,092 up 64".
   */
  activeListings: { count: number; newInWindow: number; previousNewInWindow: number; delta: number };
  fillRate: { current: FillRate; previous: FillRate; deltaPct: string | null };
  gmvRecognised: Comparison<Money>;
  takeRatePct: Comparison<string>;
  platformRevenue: Comparison<Money>;
  bookingsAuthorised: Comparison<Money>;
  activeCampaigns: Comparison<number>;
  /** The KYC queue — not window-scoped. */
  kycPending: number;
};

/* ── Indian days ────────────────────────────────────────────────────────────
 *
 * A "day index" is days since 1970-01-01. For an instant it is counted in
 * Indian days; for a date-only column — an accrual's forDate, a spot's flight
 * — it is the UTC day, because those columns store the Indian day at UTC
 * midnight. Buckets and windows are ranges of day indexes, so nothing below
 * ever compares an instant with a date.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const dayIndexOfInstant = (instant: Date) => Math.floor((instant.getTime() + IST_OFFSET_MS) / DAY_MS);
const dayIndexOfDate = (date: Date) => Math.floor(date.getTime() / DAY_MS);
const isoOfDayIndex = (index: number) => new Date(index * DAY_MS).toISOString().slice(0, 10);
/** The IST midnight that opens the day. */
const instantOfDayIndex = (index: number) => new Date(index * DAY_MS - IST_OFFSET_MS);

function dayIndexOfIso(iso: string): number {
  if (!ISO_DAY.test(iso)) throw new ApiError(400, 'VALIDATION_ERROR', 'Dates must be YYYY-MM-DD');
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** The first day of the bucket a day falls in. 1970-01-01 was a Thursday, hence the +3 to land Monday on 0. */
function bucketStartDayIndex(index: number, granularity: Granularity): number {
  if (granularity === 'day') return index;
  if (granularity === 'week') return index - ((((index + 3) % 7) + 7) % 7);
  const date = new Date(index * DAY_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / DAY_MS;
}

function nextBucketStartDayIndex(start: number, granularity: Granularity): number {
  if (granularity === 'day') return start + 1;
  if (granularity === 'week') return start + 7;
  const date = new Date(start * DAY_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / DAY_MS;
}

/** The bucket an instant belongs to, as its natural start day. */
export function bucketKeyOf(instant: Date, granularity: Granularity): string {
  return isoOfDayIndex(bucketStartDayIndex(dayIndexOfInstant(instant), granularity));
}

export type AnalyticsWindow = Window & {
  days: number;
  fromIndex: number;
  toIndex: number;
  previous: Window;
};

/**
 * `from` and `to` are inclusive Indian days. The previous window is the same
 * number of days immediately before. Reversed or longer than a year is a 400.
 */
export function analyticsWindow(from: string, to: string): AnalyticsWindow {
  const fromIndex = dayIndexOfIso(from);
  const toIndex = dayIndexOfIso(to);
  if (toIndex < fromIndex) throw new ApiError(400, 'VALIDATION_ERROR', 'to must not be before from');
  const days = toIndex - fromIndex + 1;
  if (days > MAX_ANALYTICS_DAYS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `At most ${MAX_ANALYTICS_DAYS} days in one read`);
  }
  const start = instantOfDayIndex(fromIndex);
  return {
    start,
    end: instantOfDayIndex(toIndex + 1),
    days,
    fromIndex,
    toIndex,
    previous: { start: instantOfDayIndex(fromIndex - days), end: start },
  };
}

/** `(current − previous) / previous × 100`, two decimals; null when there was nothing to compare with. */
export function deltaPct(current: Decimal | number, previous: Decimal | number): string | null {
  const before = new Decimal(previous);
  if (before.isZero()) return null;
  return new Decimal(current).minus(before).dividedBy(before).times(100).toFixed(2);
}

const compare = <T extends Money | number>(current: T, previous: T): Comparison<T> => ({
  current,
  previous,
  deltaPct: deltaPct(new Decimal(current), new Decimal(previous)),
});

/* ── Accumulators ─────────────────────────────────────────────────────────── */

type Tally = {
  gmv: Decimal;
  bookingsCount: number;
  bookingsValue: Decimal;
  earnings: Decimal;
  packages: Decimal;
  commissions: Decimal;
  publishers: number;
  advertisers: number;
  agents: number;
};

const emptyTally = (): Tally => ({
  gmv: ZERO,
  bookingsCount: 0,
  bookingsValue: ZERO,
  earnings: ZERO,
  packages: ZERO,
  commissions: ZERO,
  publishers: 0,
  advertisers: 0,
  agents: 0,
});

const figuresOf = (tally: Tally): SeriesFigures => ({
  gmvRecognised: money(tally.gmv),
  bookingsAuthorised: { count: tally.bookingsCount, value: money(tally.bookingsValue) },
  publisherEarnings: money(tally.earnings),
  advertiserSpend: money(tally.gmv.plus(tally.packages)),
  agentCommissions: money(tally.commissions),
  onboardingStats: { publishersOnboarded: tally.publishers, advertisersOnboarded: tally.advertisers, agentsActivated: tally.agents },
});

/** One span of days cut into buckets, with a day → bucket lookup. */
class Span {
  readonly buckets: { key: string; startIndex: number; endIndex: number; tally: Tally }[] = [];
  private readonly positions: number[] = [];
  readonly total = emptyTally();

  constructor(
    readonly fromIndex: number,
    readonly toIndex: number,
    granularity: Granularity,
  ) {
    let index = fromIndex;
    while (index <= toIndex) {
      const start = bucketStartDayIndex(index, granularity);
      const endIndex = Math.min(nextBucketStartDayIndex(start, granularity) - 1, toIndex);
      const position = this.buckets.length;
      this.buckets.push({ key: isoOfDayIndex(start), startIndex: index, endIndex, tally: emptyTally() });
      for (let day = index; day <= endIndex; day += 1) this.positions[day - fromIndex] = position;
      index = endIndex + 1;
    }
  }

  /** The bucket a day falls in, or nothing when the day is outside the span. */
  at(dayIndex: number): Tally | undefined {
    if (dayIndex < this.fromIndex || dayIndex > this.toIndex) return undefined;
    return this.buckets[this.positions[dayIndex - this.fromIndex]!]!.tally;
  }

  add(dayIndex: number, apply: (tally: Tally) => void): void {
    const tally = this.at(dayIndex);
    if (!tally) return;
    apply(tally);
    apply(this.total);
  }

  view(): SeriesBucket[] {
    return this.buckets.map((bucket) => ({
      bucket: bucket.key,
      start: instantOfDayIndex(bucket.startIndex).toISOString(),
      end: instantOfDayIndex(bucket.endIndex + 1).toISOString(),
      ...figuresOf(bucket.tally),
    }));
  }
}

/* ── Filters and shares ───────────────────────────────────────────────────── */

/**
 * Lot X-B: the key is the identity. A keyed fact is in the filter's city
 * when the keys agree, whatever it was typed as; a fact with no key (a typed
 * town) is in it when the spelling matches, case-insensitively — which is
 * also all a facet that resolved to no key can ever match.
 */
const inCity = (fact: { city: string | null | undefined; cityId: string | null | undefined }, filter: AnalyticsFilter): boolean => {
  if (filter.city === undefined) return true;
  if (fact.cityId) return fact.cityId === filter.cityId;
  return (fact.city ?? '').trim().toLowerCase() === filter.city.trim().toLowerCase();
};

const spotMatches = (spot: SpotFact, filter: AnalyticsFilter) =>
  (filter.category === undefined || spot.category === filter.category) && inCity(spot, filter);

/**
 * How much of a booking a filtered read sees: all of it with no listing
 * filter, none of it when the agent segment asks for an agent it has not got,
 * otherwise the matching spots' line totals over all of them. A booking with
 * no priced spots is shared by count instead of by value.
 */
function shareOf(campaign: CampaignFact | undefined, filter: AnalyticsFilter): Decimal {
  if (filter.agentAssisted && !campaign?.agentId) return ZERO;
  if (filter.category === undefined && filter.city === undefined) return new Decimal(1);
  if (!campaign) return ZERO;
  const matching = campaign.spots.filter((spot) => spotMatches(spot, filter));
  if (matching.length === 0) return ZERO;
  const total = campaign.spots.reduce((sum, spot) => sum.plus(spot.lineTotal), ZERO);
  if (total.isZero()) return new Decimal(matching.length).dividedBy(campaign.spots.length);
  return matching.reduce((sum, spot) => sum.plus(spot.lineTotal), ZERO).dividedBy(total);
}

const hasListingFilter = (filter: AnalyticsFilter) => filter.category !== undefined || filter.city !== undefined;

async function filterFor(query: SeriesQuery): Promise<AnalyticsFilter> {
  return {
    category: query.category,
    city: query.city,
    // Lot X-B: `?city=` is a slug (or a name, for the console's older links), resolved once.
    cityId: query.city ? ((await cityKeyFor(query.city))?.cityId ?? null) : undefined,
    agentAssisted: query.segment === 'AGENTS' ? true : undefined,
  };
}

/* ── The series ───────────────────────────────────────────────────────────── */

export function seriesCacheKey(query: SeriesQuery): string {
  const city = query.city ? query.city.trim().toLowerCase() : '-';
  return `admin-overview:series:${query.from}:${query.to}:${query.granularity}:${query.segment}:${query.category ?? '-'}:${city}`;
}

async function loadSeries(query: SeriesQuery): Promise<AnalyticsSeries> {
  const window = analyticsWindow(query.from, query.to);
  const filter = await filterFor(query);
  // Both windows in one read, split by day afterwards: the previous window is
  // the same facts a little earlier, and a ledger walked once is a ledger.
  const combined: Window = { start: window.previous.start, end: window.end };
  const current = new Span(window.fromIndex, window.toIndex, query.granularity);
  const previous = new Span(window.fromIndex - window.days, window.fromIndex - 1, query.granularity);
  const place = (dayIndex: number, apply: (tally: Tally) => void) => {
    current.add(dayIndex, apply);
    previous.add(dayIndex, apply);
  };

  const hasSpend = await repository.hasCampaignSpendLegs();
  const [captures, paidCampaigns, packages, accrualDays, incentives, publishers, advertisers, agents] = await Promise.all([
    hasSpend ? repository.campaignCaptures(combined) : Promise.resolve([]),
    repository.paidCampaigns(combined),
    repository.paidPackageSales(combined),
    repository.accrualByDay(combined, filter),
    repository.creditedIncentives(combined),
    repository.onboardedPublishers(combined),
    repository.onboardedAdvertisers(combined),
    repository.activatedAgents(combined),
  ]);

  const campaignIds = [...new Set([...captures.map((c) => c.campaignId), ...paidCampaigns.map((c) => c.id)])];
  const campaigns = new Map((await repository.campaignsWithSpots(campaignIds)).map((campaign) => [campaign.id, campaign]));

  for (const capture of captures) {
    const share = shareOf(campaigns.get(capture.campaignId), filter);
    if (share.isZero()) continue;
    const amount = capture.amount.times(share);
    place(dayIndexOfInstant(capture.occurredAt), (t) => {
      t.gmv = t.gmv.plus(amount);
    });
  }
  for (const day of accrualDays) {
    place(dayIndexOfDate(day.forDate), (t) => {
      t.earnings = t.earnings.plus(day.net);
      if (!hasSpend) t.gmv = t.gmv.plus(day.gross);
    });
  }
  for (const campaign of paidCampaigns) {
    const share = shareOf(campaigns.get(campaign.id), filter);
    if (share.isZero()) continue;
    const value = campaign.total.times(share);
    place(dayIndexOfInstant(campaign.paidAt), (t) => {
      t.bookingsCount += 1;
      t.bookingsValue = t.bookingsValue.plus(value);
    });
  }
  if (!hasListingFilter(filter)) {
    for (const sale of packages) {
      if (filter.agentAssisted && !sale.agentId) continue;
      place(dayIndexOfInstant(sale.paidAt), (t) => {
        t.bookingsCount += 1;
        t.bookingsValue = t.bookingsValue.plus(sale.total);
        t.packages = t.packages.plus(sale.total);
      });
    }
  }
  for (const incentive of incentives) {
    if (!inCity({ city: incentive.agentCity, cityId: incentive.agentCityId }, filter)) continue;
    place(dayIndexOfInstant(incentive.verifiedAt), (t) => {
      t.commissions = t.commissions.plus(incentive.amount);
    });
  }
  const onboard = (rows: { at: Date; city: string | null; cityId: string | null }[], apply: (tally: Tally) => void) => {
    for (const row of rows) {
      if (!inCity(row, filter)) continue;
      place(dayIndexOfInstant(row.at), apply);
    }
  };
  onboard(publishers, (t) => {
    t.publishers += 1;
  });
  onboard(advertisers, (t) => {
    t.advertisers += 1;
  });
  onboard(agents, (t) => {
    t.agents += 1;
  });

  const totals = figuresOf(current.total);
  const before = figuresOf(previous.total);
  return {
    from: query.from,
    to: query.to,
    granularity: query.granularity,
    segment: query.segment,
    filters: { category: query.category ?? null, city: query.city ?? null },
    series: SEGMENT_SERIES[query.segment],
    gmvSource: hasSpend ? 'CAMPAIGN_SPEND' : 'ACCRUAL_GROSS',
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    previousWindow: { start: window.previous.start.toISOString(), end: window.previous.end.toISOString() },
    buckets: current.view(),
    totals,
    previous: { buckets: previous.view(), totals: before },
    comparison: {
      gmvRecognised: compare(totals.gmvRecognised, before.gmvRecognised),
      bookingsCount: compare(totals.bookingsAuthorised.count, before.bookingsAuthorised.count),
      bookingsValue: compare(totals.bookingsAuthorised.value, before.bookingsAuthorised.value),
      publisherEarnings: compare(totals.publisherEarnings, before.publisherEarnings),
      advertiserSpend: compare(totals.advertiserSpend, before.advertiserSpend),
      agentCommissions: compare(totals.agentCommissions, before.agentCommissions),
      publishersOnboarded: compare(totals.onboardingStats.publishersOnboarded, before.onboardingStats.publishersOnboarded),
      advertisersOnboarded: compare(totals.onboardingStats.advertisersOnboarded, before.onboardingStats.advertisersOnboarded),
      agentsActivated: compare(totals.onboardingStats.agentsActivated, before.onboardingStats.agentsActivated),
    },
  };
}

/** GET /admin/overview/series — cached a minute keyed by the query. */
export async function analyticsSeries(query: SeriesQuery): Promise<AnalyticsSeries> {
  analyticsWindow(query.from, query.to); // a bad range is a 400 before the cache is consulted
  return readThrough(seriesCacheKey(query), ANALYTICS_CACHE_SECONDS, () => loadSeries(query));
}

export const SERIES_CSV_COLUMNS = [
  'bucket',
  'start',
  'end',
  'gmvRecognised',
  'bookingsCount',
  'bookingsValue',
  'publisherEarnings',
  'advertiserSpend',
  'agentCommissions',
  'publishersOnboarded',
  'advertisersOnboarded',
  'agentsActivated',
] as const;

/** The series as CSV lines, CRLF-terminated — the header, then one line per bucket. */
export function* seriesCsvLines(series: AnalyticsSeries): Generator<string> {
  yield SERIES_CSV_COLUMNS.join(',') + '\r\n';
  for (const bucket of series.buckets) {
    const cells = [
      bucket.bucket,
      bucket.start,
      bucket.end,
      bucket.gmvRecognised,
      bucket.bookingsAuthorised.count,
      bucket.bookingsAuthorised.value,
      bucket.publisherEarnings,
      bucket.advertiserSpend,
      bucket.agentCommissions,
      bucket.onboardingStats.publishersOnboarded,
      bucket.onboardingStats.advertisersOnboarded,
      bucket.onboardingStats.agentsActivated,
    ];
    yield cells.map(csvCell).join(',') + '\r\n';
  }
}

/* ── The breakdown ────────────────────────────────────────────────────────── */

export function breakdownCacheKey(query: Pick<BreakdownQuery, 'from' | 'to' | 'by'>): string {
  return `admin-overview:breakdown:${query.from}:${query.to}:${query.by}`;
}

type Group = { key: string; label: string | null; href: string; share: Decimal };

type Accumulator = { key: string; label: string | null; href: string; gmv: Decimal; bookingsCount: number; bookingsValue: Decimal; earnings: Decimal };

const hrefFor = (by: BreakdownDimension, key: string): string => {
  switch (by) {
    case 'category':
      return `/listings?category=${encodeURIComponent(key)}`;
    case 'city':
      // Lot X-B: the key is the slug; the "typed" bucket has no page.
      return key === OTHER_CITY_KEY ? '' : `/listings?city=${encodeURIComponent(key)}`;
    case 'publisher':
      return `/publishers/${key}`;
    case 'advertiser':
      return `/advertisers/${key}`;
    case 'agent':
      return `/agents/${key}`;
  }
};

/** Lot X-B: the city breakdown's bucket for the spots typed under a town with no key. */
export const OTHER_CITY_KEY = 'other';
export const OTHER_CITY_LABEL = 'Other (typed)';

/** The group one spot belongs to under a listing dimension, or nothing when it has none (an unclaimed listing, no city). */
function spotGroup(spot: SpotFact, by: BreakdownDimension): { key: string; label: string | null } | null {
  switch (by) {
    case 'category':
      return { key: spot.category, label: spot.category };
    case 'city':
      // Lot X-B: by key — the slug, labelled from the catalogue; a typed town lands in one "Other (typed)" bucket.
      if (spot.cityId && spot.citySlug) return { key: spot.citySlug, label: spot.cityName ?? spot.citySlug };
      return spot.city ? { key: OTHER_CITY_KEY, label: OTHER_CITY_LABEL } : null;
    case 'publisher':
      return spot.publisherId ? { key: spot.publisherId, label: spot.publisherName } : null;
    default:
      return null;
  }
}

/** A whole booking's groups under a dimension, each with the share of it that group carries. */
function groupsOf(campaign: CampaignFact | undefined, by: BreakdownDimension): Group[] {
  if (!campaign) return [];
  if (by === 'advertiser') {
    return [{ key: campaign.advertiserId, label: campaign.advertiserName, href: hrefFor(by, campaign.advertiserId), share: new Decimal(1) }];
  }
  if (by === 'agent') {
    return campaign.agentId ? [{ key: campaign.agentId, label: campaign.agentName, href: hrefFor(by, campaign.agentId), share: new Decimal(1) }] : [];
  }
  const total = campaign.spots.reduce((sum, spot) => sum.plus(spot.lineTotal), ZERO);
  const byKey = new Map<string, Group>();
  for (const spot of campaign.spots) {
    const group = spotGroup(spot, by);
    if (!group) continue;
    const share = total.isZero() ? new Decimal(1).dividedBy(campaign.spots.length) : spot.lineTotal.dividedBy(total);
    const existing = byKey.get(group.key);
    if (existing) existing.share = existing.share.plus(share);
    else byKey.set(group.key, { ...group, href: hrefFor(by, group.key), share });
  }
  return [...byKey.values()];
}

/** The facts one window's breakdown is built from. */
type BreakdownFacts = { captures: CaptureFact[]; paidCampaigns: PaidCampaignFact[]; packages: PaidPackageFact[]; accrualSpots: AccrualSpotFact[] };

/**
 * One window's facts. G11-1: the previous window is read for its GMV and
 * bookings only, so its accruals are walked only while they are the GMV
 * source (no CAMPAIGN_SPEND legs yet) — earnings are not compared.
 */
async function breakdownFacts(window: Window, hasSpend: boolean, purpose: 'current' | 'previous'): Promise<BreakdownFacts> {
  const [captures, paidCampaigns, packages, accrualSpots] = await Promise.all([
    hasSpend ? repository.campaignCaptures(window) : Promise.resolve([]),
    repository.paidCampaigns(window),
    repository.paidPackageSales(window),
    purpose === 'current' || !hasSpend ? repository.accrualBySpot(window, {}) : Promise.resolve([]),
  ]);
  return { captures, paidCampaigns, packages, accrualSpots };
}

/** The rows of one window under a dimension, keyed by the group. */
function accumulateBreakdown(
  facts: BreakdownFacts,
  by: BreakdownDimension,
  hasSpend: boolean,
  campaigns: ReadonlyMap<string, CampaignFact>,
  spotOwners: ReadonlyMap<string, string>,
): Map<string, Accumulator> {
  const { captures, paidCampaigns, packages, accrualSpots } = facts;
  const rows = new Map<string, Accumulator>();
  const row = (group: { key: string; label: string | null; href: string }): Accumulator => {
    let existing = rows.get(group.key);
    if (!existing) {
      existing = { key: group.key, label: null, href: group.href, gmv: ZERO, bookingsCount: 0, bookingsValue: ZERO, earnings: ZERO };
      rows.set(group.key, existing);
    }
    if (group.label && !existing.label) existing.label = group.label;
    return existing;
  };

  for (const capture of captures) {
    for (const group of groupsOf(campaigns.get(capture.campaignId), by)) {
      const target = row(group);
      target.gmv = target.gmv.plus(capture.amount.times(group.share));
    }
  }
  for (const campaign of paidCampaigns) {
    for (const group of groupsOf(campaigns.get(campaign.id), by)) {
      const target = row(group);
      target.bookingsCount += 1;
      target.bookingsValue = target.bookingsValue.plus(campaign.total.times(group.share));
    }
  }
  // A package sale has no listing: it counts for its advertiser and its agent only.
  for (const sale of packages) {
    const group =
      by === 'advertiser'
        ? { key: sale.advertiserId, label: sale.advertiserName, href: hrefFor(by, sale.advertiserId) }
        : by === 'agent' && sale.agentId
          ? { key: sale.agentId, label: sale.agentName, href: hrefFor(by, sale.agentId) }
          : null;
    if (!group) continue;
    const target = row(group);
    target.bookingsCount += 1;
    target.bookingsValue = target.bookingsValue.plus(sale.total);
  }
  // An accrual is one spot's day: under a listing dimension it belongs to that
  // spot's listing, not to the booking's share of it.
  for (const accrual of accrualSpots) {
    const campaignId = spotOwners.get(accrual.campaignSpotId);
    const campaign = campaignId ? campaigns.get(campaignId) : undefined;
    if (!campaign) continue;
    let group: { key: string; label: string | null; href: string } | null;
    if (by === 'advertiser' || by === 'agent') {
      group = groupsOf(campaign, by)[0] ?? null;
    } else {
      const spot = campaign.spots.find((candidate) => candidate.id === accrual.campaignSpotId);
      const found = spot ? spotGroup(spot, by) : null;
      group = found ? { ...found, href: hrefFor(by, found.key) } : null;
    }
    if (!group) continue;
    const target = row(group);
    target.earnings = target.earnings.plus(accrual.net);
    if (!hasSpend) target.gmv = target.gmv.plus(accrual.gross);
  }
  return rows;
}

/**
 * The whole table for one window and dimension. G11-1: the previous window
 * of the same length is walked beside it — its facts read in the same pass,
 * the campaigns of both looked up once — so every row carries what it did
 * before and the GMV movement; the pair is cached together.
 */
async function loadBreakdown(query: Pick<BreakdownQuery, 'from' | 'to' | 'by'>): Promise<BreakdownRow[]> {
  const window = analyticsWindow(query.from, query.to);
  const { by } = query;
  const hasSpend = await repository.hasCampaignSpendLegs();
  const [current, previous] = await Promise.all([breakdownFacts(window, hasSpend, 'current'), breakdownFacts(window.previous, hasSpend, 'previous')]);
  const spotIds = [...current.accrualSpots, ...previous.accrualSpots].map((row) => row.campaignSpotId);
  const spotOwners = new Map((await repository.spotCampaigns(spotIds)).map((row) => [row.id, row.campaignId]));
  const campaignIds = [
    ...new Set([
      ...current.captures.map((c) => c.campaignId),
      ...current.paidCampaigns.map((c) => c.id),
      ...previous.captures.map((c) => c.campaignId),
      ...previous.paidCampaigns.map((c) => c.id),
      ...spotOwners.values(),
    ]),
  ];
  const campaigns = new Map((await repository.campaignsWithSpots(campaignIds)).map((campaign) => [campaign.id, campaign]));

  const rows = accumulateBreakdown(current, by, hasSpend, campaigns, spotOwners);
  const before = accumulateBreakdown(previous, by, hasSpend, campaigns, spotOwners);

  const totalGmv = [...rows.values()].reduce((sum, r) => sum.plus(r.gmv), ZERO);
  return [...rows.values()].map((r) => {
    const prior = before.get(r.key);
    return {
      key: r.key,
      label: r.label ?? r.key,
      href: r.href,
      gmvRecognised: money(r.gmv),
      bookingsCount: r.bookingsCount,
      bookingsValue: money(r.bookingsValue),
      publisherEarnings: money(r.earnings),
      sharePct: totalGmv.isZero() ? '0.00' : r.gmv.dividedBy(totalGmv).times(100).toFixed(2),
      previous: prior ? { gmvRecognised: money(prior.gmv), bookings: prior.bookingsCount } : null,
      deltaPct: prior ? deltaPct(r.gmv, prior.gmv) : null,
    };
  });
}

const moneyCompare = (a: Money, b: Money) => new Decimal(a).comparedTo(new Decimal(b));

const SORTERS: Record<BreakdownSort, (a: BreakdownRow, b: BreakdownRow) => number> = {
  GMV_DESC: (a, b) => moneyCompare(b.gmvRecognised, a.gmvRecognised),
  GMV_ASC: (a, b) => moneyCompare(a.gmvRecognised, b.gmvRecognised),
  BOOKINGS_DESC: (a, b) => b.bookingsCount - a.bookingsCount,
  BOOKINGS_ASC: (a, b) => a.bookingsCount - b.bookingsCount,
  VALUE_DESC: (a, b) => moneyCompare(b.bookingsValue, a.bookingsValue),
  VALUE_ASC: (a, b) => moneyCompare(a.bookingsValue, b.bookingsValue),
  EARNINGS_DESC: (a, b) => moneyCompare(b.publisherEarnings, a.publisherEarnings),
  EARNINGS_ASC: (a, b) => moneyCompare(a.publisherEarnings, b.publisherEarnings),
  LABEL_ASC: (a, b) => a.label.localeCompare(b.label),
  LABEL_DESC: (a, b) => b.label.localeCompare(a.label),
};

/**
 * GET /admin/overview/breakdown — the whole table is computed once per
 * window and dimension and cached a minute; sort, search and page are
 * applied on the way out, so flipping a column never walks the ledger again.
 * Ties break on the label so a page is stable between reads.
 */
export async function analyticsBreakdown(query: BreakdownQuery): Promise<ListPage<BreakdownRow>> {
  analyticsWindow(query.from, query.to);
  const table = await readThrough(breakdownCacheKey(query), ANALYTICS_CACHE_SECONDS, () => loadBreakdown(query));
  const needle = query.q?.trim().toLowerCase();
  const filtered = needle ? table.filter((r) => r.label.toLowerCase().includes(needle) || r.key.toLowerCase().includes(needle)) : [...table];
  const sorter = SORTERS[query.sort];
  filtered.sort((a, b) => sorter(a, b) || a.label.localeCompare(b.label));
  const { skip, take } = listArgs(query);
  return toListPage(filtered.slice(skip, skip + take), filtered.length, {}, query);
}

/* ── The tiles ────────────────────────────────────────────────────────────── */

export function tilesCacheKey(query: TilesQuery): string {
  return `admin-overview:tiles:${query.from}:${query.to}`;
}

/**
 * Fill rate: booked listing-days over available listing-days, over the
 * listings ACTIVE now, in the window.
 *
 *   available  Σ over ACTIVE listings of slotsTotal × the days of the window
 *              from the day the listing was published (a listing published
 *              mid-window is not available before it was)
 *   booked     Σ over BOOKED, LIVE or COMPLETED spots on those listings of
 *              quantity × the days of the spot's flight inside the window
 *
 * A spot's flight and a listing's day are the same calendar, so the ratio is
 * of like with like. Quantity is not capped at the slot count: an over-booked
 * screen reads over 100 %, which is the fact the tile is for.
 */
function fillRateOf(
  capacity: { slotsTotal: number; publishedAt: Date | null }[],
  spots: { startDate: Date; endDate: Date; quantity: number }[],
  fromIndex: number,
  toIndex: number,
): FillRate {
  let available = 0;
  for (const listing of capacity) {
    const first = Math.max(fromIndex, listing.publishedAt ? dayIndexOfInstant(listing.publishedAt) : fromIndex);
    available += Math.max(0, toIndex - first + 1) * Math.max(1, listing.slotsTotal);
  }
  let booked = 0;
  for (const spot of spots) {
    const first = Math.max(fromIndex, dayIndexOfDate(spot.startDate));
    const last = Math.min(toIndex, dayIndexOfDate(spot.endDate));
    booked += Math.max(0, last - first + 1) * Math.max(1, spot.quantity);
  }
  const pct = available === 0 ? '0.00' : new Decimal(booked).dividedBy(available).times(100).toFixed(2);
  return { pct, bookedListingDays: booked, availableListingDays: available };
}

async function loadTiles(query: TilesQuery): Promise<AnalyticsTiles> {
  const window = analyticsWindow(query.from, query.to);
  const now: Window = { start: window.start, end: window.end };
  const before = window.previous;
  const hasSpend = await repository.hasCampaignSpendLegs();
  const gmvOf = (w: Window) => (hasSpend ? repository.campaignSpend(w) : repository.accrualGross(w));
  const [gmvNow, gmvBefore, revenueNow, revenueBefore, campaignsNow, campaignsBefore, bookingsNow, bookingsBefore, kycPending, capacity, spotsNow, spotsBefore, publishedNow, publishedBefore] =
    await Promise.all([
      gmvOf(now),
      gmvOf(before),
      repository.platformRevenue(now),
      repository.platformRevenue(before),
      repository.activeCampaigns(now),
      repository.activeCampaigns(before),
      repository.bookingsAuthorised(now),
      repository.bookingsAuthorised(before),
      repository.kycPending(),
      repository.activeListingsCapacity(),
      repository.bookedSpots(now),
      repository.bookedSpots(before),
      repository.listingsPublished(now),
      repository.listingsPublished(before),
    ]);

  const takeRate = (revenue: Decimal, gmv: Decimal) => (gmv.isZero() ? '0.00' : revenue.dividedBy(gmv).times(100).toFixed(2));
  const takeNow = takeRate(revenueNow, gmvNow);
  const takeBefore = takeRate(revenueBefore, gmvBefore);
  const fillNow = fillRateOf(capacity, spotsNow, window.fromIndex, window.toIndex);
  const fillBefore = fillRateOf(capacity, spotsBefore, window.fromIndex - window.days, window.fromIndex - 1);

  return {
    from: query.from,
    to: query.to,
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    previousWindow: { start: before.start.toISOString(), end: before.end.toISOString() },
    gmvSource: hasSpend ? 'CAMPAIGN_SPEND' : 'ACCRUAL_GROSS',
    activeListings: { count: capacity.length, newInWindow: publishedNow, previousNewInWindow: publishedBefore, delta: publishedNow - publishedBefore },
    fillRate: { current: fillNow, previous: fillBefore, deltaPct: deltaPct(new Decimal(fillNow.pct), new Decimal(fillBefore.pct)) },
    gmvRecognised: compare(money(gmvNow), money(gmvBefore)),
    takeRatePct: { current: takeNow, previous: takeBefore, deltaPct: deltaPct(new Decimal(takeNow), new Decimal(takeBefore)) },
    platformRevenue: compare(money(revenueNow), money(revenueBefore)),
    bookingsAuthorised: compare(money(bookingsNow.campaigns.plus(bookingsNow.packages)), money(bookingsBefore.campaigns.plus(bookingsBefore.packages))),
    activeCampaigns: compare(campaignsNow, campaignsBefore),
    kycPending,
  };
}

/** GET /admin/overview/tiles — cached a minute keyed by the window. */
export async function analyticsTiles(query: TilesQuery): Promise<AnalyticsTiles> {
  analyticsWindow(query.from, query.to);
  return readThrough(tilesCacheKey(query), ANALYTICS_CACHE_SECONDS, () => loadTiles(query));
}
