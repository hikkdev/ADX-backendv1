import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { dayWindowISTFor } from '../../shared/time';
import { RECORD_HISTORY_TAKE, type InsightDayRow, type InsightLifetimeRow, type InsightMetric } from './listing-desk.repository';
import { coverFirst, coverPhotoUrlOf } from './photos';
import { prismaListingDeskRepository as desk } from './prisma-listing-desk.repository';
import { blockedDays, dailyHolds, type DatedHold } from './slot-holds';
import { carriesLoop } from './slots.service';

/**
 * The console's listing page (3 Oct 2026) — the record and its performance.
 *
 * The owner, looking at a listing: "I don't see any analytical stats for
 * every listing, there's no description data, there's no data on footfall
 * and other information that we are seeking from every listing", and then:
 * "I need to see everything what we store on a listing."
 *
 * Both reads are the desk's (ADMIN, `supply.view`). A publisher's PATCH
 * still answers `getListingForAdmin`'s narrow view; nothing here reaches a
 * read a non-admin can call.
 */

/* ── The record ───────────────────────────────────────────────────── */

type Named = { id: string; name: string | null } | null;

/**
 * Every column of the listing and every row hanging off it, shaped for the
 * page:
 *  - the site QR's token never leaves (it is what an installer's scan is
 *    checked against) — `hasSiteQr` says whether the spot has one;
 *  - the photographs cover first, each with the upload register's capture
 *    stamp (GC-1) when the camera kept one;
 *  - every bare user id (who suspended, who decided a factor or a price,
 *    who blocked the dates) named, from one lookup;
 *  - the custom fields Settings › Custom fields asks of a listing, and the
 *    sponsored placements bought for it;
 *  - `counts`: how many rows each history holds, beside the latest few.
 */
export async function getListingRecordForAdmin(listingId: string) {
  const row = await desk.findRecordForAdmin(listingId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'No such listing');
  const { qrToken, _count, ...listing } = row;

  const userIds = [
    row.suspendedById,
    ...row.pricingFactors.map((factor) => factor.decidedById),
    ...row.priceApprovals.flatMap((approval) => [approval.requestedById, approval.decidedById]),
    ...row.blockedDates.map((block) => block.createdById),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  const [people, stamps, customFields, boosts] = await Promise.all([
    desk.userNamesById(userIds),
    desk.photoStamps(row.photos.map((photo) => ({ url: photo.url, uploadedFileId: photo.uploadedFileId }))),
    desk.customFieldValuesFor(listingId),
    desk.boostsFor(listingId, RECORD_HISTORY_TAKE),
  ]);
  const names = new Map(people.map((person) => [person.id, person.name]));
  const named = (id: string | null): Named => (id ? { id, name: names.get(id) ?? null } : null);
  const stampById = new Map(stamps.map((stamp) => [stamp.id, stamp]));
  const stampByUrl = new Map(stamps.map((stamp) => [stamp.url, stamp]));

  return {
    ...listing,
    carriesLoop: carriesLoop({ subType: row.subType, mediaType: row.mediaType }),
    hasSiteQr: Boolean(qrToken),
    coverPhotoUrl: coverPhotoUrlOf(row.photos),
    photos: coverFirst(row.photos).map((photo) => {
      const stamp = (photo.uploadedFileId ? stampById.get(photo.uploadedFileId) : undefined) ?? stampByUrl.get(photo.url);
      return {
        ...photo,
        // LD-1: the photograph's own capture time first (filed with it), the register's otherwise.
        takenAt: photo.takenAt ?? stamp?.takenAt ?? null,
        // A fix only when the camera's stamp was on; an unstamped file's columns are not a place.
        gps:
          stamp?.geoStamped && typeof stamp.latitude === 'number' && typeof stamp.longitude === 'number'
            ? { latitude: stamp.latitude, longitude: stamp.longitude, accuracyM: stamp.accuracyM }
            : null,
      };
    }),
    suspendedBy: named(row.suspendedById),
    pricingFactors: row.pricingFactors.map((factor) => ({ ...factor, decidedBy: named(factor.decidedById) })),
    priceApprovals: row.priceApprovals.map((approval) => ({
      ...approval,
      requestedBy: named(approval.requestedById),
      decidedBy: named(approval.decidedById),
    })),
    blockedDates: row.blockedDates.map((block) => ({ ...block, createdBy: named(block.createdById) })),
    customFields,
    // LM-1: the sponsored placements bought for the spot (its own desk is Ads › Sponsored).
    boosts: boosts.items,
    counts: { ..._count, boosts: boosts.total },
  };
}

export type ListingRecordForAdmin = Awaited<ReturnType<typeof getListingRecordForAdmin>>;

/* ── The insights ─────────────────────────────────────────────────── */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const INSIGHTS_DEFAULT_DAYS = 30;
export const INSIGHTS_MAX_DAYS = 366;

const isoOf = (date: Date): string => date.toISOString().slice(0, 10);
const todayIst = (now: Date): string => isoOf(new Date(now.getTime() + IST_OFFSET_MS));
const shiftDay = (iso: string, days: number): string => isoOf(new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY_MS));
const istDayOf = (instant: Date): string => isoOf(new Date(instant.getTime() + IST_OFFSET_MS));

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/** The overviews' shapes, so the console draws a listing with the same tiles and chart. */
export type Figure = { value: number; previous: number | null; delta: number | null };
export type MoneyFigure = { value: Money; previous: Money | null; delta: Money | null };
export type DayPoint = { day: string; value: number };
export type MoneyDayPoint = { day: string; value: Money };
export type Series = { days: DayPoint[]; previous: DayPoint[]; total: Figure };
export type MoneySeries = { days: MoneyDayPoint[]; previous: MoneyDayPoint[]; total: MoneyFigure };
/** Booked slot-days over the slot-days the spot was on the market and not blocked; `rate` 0..1, null with nothing available. */
export type Occupancy = { bookedSlotDays: number; availableSlotDays: number; rate: number | null };

export type InsightWindow = {
  from: string;
  to: string;
  days: string[];
  previousFrom: string;
  previousTo: string;
  previousDays: string[];
  /** `[start, end)` from the previous window's first instant to this one's last — the one read's span. */
  span: { start: Date; end: Date };
  /** Where this window's instants begin — a row before it belongs to the previous window. */
  start: Date;
};

/**
 * `from`/`to` are inclusive Indian days; absent, the last thirty ending
 * today. The previous window is the same number of days before. The
 * overviews' rule, and their ceiling of a year.
 */
export function resolveInsightWindow(query: { from?: string; to?: string }, now = new Date()): InsightWindow {
  const to = query.to ?? todayIst(now);
  const from = query.from ?? shiftDay(to, -(INSIGHTS_DEFAULT_DAYS - 1));
  if (to < from) throw new ApiError(400, 'VALIDATION_ERROR', 'to must not be before from');
  const days = daysBetween(from, to);
  if (days.length > INSIGHTS_MAX_DAYS) throw new ApiError(400, 'VALIDATION_ERROR', `At most ${INSIGHTS_MAX_DAYS} days in one read`);
  const previousTo = shiftDay(from, -1);
  const previousFrom = shiftDay(from, -days.length);
  const start = dayWindowISTFor(from).start;
  return {
    from,
    to,
    days,
    previousFrom,
    previousTo,
    previousDays: daysBetween(previousFrom, previousTo),
    span: { start: dayWindowISTFor(previousFrom).start, end: dayWindowISTFor(to).end },
    start,
  };
}

const figure = (value: number, previous: number): Figure => ({ value, previous, delta: value - previous });
const moneyFigure = (value: Decimal, previous: Decimal): MoneyFigure => ({
  value: money(value),
  previous: money(previous),
  delta: money(value.minus(previous)),
});

/** One metric's rows as a count series over the two windows. */
function countSeries(rows: readonly InsightDayRow[], metric: InsightMetric, window: InsightWindow): Series {
  const byDay = new Map(rows.filter((row) => row.metric === metric).map((row) => [row.day, row.count]));
  const days = window.days.map((day) => ({ day, value: byDay.get(day) ?? 0 }));
  const previous = window.previousDays.map((day) => ({ day, value: byDay.get(day) ?? 0 }));
  const sum = (points: DayPoint[]) => points.reduce((acc, point) => acc + point.value, 0);
  return { days, previous, total: figure(sum(days), sum(previous)) };
}

/** One metric's sums as a money series over the two windows. */
function moneySeries(rows: readonly InsightDayRow[], metric: InsightMetric, window: InsightWindow): MoneySeries {
  const byDay = new Map(rows.filter((row) => row.metric === metric).map((row) => [row.day, new Decimal(row.sum ?? 0)]));
  const at = (day: string) => byDay.get(day) ?? new Decimal(0);
  const days = window.days.map((day) => ({ day, value: money(at(day)) }));
  const previous = window.previousDays.map((day) => ({ day, value: money(at(day)) }));
  const sum = (list: readonly string[]) => list.reduce((acc, day) => acc.plus(at(day)), new Decimal(0));
  return { days, previous, total: moneyFigure(sum(window.days), sum(window.previousDays)) };
}

/** The published reviews' average over some days, two places; null with none. */
function averageOver(rows: readonly InsightDayRow[], days: readonly string[]): { average: string | null; count: number } {
  const wanted = new Set(days);
  let count = 0;
  let stars = new Decimal(0);
  for (const row of rows) {
    if (row.metric !== 'reviews' || !wanted.has(row.day)) continue;
    count += row.count;
    stars = stars.plus(row.sum ?? 0);
  }
  return { average: count > 0 ? stars.dividedBy(count).toFixed(2) : null, count };
}

/**
 * Occupancy over inclusive days: on each day the spot was on the market
 * (published, not blocked by the publisher), the slots it offered and the
 * slots bookings held — never more than it has. Reservations are not
 * bookings and do not count. `perDay` is the booked slots each day, zero
 * where the spot was off the market.
 */
export function occupancyOver(
  holds: readonly DatedHold[],
  slotsTotal: number,
  days: readonly string[],
  onMarketFrom: string | null,
): Occupancy & { perDay: number[] } {
  const slots = Math.max(1, slotsTotal);
  if (days.length === 0) return { bookedSlotDays: 0, availableSlotDays: 0, rate: null, perDay: [] };
  const window = { from: new Date(`${days[0]}T00:00:00.000Z`), to: new Date(`${days[days.length - 1]}T00:00:00.000Z`) };
  const booked = dailyHolds(holds.filter((hold) => !hold.blocked), window);
  const blocked = blockedDays(holds, window);
  let bookedSlotDays = 0;
  let availableSlotDays = 0;
  const perDay = days.map((day, index) => {
    if (onMarketFrom === null || day < onMarketFrom || blocked[index]) return 0;
    const held = Math.min(slots, booked[index] ?? 0);
    availableSlotDays += slots;
    bookedSlotDays += held;
    return held;
  });
  return { bookedSlotDays, availableSlotDays, rate: availableSlotDays > 0 ? bookedSlotDays / availableSlotDays : null, perDay };
}

const lifetimeOf = (rows: readonly InsightLifetimeRow[], metric: InsightMetric) => rows.find((row) => row.metric === metric);
const lifetimeCount = (rows: readonly InsightLifetimeRow[], metric: InsightMetric): number => lifetimeOf(rows, metric)?.count ?? 0;
const lifetimeMoney = (rows: readonly InsightLifetimeRow[], metric: InsightMetric): Money => money(lifetimeOf(rows, metric)?.sum ?? 0);

/**
 * What the platform does not record, said rather than drawn as a zero.
 * LD-1 (3 Oct 2026): spot-page views are recorded now (`views`,
 * `uniqueVisitors`), so nothing is left on this list; the key stays so a
 * client that reads it keeps working.
 */
export const UNTRACKED_INSIGHTS: readonly { metric: string; label: string; reason: string }[] = [];

/**
 * `GET /listings/:listingId/insights?from=&to=` — the window against the
 * same number of days before it, the listing's whole life, and the day
 * series, all over aggregate reads:
 *
 *  - saves (advertisers' hearts), bookings (orders past DRAFT) and their
 *    booked value (the campaign line behind each order);
 *  - scans, clicks, enquiries (form submits) and landing-page views — the
 *    tracking events of the codes on campaigns that ran here;
 *  - GMV: the accruals' gross on the days they accrued;
 *  - occupancy: booked slot-days over available slot-days;
 *  - the published reviews in the window, beside the listing's own stars;
 *  - LD-1: the spot page's views and unique visitors (a window's or a
 *    life's visitors are the days' visitors summed — one person on three
 *    days is three).
 */
export async function listingInsights(listingId: string, query: { from?: string; to?: string }, now = new Date()) {
  const facts = await desk.insightFacts(listingId);
  if (!facts) throw new ApiError(404, 'NOT_FOUND', 'No such listing');
  const window = resolveInsightWindow(query, now);
  const today = todayIst(now);
  const onMarketFrom = facts.publishedAt ? istDayOf(facts.publishedAt) : null;
  // One holds read covers both windows and the whole life.
  const holdsFrom = onMarketFrom && onMarketFrom < window.previousFrom ? onMarketFrom : window.previousFrom;
  const holdsTo = window.to > today ? window.to : today;

  const [rows, lifetime, holds] = await Promise.all([
    desk.insightDays(listingId, window.span, { fromDay: window.previousFrom, toDay: window.to }),
    desk.insightLifetime(listingId),
    desk.occupancyHolds(listingId, { from: new Date(`${holdsFrom}T00:00:00.000Z`), to: new Date(`${holdsTo}T00:00:00.000Z`) }),
  ]);

  const current = occupancyOver(holds, facts.slotsTotal, window.days, onMarketFrom);
  const previous = occupancyOver(holds, facts.slotsTotal, window.previousDays, onMarketFrom);
  const life = onMarketFrom ? occupancyOver(holds, facts.slotsTotal, daysBetween(onMarketFrom, today), onMarketFrom) : null;
  const occupied: Series = {
    days: window.days.map((day, index) => ({ day, value: current.perDay[index] ?? 0 })),
    previous: window.previousDays.map((day, index) => ({ day, value: previous.perDay[index] ?? 0 })),
    total: figure(current.bookedSlotDays, previous.bookedSlotDays),
  };
  const strip = ({ bookedSlotDays, availableSlotDays, rate }: Occupancy): Occupancy => ({ bookedSlotDays, availableSlotDays, rate });

  const series = {
    saves: countSeries(rows, 'saves', window),
    bookings: countSeries(rows, 'bookings', window),
    enquiries: countSeries(rows, 'enquiries', window),
    scans: countSeries(rows, 'scans', window),
    clicks: countSeries(rows, 'clicks', window),
    landingViews: countSeries(rows, 'landingViews', window),
    reviews: countSeries(rows, 'reviews', window),
    occupiedSlots: occupied,
    bookedValue: moneySeries(rows, 'bookedValue', window),
    gmv: moneySeries(rows, 'gmv', window),
    views: countSeries(rows, 'views', window),
    uniqueVisitors: countSeries(rows, 'uniqueVisitors', window),
  };

  return {
    listingId,
    from: window.from,
    to: window.to,
    previousFrom: window.previousFrom,
    previousTo: window.previousTo,
    slotsTotal: facts.slotsTotal,
    onMarketFrom,
    window: {
      saves: series.saves.total,
      bookings: series.bookings.total,
      enquiries: series.enquiries.total,
      scans: series.scans.total,
      clicks: series.clicks.total,
      landingViews: series.landingViews.total,
      bookedValue: series.bookedValue.total,
      gmv: series.gmv.total,
      views: series.views.total,
      uniqueVisitors: series.uniqueVisitors.total,
      occupancy: { current: strip(current), previous: strip(previous) },
      rating: { current: averageOver(rows, window.days), previous: averageOver(rows, window.previousDays) },
    },
    lifetime: {
      saves: lifetimeCount(lifetime, 'saves'),
      bookings: lifetimeCount(lifetime, 'bookings'),
      enquiries: lifetimeCount(lifetime, 'enquiries'),
      scans: lifetimeCount(lifetime, 'scans'),
      clicks: lifetimeCount(lifetime, 'clicks'),
      landingViews: lifetimeCount(lifetime, 'landingViews'),
      bookedValue: lifetimeMoney(lifetime, 'bookedValue'),
      gmv: lifetimeMoney(lifetime, 'gmv'),
      views: lifetimeCount(lifetime, 'views'),
      uniqueVisitors: lifetimeCount(lifetime, 'uniqueVisitors'),
      occupancy: life ? strip(life) : { bookedSlotDays: 0, availableSlotDays: 0, rate: null },
      // The listing's own stars — denormalised on every review write (Lot D).
      rating: { average: facts.ratingAvg === null ? null : new Decimal(facts.ratingAvg).toFixed(2), count: facts.reviewCount },
    },
    series,
    untracked: UNTRACKED_INSIGHTS.map((entry) => ({ ...entry })),
  };
}

export type ListingInsights = Awaited<ReturnType<typeof listingInsights>>;
