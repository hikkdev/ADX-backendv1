import { describe, expect, it } from 'vitest';
import { nextRunAtFor, resolveWindow, windowForCadence } from '../windows';

/**
 * Lot G (Q129/Q143): report windows are Indian days, schedules fire at
 * 06:00 IST. 06:00 IST is 00:30 UTC.
 */
describe('resolveWindow', () => {
  // 2026-09-14 03:00 UTC is 08:30 IST on the 14th.
  const now = new Date('2026-09-14T03:00:00Z');

  it('names yesterday as the Indian yesterday', () => {
    const w = resolveWindow({ preset: 'yesterday' }, now);
    expect(w.from).toBe('2026-09-13');
    expect(w.to).toBe('2026-09-13');
    expect(w.start.toISOString()).toBe('2026-09-12T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    expect(w.label).toBe('2026-09-13');
  });

  it('crosses the IST midnight before UTC does', () => {
    // 20:00 UTC on the 13th is 01:30 IST on the 14th: today is the 14th.
    const w = resolveWindow({ preset: 'today' }, new Date('2026-09-13T20:00:00Z'));
    expect(w.from).toBe('2026-09-14');
  });

  it('last7 and last30 end yesterday', () => {
    expect(resolveWindow({ preset: 'last7' }, now)).toMatchObject({ from: '2026-09-07', to: '2026-09-13' });
    expect(resolveWindow({ preset: 'last30' }, now)).toMatchObject({ from: '2026-08-15', to: '2026-09-13' });
  });

  it('lastMonth is the previous Indian calendar month, across a year boundary too', () => {
    expect(resolveWindow({ preset: 'lastMonth' }, now)).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(resolveWindow({ preset: 'lastMonth' }, new Date('2027-01-05T03:00:00Z'))).toMatchObject({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('monthToDate runs from the first to today', () => {
    expect(resolveWindow({ preset: 'monthToDate' }, now)).toMatchObject({ from: '2026-09-01', to: '2026-09-14', label: '2026-09-01 → 2026-09-14' });
  });

  it('a custom window is inclusive of both days', () => {
    const w = resolveWindow({ from: '2026-09-01', to: '2026-09-02' }, now);
    expect(w.start.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-09-02T18:30:00.000Z');
  });
});

describe('windowForCadence', () => {
  const now = new Date('2026-09-14T00:35:00Z'); // 06:05 IST, Monday the 14th
  it('DAILY is yesterday, WEEKLY the seven days before today, MONTHLY last month', () => {
    expect(windowForCadence('DAILY', now)).toMatchObject({ from: '2026-09-13', to: '2026-09-13' });
    expect(windowForCadence('WEEKLY', now)).toMatchObject({ from: '2026-09-07', to: '2026-09-13' });
    expect(windowForCadence('MONTHLY', now)).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
  });
});

describe('nextRunAtFor', () => {
  it('DAILY: today at 06:00 IST when it is still before six, else tomorrow', () => {
    expect(nextRunAtFor('DAILY', new Date('2026-09-14T00:00:00Z')).toISOString()).toBe('2026-09-14T00:30:00.000Z');
    expect(nextRunAtFor('DAILY', new Date('2026-09-14T00:30:00Z')).toISOString()).toBe('2026-09-15T00:30:00.000Z');
    expect(nextRunAtFor('DAILY', new Date('2026-09-14T12:00:00Z')).toISOString()).toBe('2026-09-15T00:30:00.000Z');
  });

  it('WEEKLY: the next Monday 06:00 IST, a week on when it is already Monday past six', () => {
    // 2026-09-14 is a Monday.
    expect(nextRunAtFor('WEEKLY', new Date('2026-09-14T00:00:00Z')).toISOString()).toBe('2026-09-14T00:30:00.000Z');
    expect(nextRunAtFor('WEEKLY', new Date('2026-09-14T00:30:00Z')).toISOString()).toBe('2026-09-21T00:30:00.000Z');
    expect(nextRunAtFor('WEEKLY', new Date('2026-09-16T12:00:00Z')).toISOString()).toBe('2026-09-21T00:30:00.000Z');
    // Sunday 20th at 23:00 IST (17:30 UTC) → Monday 21st.
    expect(nextRunAtFor('WEEKLY', new Date('2026-09-20T17:30:00Z')).toISOString()).toBe('2026-09-21T00:30:00.000Z');
  });

  it('MONTHLY: the first of next month at 06:00 IST, and the year rolls over', () => {
    expect(nextRunAtFor('MONTHLY', new Date('2026-09-14T12:00:00Z')).toISOString()).toBe('2026-10-01T00:30:00.000Z');
    expect(nextRunAtFor('MONTHLY', new Date('2026-10-01T00:00:00Z')).toISOString()).toBe('2026-10-01T00:30:00.000Z');
    expect(nextRunAtFor('MONTHLY', new Date('2026-12-15T12:00:00Z')).toISOString()).toBe('2027-01-01T00:30:00.000Z');
  });
});
