import { readThrough } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { monthWindowIST } from '../../shared/time';
import { prismaAdminOverviewRepository as repository } from './prisma-admin-overview.repository';

/**
 * The console's month in numbers — Lot B (Q30/Q80).
 *
 * Two figures look alike and are kept apart on purpose:
 *
 *   bookingsAuthorised   what advertisers committed — Campaign.total by the
 *                        day it was paid, plus package sales paid in the month
 *   gmvRecognised        what actually left their wallets for media — the
 *                        CAMPAIGN_SPEND legs by the day they were posted,
 *                        which is the day the campaign started (B3a captures
 *                        the whole booking then)
 *
 * The take rate is ADX's revenue over the second. Revenue is recognised as
 * each day accrues (the commission leg on platform:revenue), so on a month
 * with many bookings captured and few days delivered it reads low, and on a
 * month delivering last month's bookings it reads high. That is the truth of
 * the books rather than a smoothing of it.
 */

export const OVERVIEW_CACHE_SECONDS = 60;
export const overviewCacheKey = (month: string) => `admin-overview:${month}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export type MonthOverview = {
  month: string;
  window: { start: string; end: string };
  bookingsAuthorised: Money;
  gmvRecognised: Money;
  /** Where the GMV figure came from — the spend legs, or the accrual until any exist. */
  gmvSource: 'CAMPAIGN_SPEND' | 'ACCRUAL_GROSS';
  platformRevenue: Money;
  /** platformRevenue over gmvRecognised, as a percentage with two decimals. "0.00" when there is no GMV. */
  takeRatePct: string;
  publisherEarnings: Money;
  activeCampaigns: number;
  newPublishers: number;
  newAdvertisers: number;
  kycPending: number;
  /** E6: how many bookings were paid in the month, and the mean value of one. */
  bookingsCount: number;
  averageBookingValue: Money;
};

/** E6: the series `?from=&to=` asks for. */
export type OverviewSeries = {
  from: string;
  to: string;
  months: MonthOverview[];
};

/** At most two years of months in one read: each month walks the ledger. */
export const MAX_SERIES_MONTHS = 24;

/** `YYYY-MM`, or the month it is now in India when nothing is given. */
export function parseMonth(raw: string | undefined, now = new Date()): { year: number; month: number } {
  if (raw === undefined || raw === '') {
    const shifted = new Date(now.getTime() + IST_OFFSET_MS);
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
  }
  const match = MONTH.exec(raw);
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', 'month must be YYYY-MM');
  return { year: Number(match[1]), month: Number(match[2]) };
}

const label = (year: number, month: number) => `${year}-${String(month).padStart(2, '0')}`;

async function load(year: number, month: number): Promise<MonthOverview> {
  const window = monthWindowIST(year, month);

  const [bookings, bookingsCount, spend, hasSpend, revenue, earnings, activeCampaigns, newPublishers, newAdvertisers, kycPending] =
    await Promise.all([
      repository.bookingsAuthorised(window),
      repository.bookingsCount(window),
      repository.campaignSpend(window),
      repository.hasCampaignSpendLegs(),
      repository.platformRevenue(window),
      repository.publisherEarnings(window),
      repository.activeCampaigns(window),
      repository.newPublishers(window),
      repository.newAdvertisers(window),
      repository.kycPending(),
    ]);

  // Until the first capture has been posted on this database there are no
  // spend legs anywhere, and the accrual's gross is the only record of media
  // delivered. Once one exists the legs are the answer, zero included.
  const gmvSource: MonthOverview['gmvSource'] = hasSpend ? 'CAMPAIGN_SPEND' : 'ACCRUAL_GROSS';
  const gmv = new Decimal(hasSpend ? spend : await repository.accrualGross(window));
  const platformRevenue = new Decimal(revenue);
  const takeRate = gmv.isZero() ? new Decimal(0) : platformRevenue.dividedBy(gmv).times(100);
  const bookingsAuthorised = new Decimal(bookings.campaigns).plus(bookings.packages);

  return {
    month: label(year, month),
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    bookingsAuthorised: money(bookingsAuthorised),
    gmvRecognised: money(gmv),
    gmvSource,
    platformRevenue: money(platformRevenue),
    takeRatePct: takeRate.toFixed(2),
    publisherEarnings: money(earnings),
    activeCampaigns,
    newPublishers,
    newAdvertisers,
    kycPending,
    bookingsCount,
    averageBookingValue: money(bookingsCount === 0 ? 0 : bookingsAuthorised.dividedBy(bookingsCount)),
  };
}

/**
 * E6: `?from=YYYY-MM&to=YYYY-MM` — the single-month read for every month in
 * the range, oldest first, each through the same minute cache. `to` before
 * `from` is a 400, as is a span past `MAX_SERIES_MONTHS`.
 */
export async function overviewSeries(fromRaw: string, toRaw: string, now = new Date()): Promise<OverviewSeries> {
  const from = parseMonth(fromRaw, now);
  const to = parseMonth(toRaw, now);
  const span = (to.year - from.year) * 12 + (to.month - from.month) + 1;
  if (span < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'to must not be before from');
  if (span > MAX_SERIES_MONTHS) {
    throw new ApiError(400, 'VALIDATION_ERROR', `At most ${MAX_SERIES_MONTHS} months in one read`);
  }
  const months: MonthOverview[] = [];
  for (let index = 0; index < span; index += 1) {
    const offset = from.month - 1 + index;
    const year = from.year + Math.floor(offset / 12);
    const month = (offset % 12) + 1;
    months.push(await monthOverview(label(year, month), now));
  }
  return { from: label(from.year, from.month), to: label(to.year, to.month), months };
}

/** Cached a minute per month: the console polls this, and the sums walk the ledger. */
export async function monthOverview(raw: string | undefined, now = new Date()): Promise<MonthOverview> {
  const { year, month } = parseMonth(raw, now);
  return readThrough(overviewCacheKey(label(year, month)), OVERVIEW_CACHE_SECONDS, () => load(year, month));
}
