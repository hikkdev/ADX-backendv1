import { describe, expect, it } from 'vitest';
import { dailyHolds, peakSlotHolds, blockedDays, type DatedHold } from '../slot-holds';
import { availabilityOf, earliestFit } from '../availability.service';

/**
 * AV-1 (the owner, 27 Sep 2026): a space booked on some dates and free on
 * the rest. Pinned: holds are counted per day, the busiest day is what
 * "slots held over these dates" means, a block takes its own days only,
 * and the per-day read answers the first free day and the earliest run of
 * days that fits.
 */
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const october = { from: day('2026-10-01'), to: new Date('2026-10-31T23:59:59.999Z') };
const hold = (from: string | null, to: string | null, quantity = 1, extra: Partial<DatedHold> = {}): DatedHold => ({ listingId: 'lst_1', quantity, from: from ? day(from) : null, to: to ? day(to) : null, ...extra });

describe('counted per day', () => {
  it('a billboard booked 1–10 Oct is held on those ten days and free on the other twenty-one', () => {
    const days = dailyHolds([hold('2026-10-01', '2026-10-10')], october);
    expect(days).toHaveLength(31);
    expect(days.slice(0, 10).every((held) => held === 1)).toBe(true);
    expect(days.slice(10).every((held) => held === 0)).toBe(true);
  });

  it('two bookings that never run together never add up — the busiest day is one', () => {
    const peak = peakSlotHolds([hold('2026-10-01', '2026-10-05'), hold('2026-10-20', '2026-10-25')], october);
    expect(peak.get('lst_1')).toBe(1);
  });

  it('bookings that overlap add up on the shared days only, and quantities count', () => {
    const days = dailyHolds([hold('2026-10-01', '2026-10-10', 2), hold('2026-10-10', '2026-10-15', 3)], october);
    expect(days[8]).toBe(2); // 9 Oct
    expect(days[9]).toBe(5); // 10 Oct: both
    expect(days[10]).toBe(3); // 11 Oct
    expect(peakSlotHolds([hold('2026-10-01', '2026-10-10', 2), hold('2026-10-10', '2026-10-15', 3)], october).get('lst_1')).toBe(5);
  });

  it('a hold with no dates runs over the whole window, as it always held the spot; one outside the window holds nothing', () => {
    expect(dailyHolds([hold(null, null)], october).every((held) => held === 1)).toBe(true);
    expect(dailyHolds([hold('2026-11-02', '2026-11-05')], october).every((held) => held === 0)).toBe(true);
  });

  it('a publisher block takes its own days, not the whole window', () => {
    const blocks = [hold('2026-10-15', '2026-10-15', 6, { blocked: true })];
    const blocked = blockedDays(blocks, october);
    expect(blocked.filter(Boolean)).toHaveLength(1);
    expect(blocked[14]).toBe(true);
  });
});

describe('the availability read', () => {
  it('answers every day, the first free day, the free-day count and the earliest run that fits', () => {
    const answer = availabilityOf({ id: 'lst_1', slotsTotal: 1 }, [hold('2026-10-01', '2026-10-10'), hold('2026-10-15', '2026-10-15', 1, { blocked: true })], october, { length: 7 });
    expect(answer.days[0]).toEqual({ date: '2026-10-01', held: 1, left: 0, blocked: false });
    expect(answer.days[14]).toEqual({ date: '2026-10-15', held: 1, left: 0, blocked: true });
    expect(answer.nextFreeDate).toBe('2026-10-11');
    expect(answer.freeDays).toBe(20);
    // 11–14 is only four days; the first seven free in a row start on the 16th.
    expect(answer.nextFit).toEqual({ from: '2026-10-16', to: '2026-10-22' });
  });

  it('a digital loop counts slots per day against the quantity asked for', () => {
    const answer = availabilityOf({ id: 'lst_1', slotsTotal: 6 }, [hold('2026-10-01', '2026-10-31', 4)], october, { length: 3, quantity: 3 });
    expect(answer.days[0]).toMatchObject({ held: 4, left: 2 });
    expect(answer.nextFreeDate).toBeNull();
    expect(answer.nextFit).toBeNull();
    expect(answer.freeDays).toBe(0);
  });

  it('earliestFit needs the whole run', () => {
    const days = ['a', 'b', 'c', 'd'].map((d, i) => ({ date: d, held: 0, left: i === 1 ? 0 : 1, blocked: false }));
    expect(earliestFit(days, 2, 1)).toEqual({ from: 'c', to: 'd' });
    expect(earliestFit(days, 3, 1)).toBeNull();
  });
});
