import { describe, expect, it } from 'vitest';

import { flightDays, spendToDate } from '../flight';

/**
 * The Spend Bar on the campaigns list ("37% of ₹50,000") is the same figure the
 * analytics page prints: booked spots' daily rate over the days that have run.
 */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('flightDays', () => {
  it('is inclusive of both ends and never zero for a real flight', () => {
    expect(flightDays(day('2026-09-01'), day('2026-09-10'))).toBe(10);
    expect(flightDays(day('2026-09-01'), day('2026-09-01'))).toBe(1);
    expect(flightDays(null, day('2026-09-01'))).toBe(0);
  });
});

describe('spendToDate', () => {
  const spots = [
    { ratePerDay: '1000.00', quantity: 1, status: 'LIVE' },
    { ratePerDay: '500.50', quantity: 2, status: 'BOOKED' },
    { ratePerDay: '99999.00', quantity: 1, status: 'RESERVED' }, // in the cart, commits nothing
    { ratePerDay: '99999.00', quantity: 1, status: 'CANCELLED' },
  ];

  it('counts booked, live and completed spots for the days run, as Decimal', () => {
    // Daily rate 1000 + 2×500.50 = 2001; three days into a ten-day flight.
    const spend = spendToDate(spots, day('2026-09-01'), day('2026-09-10'), day('2026-09-03'));
    expect(spend.toFixed(2)).toBe('6003.00');
  });

  it('is zero before the flight starts and caps at the flight after it ends', () => {
    expect(spendToDate(spots, day('2026-09-05'), day('2026-09-10'), day('2026-09-03')).toFixed(2)).toBe('0.00');
    expect(spendToDate(spots, day('2026-09-01'), day('2026-09-02'), day('2026-12-01')).toFixed(2)).toBe('4002.00');
  });

  it('is zero with no dates rather than a guess', () => {
    expect(spendToDate(spots, null, null, day('2026-09-03')).toFixed(2)).toBe('0.00');
  });
});
