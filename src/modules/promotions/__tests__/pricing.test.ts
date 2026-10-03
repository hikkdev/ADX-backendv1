import { describe, expect, it } from 'vitest';
import { specFor } from '../../media';
import { DEFAULT_AD_SLOTS, DEFAULT_BOOST_PLACEMENTS } from '../defaults';
import { availability, checkDates, daysBetween, firstFreeDay, fullDays, parseDay, perDayCounts, quoteFor } from '../pricing';

/**
 * LM-1 — the arithmetic of a paid placement, pure.
 *
 * Pinned: whole UTC days, first and last both counted; rate × days + GST at
 * the platform rate, to the paisa, summed over a boost's placements;
 * capacity per DAY — two bookings that never share a day never add up, the
 * busiest day decides; every slot names a spec the media library knows.
 */

const d = (value: string) => parseDay(value);
const NOW = new Date('2026-10-01T09:00:00Z');

describe('dates', () => {
  it('reads a day as 00:00Z and refuses anything that is not a real date', () => {
    expect(d('2026-10-12').toISOString()).toBe('2026-10-12T00:00:00.000Z');
    expect(() => parseDay('2026-02-30')).toThrow(/not a real date/);
    expect(() => parseDay('12/10/2026')).toThrow(/like 2026-10-12/);
  });

  it('counts the first and the last day', () => {
    expect(daysBetween(d('2026-10-12'), d('2026-10-18'))).toBe(7);
    expect(daysBetween(d('2026-10-12'), d('2026-10-12'))).toBe(1);
  });

  it('allows today, refuses the past, an end before the start, too long, too short', () => {
    expect(checkDates(d('2026-10-01'), d('2026-10-03'), { minDays: 1, now: NOW })).toBe(3);
    expect(() => checkDates(d('2026-09-30'), d('2026-10-03'), { minDays: 1, now: NOW })).toThrow(/has passed/);
    expect(() => checkDates(d('2026-10-05'), d('2026-10-03'), { minDays: 1, now: NOW })).toThrow(/on or after/);
    expect(() => checkDates(d('2026-10-05'), d('2027-06-01'), { minDays: 1, now: NOW })).toThrow(/at most 186 days/);
    expect(() => checkDates(d('2026-10-05'), d('2026-10-06'), { minDays: 3, now: NOW })).toThrow(/at least 3 days/);
  });
});

describe('quoteFor', () => {
  it('₹1,500 a day for a week, plus 18% GST', () => {
    expect(quoteFor(['1500.00'], 7, '0.18')).toEqual({ days: 7, subtotal: '10500.00', gstPct: '18', gstAmount: '1890.00', total: '12390.00' });
  });

  it('sums a boost\'s placements before the days: (₹800 + ₹400) × 5', () => {
    expect(quoteFor(['800', '400'], 5, '0.18')).toMatchObject({ subtotal: '6000.00', gstAmount: '1080.00', total: '7080.00' });
  });

  it('rounds the GST to the paisa, half up', () => {
    expect(quoteFor(['333.33'], 1, '0.18')).toMatchObject({ subtotal: '333.33', gstAmount: '60.00', total: '393.33' });
    expect(quoteFor(['0.25'], 1, '0.18')).toMatchObject({ gstAmount: '0.05' });
  });
});

describe('capacity, per day', () => {
  const holds = [
    { startDate: d('2026-10-10'), endDate: d('2026-10-12') },
    { startDate: d('2026-10-12'), endDate: d('2026-10-15') },
    { startDate: d('2026-10-20'), endDate: d('2026-10-25') },
  ];

  it('counts each day, not the range — the 10th–12th and the 20th never add up', () => {
    expect(perDayCounts(holds, d('2026-10-10'), d('2026-10-13'))).toEqual([1, 1, 2, 1]);
    expect(perDayCounts(holds, d('2026-10-18'), d('2026-10-21'))).toEqual([0, 0, 1, 1]);
  });

  it('a slot of 2 is full only on the busiest day', () => {
    expect(fullDays(holds, d('2026-10-10'), d('2026-10-25'), 2)).toEqual(['2026-10-12']);
    expect(fullDays(holds, d('2026-10-10'), d('2026-10-25'), 3)).toEqual([]);
  });

  it('answers each day with booked and left, and the first day with room', () => {
    const days = availability(holds, d('2026-10-11'), d('2026-10-13'), 2);
    expect(days).toEqual([
      { date: '2026-10-11', booked: 1, left: 1 },
      { date: '2026-10-12', booked: 2, left: 0 },
      { date: '2026-10-13', booked: 1, left: 1 },
    ]);
    expect(firstFreeDay(days)).toBe('2026-10-11');
    expect(firstFreeDay(availability(holds, d('2026-10-12'), d('2026-10-12'), 2))).toBeNull();
  });
});

describe('the defaults ADX starts selling with', () => {
  it('four slots and two placements, at the figures the owner was given', () => {
    expect(DEFAULT_AD_SLOTS.map((slot) => [slot.key, slot.spec, slot.ratePerDay, slot.maxConcurrent])).toEqual([
      ['WEB_LISTING_SIDEBAR', 'AD_SIDEBAR', '1500.00', 3],
      ['WEB_EXPLORE_BANNER', 'AD_BANNER', '2500.00', 2],
      ['WEB_HOME_BANNER', 'AD_BANNER', '3000.00', 2],
      ['APP_ADVERTISER_HOME_BANNER', 'PROMO_WIDE', '2000.00', 3],
    ]);
    expect(DEFAULT_BOOST_PLACEMENTS.map((row) => [row.placement, row.ratePerDay, row.maxConcurrent])).toEqual([
      ['SEARCH_TOP', '800.00', 2],
      ['SIMILAR_TOP', '400.00', 3],
    ]);
  });

  it('names artwork specs that are the media library\'s, not a copy', () => {
    for (const slot of DEFAULT_AD_SLOTS) expect(specFor(slot.spec), slot.key).toMatchObject({ key: slot.spec });
  });
});
