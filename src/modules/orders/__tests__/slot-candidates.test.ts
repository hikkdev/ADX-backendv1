import { describe, expect, it } from 'vitest';
import { SLOT_BANDS_IST, slotCandidates, startOfDayIST } from '../scheduling/slot-candidates';

/**
 * The slot sheet's candidates, derived from the clock and the bookings.
 *
 * What is pinned: the bands are Indian-time bands whatever the host thinks;
 * today only offers what is still usefully ahead; the labels read the way the
 * sheet prints them; a band the publisher has already given to another agent
 * is skipped; the booking's own dates bound the list; and the list stops at
 * three.
 */

// 10 September 2026, 09:00 IST (03:30Z).
const morning = new Date('2026-09-10T03:30:00.000Z');

describe('startOfDayIST', () => {
  it('is Indian midnight as a UTC instant', () => {
    expect(startOfDayIST(morning).toISOString()).toBe('2026-09-09T18:30:00.000Z');
    // 01:00 IST on the 11th is still the 11th, even though it is the 10th in UTC.
    expect(startOfDayIST(new Date('2026-09-10T19:30:00.000Z')).toISOString()).toBe('2026-09-10T18:30:00.000Z');
  });
});

describe('slotCandidates', () => {
  it('offers three bands, today first, labelled the way the sheet prints them', () => {
    const list = slotCandidates({ now: morning, from: null, to: null, taken: [] });
    expect(list).toHaveLength(3);
    expect(list.map((c) => c.label)).toEqual(['Today', 'Today', 'Today']);
    // 10:00 IST = 04:30Z, two hours long.
    expect(list[0]).toMatchObject({ start: '2026-09-10T04:30:00.000Z', end: '2026-09-10T06:30:00.000Z' });
    expect(list[1]!.start).toBe('2026-09-10T08:30:00.000Z');
    expect(list[2]!.start).toBe('2026-09-10T11:30:00.000Z');
  });

  it('drops a band that is not still an hour ahead', () => {
    // 09:30 IST: the 10:00 band is only half an hour away.
    const late = new Date('2026-09-10T04:00:00.000Z');
    const list = slotCandidates({ now: late, from: null, to: null, taken: [] });
    expect(list[0]!.start).toBe('2026-09-10T08:30:00.000Z');
  });

  it('rolls into tomorrow and the date after, with their labels', () => {
    // 18:00 IST: nothing left today.
    const evening = new Date('2026-09-10T12:30:00.000Z');
    const list = slotCandidates({ now: evening, from: null, to: null, taken: [], count: 4 });
    expect(list.map((c) => c.label)).toEqual(['Tomorrow', 'Tomorrow', 'Tomorrow', '12/09/2026']);
    expect(list[0]!.start).toBe('2026-09-11T04:30:00.000Z');
  });

  it('skips a band the publisher has already given to another agent', () => {
    const taken = [new Date('2026-09-10T05:00:00.000Z')]; // 10:30 IST, inside the 10–12 band
    const list = slotCandidates({ now: morning, from: null, to: null, taken });
    expect(list[0]!.start).toBe('2026-09-10T08:30:00.000Z');
    expect(list.map((c) => c.start)).not.toContain('2026-09-10T04:30:00.000Z');
  });

  it('stays inside the booking dates', () => {
    const from = new Date('2026-09-12T00:00:00.000Z');
    const to = new Date('2026-09-12T10:00:00.000Z'); // 15:30 IST — only the 10–12 band fits
    const list = slotCandidates({ now: morning, from, to, taken: [] });
    expect(list).toEqual([
      { start: '2026-09-12T04:30:00.000Z', end: '2026-09-12T06:30:00.000Z', label: '12/09/2026' },
    ]);
  });

  it('gives up at the horizon rather than looping', () => {
    const to = new Date('2026-09-10T00:00:00.000Z'); // already past
    expect(slotCandidates({ now: morning, from: null, to, taken: [] })).toEqual([]);
  });

  it('has three bands a day', () => {
    expect(SLOT_BANDS_IST).toEqual([10, 14, 17]);
  });
});
