import { Decimal, ZERO } from '../../../shared/money';
import type { AnalyticsFilter, Window } from '../admin-overview.repository';
import { prismaAdminOverviewRepository as repository } from '../prisma-admin-overview.repository';
import { dayIndexOfDate, dayIndexOfInstant, hasListingFilter, inCity, shareOf } from '../analytics.service';
import type { DailyPoint } from './metric.types';

/**
 * AN-1: where each metric's days come from.
 *
 * One pass over the facts fills every metric at once, because the ledger and
 * the accrual table are expensive to walk and a bucket asking for six metrics
 * should not walk them six times. The result is a map of metric key to its
 * daily points, which `rollup.ts` then buckets by whatever grain was asked
 * for.
 *
 * The placement rules here are lifted from `loadSeries` rather than rewritten:
 * the same `dayIndexOf*`, the same `shareOf` apportioning of a campaign's
 * capture across the spots a filter selected, the same `inCity`. A parity
 * test asserts the two agree, and they can only agree if there is one copy of
 * each rule.
 */

export type DailyByMetric = Map<string, DailyPoint[]>;

/**
 * The accumulator: metric → day → point.
 *
 * Keyed by day rather than scanned for it. The first version held an array
 * per metric and found the day with `.find()`, which is O(days) per insert —
 * fine against a handful of listings and quadratic against a real estate.
 * `availableSlotDays` alone writes one point per live listing per day, so a
 * year's window over a few thousand listings is millions of inserts each
 * scanning hundreds of entries. A Map makes every insert constant.
 */
type Accumulator = Map<string, Map<number, DailyPoint>>;

/** Add `value` to a metric's day, creating the day if it is the first thing there. */
function add(into: Accumulator, key: string, day: number, value: Decimal, weight?: Decimal): void {
  let days = into.get(key);
  if (!days) {
    days = new Map<number, DailyPoint>();
    into.set(key, days);
  }
  const existing = days.get(day);
  if (existing) {
    existing.value = existing.value.plus(value);
    if (weight !== undefined) existing.weight = (existing.weight ?? ZERO).plus(weight);
    return;
  }
  days.set(day, { day, value, ...(weight === undefined ? {} : { weight }) });
}

/** The accumulator as the roll-up wants it: one array per metric, in day order. */
function settle(accumulated: Accumulator): DailyByMetric {
  const out: DailyByMetric = new Map();
  for (const [key, days] of accumulated) {
    out.set(key, [...days.values()].sort((a, b) => a.day - b.day));
  }
  return out;
}

const one = new Decimal(1);

/**
 * Every metric's days over a span.
 *
 * `span` is the whole range to load, which for a windowed read is the
 * previous window's start to the current window's end — one walk, split by
 * day afterwards, exactly as `loadSeries` does it.
 */
export async function loadDailyMetrics(span: Window, filter: AnalyticsFilter): Promise<DailyByMetric> {
  const out: Accumulator = new Map();

  const hasSpend = await repository.hasCampaignSpendLegs();
  const [captures, paidCampaigns, packages, accrualDays, incentives, publishers, advertisers, agents, capacity, bookedSpots, revenue] =
    await Promise.all([
    hasSpend ? repository.campaignCaptures(span) : Promise.resolve([]),
    repository.paidCampaigns(span),
    repository.paidPackageSales(span),
    repository.accrualByDay(span, filter),
    repository.creditedIncentives(span),
    repository.onboardedPublishers(span),
    repository.onboardedAdvertisers(span),
    repository.activatedAgents(span),
    repository.activeListingsCapacity(),
    repository.bookedSpots(span),
    repository.platformRevenueByDay(span),
  ]);

  const campaignIds = [...new Set([...captures.map((c) => c.campaignId), ...paidCampaigns.map((c) => c.id)])];
  const campaigns = new Map((await repository.campaignsWithSpots(campaignIds)).map((campaign) => [campaign.id, campaign]));

  /* GMV — the platform-side legs, apportioned to the spots the filter kept. */
  for (const capture of captures) {
    const share = shareOf(campaigns.get(capture.campaignId), filter);
    if (share.isZero()) continue;
    const day = dayIndexOfInstant(capture.occurredAt);
    const amount = capture.amount.times(share);
    add(out, 'gmvRecognised', day, amount);
    add(out, 'advertiserSpend', day, amount);
  }

  /* The accruals: gross, commission, tax and net, all on the day they accrued.
     Gross doubles as GMV until any CAMPAIGN_SPEND leg exists, which is the
     `gmvSource` fallback the overview already documents. */
  for (const accrual of accrualDays) {
    const day = dayIndexOfDate(accrual.forDate);
    add(out, 'publisherEarnings', day, accrual.net);
    add(out, 'accrualGross', day, accrual.gross);
    /* Tolerated rather than required: a repository that predates the widened
       fact answers the two metrics as zero instead of throwing. */
    add(out, 'accrualCommission', day, accrual.commission ?? ZERO);
    add(out, 'taxWithheld', day, accrual.taxWithheld ?? ZERO);
    if (!hasSpend) {
      add(out, 'gmvRecognised', day, accrual.gross);
      add(out, 'advertiserSpend', day, accrual.gross);
    }
  }

  /* Bookings authorised: the moment an advertiser pressed pay. */
  for (const campaign of paidCampaigns) {
    const share = shareOf(campaigns.get(campaign.id), filter);
    if (share.isZero()) continue;
    const day = dayIndexOfInstant(campaign.paidAt);
    add(out, 'bookingsCount', day, one);
    add(out, 'bookingsValue', day, campaign.total.times(share));
  }

  /* A package is not bought against a spot, so a listing filter drops it. */
  if (!hasListingFilter(filter)) {
    for (const sale of packages) {
      if (filter.agentAssisted && !sale.agentId) continue;
      const day = dayIndexOfInstant(sale.paidAt);
      add(out, 'bookingsCount', day, one);
      add(out, 'bookingsValue', day, sale.total);
      add(out, 'packageSales', day, sale.total);
      add(out, 'advertiserSpend', day, sale.total);
    }
  }

  /* AN-3: what ADX kept, on the day it kept it. Reversals are negative legs
     and net themselves off, which is why this sums rather than counts. */
  for (const movement of revenue) {
    add(out, 'platformRevenue', dayIndexOfInstant(movement.occurredAt), movement.amount);
  }

  for (const incentive of incentives) {
    if (!inCity({ city: incentive.agentCity, cityId: incentive.agentCityId }, filter)) continue;
    add(out, 'agentCommissions', dayIndexOfInstant(incentive.verifiedAt), incentive.amount);
  }

  const onboard = (rows: readonly { at: Date; city: string | null; cityId: string | null }[], key: string) => {
    for (const row of rows) {
      if (!inCity(row, filter)) continue;
      const day = dayIndexOfInstant(row.at);
      add(out, key, day, one);
      if (key !== 'agentsActivated') add(out, 'accountsOnboarded', day, one);
    }
  };
  onboard(publishers, 'publishersOnboarded');
  onboard(advertisers, 'advertisersOnboarded');
  onboard(agents, 'agentsActivated');

  /* Inventory. The arithmetic is the fill-rate tile's, per day rather than
     per window: a listing contributes its slots for every day it was live,
     and a spot contributes its quantity for every flight-day. Quantity is
     deliberately not capped — an over-booked screen reads above 100 %. */
  const spanFrom = dayIndexOfInstant(span.start);
  const spanTo = dayIndexOfInstant(span.end) - 1;
  for (const listing of capacity) {
    const slots = new Decimal(Math.max(1, listing.slotsTotal));
    const first = Math.max(spanFrom, listing.publishedAt ? dayIndexOfInstant(listing.publishedAt) : spanFrom);
    for (let day = first; day <= spanTo; day += 1) add(out, 'availableSlotDays', day, slots);
  }
  for (const spot of bookedSpots) {
    const quantity = new Decimal(Math.max(1, spot.quantity));
    const first = Math.max(spanFrom, dayIndexOfDate(spot.startDate));
    const last = Math.min(spanTo, dayIndexOfDate(spot.endDate));
    for (let day = first; day <= last; day += 1) add(out, 'bookedSlotDays', day, quantity);
  }

  return settle(out);
}

/** The days of one metric over a span, empty when nothing happened. */
export const daysOf = (daily: DailyByMetric, key: string): readonly DailyPoint[] => daily.get(key) ?? [];
