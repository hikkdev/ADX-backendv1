import { ApiError } from '../../shared/errors';
import { prismaListingsRepository as repository } from './prisma-listings.repository';
import { blockedDays, dailyHolds, dayKey, dayNumber, type SlotWindow } from './slot-holds';

/**
 * AV-1 (the owner, 27 Sep 2026) — what an advertiser sees when some dates
 * of a space are booked and the rest are free. `GET /listings/:id/availability`
 * answers every day of a range with how many slots are held and left and
 * whether the publisher blocked it; the first free day; and — asked for a
 * length and a quantity — the earliest run of that many days with room,
 * which is the "try these dates instead" the listing page and a clash
 * offer. Public, like the listing page it sits on: counts only, never who
 * booked.
 */

export const MAX_RANGE_DAYS = 186;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AvailabilityDay = { date: string; held: number; left: number; blocked: boolean };
export type Availability = {
  listingId: string;
  slotsTotal: number;
  from: string;
  to: string;
  days: AvailabilityDay[];
  /** The first day in the range with room for `quantity`; null when none. */
  nextFreeDate: string | null;
  /** Asked for a length: the earliest run of `length` days, all with room for `quantity`; null when none fits in the range. */
  nextFit: { from: string; to: string } | null;
  /** Of the range, how many days have room for `quantity`. */
  freeDays: number;
};

/** The earliest run of `length` consecutive days whose `left` all reach `quantity`. */
export function earliestFit(days: readonly AvailabilityDay[], length: number, quantity: number): { from: string; to: string } | null {
  if (length < 1) return null;
  let run = 0;
  for (let index = 0; index < days.length; index += 1) {
    run = days[index]!.left >= quantity ? run + 1 : 0;
    if (run === length) return { from: days[index - length + 1]!.date, to: days[index]!.date };
  }
  return null;
}

/** The per-day picture over a window, from the holds — pure, for the tests. */
export function availabilityOf(
  listing: { id: string; slotsTotal: number },
  holds: Parameters<typeof dailyHolds>[0],
  window: SlotWindow,
  ask: { length?: number | undefined; quantity?: number | undefined } = {},
): Availability {
  const quantity = Math.max(1, ask.quantity ?? 1);
  const held = dailyHolds(holds, window);
  const blocked = blockedDays(holds, window);
  const first = dayNumber(window.from);
  const days = held.map((count, index) => ({
    date: dayKey(first + index),
    held: Math.min(count, listing.slotsTotal),
    left: Math.max(0, listing.slotsTotal - count),
    blocked: blocked[index] ?? false,
  }));
  const free = days.filter((day) => day.left >= quantity);
  return {
    listingId: listing.id,
    slotsTotal: listing.slotsTotal,
    from: days[0]?.date ?? dayKey(first),
    to: days[days.length - 1]?.date ?? dayKey(first),
    days,
    nextFreeDate: free[0]?.date ?? null,
    nextFit: ask.length ? earliestFit(days, ask.length, quantity) : null,
    freeDays: free.length,
  };
}

/** `YYYY-MM-DD` → the UTC day's first and last instant. */
function dayBounds(from: string, to: string): SlotWindow {
  return { from: new Date(`${from}T00:00:00.000Z`), to: new Date(`${to}T23:59:59.999Z`) };
}

export async function listingAvailability(
  listingId: string,
  query: { from?: string | undefined; to?: string | undefined; length?: number | undefined; quantity?: number | undefined },
  now = new Date(),
): Promise<Availability> {
  const listing = (await repository.findActiveById(listingId)) ?? (/^LST-/i.test(listingId) ? await repository.findActiveByDisplayId(listingId) : null);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'That spot is not available');
  const today = dayKey(dayNumber(now));
  const from = query.from ?? today;
  const to = query.to ?? dayKey(dayNumber(new Date(`${from}T00:00:00.000Z`)) + 89);
  const window = dayBounds(from, to);
  const span = dayNumber(window.to) - dayNumber(window.from) + 1;
  if (span < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'The end date comes before the start date.');
  if (span > MAX_RANGE_DAYS) throw new ApiError(400, 'VALIDATION_ERROR', `Ask for at most ${MAX_RANGE_DAYS} days at a time.`, { maxDays: MAX_RANGE_DAYS });
  const slotsTotal = Math.max(1, listing.slotsTotal ?? 1);
  const holds = await repository.datedHolds([listing.id], window);
  return availabilityOf({ id: listing.id, slotsTotal }, holds, window, { length: query.length, quantity: Math.min(query.quantity ?? 1, slotsTotal) });
}

export { DAY_MS };
