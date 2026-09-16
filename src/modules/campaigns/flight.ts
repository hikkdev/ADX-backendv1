import { Decimal } from '../../shared/money';

/**
 * Whole calendar days a flight covers, inclusive of both ends, in UTC — a
 * one-day flight is 1, never 0. Shared by the analytics page and the list
 * row's spend-to-date so the two figures cannot disagree.
 */
export function flightDays(start: Date | null, end: Date | null): number {
  if (!start || !end) return 0;
  const from = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const to = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
}

/**
 * Spend to date: booked spots' daily rate for the days the flight has run.
 * The analytics page computes the same figure for one campaign; the list row
 * computes it for each so the Spend Bar ("37% of ₹50,000") is the same number.
 */
export function spendToDate(
  spots: { ratePerDay: Decimal | string | number; quantity: number; status: string }[],
  startDate: Date | null,
  endDate: Date | null,
  now: Date,
): Decimal {
  const daysTotal = flightDays(startDate, endDate);
  const elapsedEnd = endDate && endDate < now ? endDate : now;
  const daysElapsed = startDate && startDate <= now ? Math.min(daysTotal, flightDays(startDate, elapsedEnd)) : 0;
  const dailyRate = spots
    .filter((spot) => spot.status === 'BOOKED' || spot.status === 'LIVE' || spot.status === 'COMPLETED')
    .reduce((sum, spot) => sum.plus(new Decimal(spot.ratePerDay).times(spot.quantity)), new Decimal(0));
  return dailyRate.times(daysElapsed);
}
