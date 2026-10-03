import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';

/**
 * LM-1 — the arithmetic of a paid placement, pure.
 *
 * Dates are whole UTC days: `startDate` / `endDate` are the first and the
 * LAST day at 00:00Z (the AV-1 convention in `listings/slot-holds.ts`), so a
 * booking of 12–18 October is seven days. Price is a flat rate per day,
 * summed over the days (and, for a boost, over its placements), plus GST at
 * the platform's media rate. Capacity is counted per day: the busiest day of
 * the window decides, so two bookings that never run on the same day never
 * add up.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest window an availability read or a booking may span. */
export const MAX_WINDOW_DAYS = 186;
/** How far ahead a booking may start. */
export const MAX_LEAD_DAYS = 365;

/** "2026-10-12" → that day at 00:00Z. 400 on anything else. */
export function parseDay(value: string, field = 'date'): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a date like 2026-10-12`);
  const day = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) throw new ApiError(400, 'VALIDATION_ERROR', `${field} is not a real date`);
  return day;
}

export const dayNumber = (instant: Date): number => Math.floor(instant.getTime() / DAY_MS);
export const dayKey = (instant: Date): string => instant.toISOString().slice(0, 10);
export const fromDayNumber = (day: number): Date => new Date(day * DAY_MS);
/** Today's UTC day at 00:00Z. */
export const today = (now = new Date()): Date => fromDayNumber(dayNumber(now));
export const addDays = (day: Date, count: number): Date => new Date(day.getTime() + count * DAY_MS);

/** Days from the first to the last, both counted. */
export function daysBetween(start: Date, end: Date): number {
  return dayNumber(end) - dayNumber(start) + 1;
}

/**
 * The dates a buyer asked for, checked: the end on or after the start, the
 * start not in the past (today is allowed), no further out than a year, no
 * longer than the window, at least `minDays`.
 */
export function checkDates(start: Date, end: Date, options: { minDays: number; now?: Date; allowPast?: boolean }): number {
  const days = daysBetween(start, end);
  if (days < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'The end date must be on or after the start date');
  const first = today(options.now);
  if (!options.allowPast && dayNumber(start) < dayNumber(first)) throw new ApiError(400, 'VALIDATION_ERROR', 'The start date has passed — pick today or later');
  if (dayNumber(start) - dayNumber(first) > MAX_LEAD_DAYS) throw new ApiError(400, 'VALIDATION_ERROR', `A booking may start at most ${MAX_LEAD_DAYS} days ahead`);
  if (days > MAX_WINDOW_DAYS) throw new ApiError(400, 'VALIDATION_ERROR', `A booking runs at most ${MAX_WINDOW_DAYS} days`);
  if (days < options.minDays) throw new ApiError(400, 'VALIDATION_ERROR', `This placement is sold for at least ${options.minDays} day${options.minDays === 1 ? '' : 's'}`, { minDays: options.minDays });
  return days;
}

export type Quote = { days: number; subtotal: Money; gstPct: string; gstAmount: Money; total: Money };

/**
 * Rate × days (summed over every rate — one per boost placement), then GST
 * on the subtotal at `gstFraction` (0.18), each to the paisa.
 */
export function quoteFor(ratesPerDay: readonly (Decimal | string | number)[], days: number, gstFraction: Decimal | string | number): Quote {
  const perDay = ratesPerDay.reduce<Decimal>((sum, rate) => sum.plus(new Decimal(String(rate))), new Decimal(0));
  const subtotal = perDay.times(days).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const fraction = new Decimal(String(gstFraction));
  const gst = subtotal.times(fraction).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { days, subtotal: money(subtotal), gstPct: fraction.times(100).toDecimalPlaces(2).toString(), gstAmount: money(gst), total: money(subtotal.plus(gst)) };
}

/** A booking that holds capacity, by its dates. */
export type DatedHold = { startDate: Date; endDate: Date };

/** How many holds cover each day of the window — index 0 is `from`. */
export function perDayCounts(holds: readonly DatedHold[], from: Date, to: Date): number[] {
  const first = dayNumber(from);
  const last = dayNumber(to);
  const length = Math.max(0, last - first + 1);
  const diff = new Array<number>(length + 1).fill(0);
  for (const hold of holds) {
    const start = Math.max(first, dayNumber(hold.startDate));
    const end = Math.min(last, dayNumber(hold.endDate));
    if (end < start) continue;
    diff[start - first]! += 1;
    diff[end - first + 1]! -= 1;
  }
  const out: number[] = [];
  let running = 0;
  for (let index = 0; index < length; index += 1) {
    running += diff[index]!;
    out.push(running);
  }
  return out;
}

export type DayAvailability = { date: string; booked: number; left: number };

/** Each day of the window with what is booked and what is left of `max`. */
export function availability(holds: readonly DatedHold[], from: Date, to: Date, max: number): DayAvailability[] {
  return perDayCounts(holds, from, to).map((booked, index) => ({ date: dayKey(addDays(from, index)), booked, left: Math.max(0, max - booked) }));
}

/** The days of the window already at `max` — what a 409 names. */
export function fullDays(holds: readonly DatedHold[], from: Date, to: Date, max: number): string[] {
  return availability(holds, from, to, max)
    .filter((day) => day.left <= 0)
    .map((day) => day.date);
}

/** The first day of the list with room, or null. */
export function firstFreeDay(days: readonly DayAvailability[]): string | null {
  return days.find((day) => day.left > 0)?.date ?? null;
}
