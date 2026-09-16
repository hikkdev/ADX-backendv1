import { describe, expect, it } from 'vitest';

/**
 * Lot I — the live hours.
 *
 * What is pinned: the window is `[from, to)` on the local clock in its own
 * zone; the boundary minute at `from` is open and the one at `to` is shut;
 * a window that crosses midnight is a night shift; two equal edges mean
 * around the clock; the next opening is the next instant `from` comes round,
 * cut to the whole minute.
 */

import { nextOpening, openingLabel, withinLiveHours } from '../live-chat.hours';

const IST = { from: '09:00', to: '21:00', tz: 'Asia/Kolkata' };
/** 09:00 IST is 03:30 UTC. */
const at = (utc: string) => new Date(utc);

describe('inside and outside', () => {
  it('opens at 09:00 IST and shuts at 21:00 IST', () => {
    expect(withinLiveHours(at('2026-09-14T03:29:59Z'), IST)).toBe(false);
    expect(withinLiveHours(at('2026-09-14T03:30:00Z'), IST)).toBe(true);
    expect(withinLiveHours(at('2026-09-14T12:00:00Z'), IST)).toBe(true);
    expect(withinLiveHours(at('2026-09-14T15:29:00Z'), IST)).toBe(true);
    // 21:00 IST exactly: shut.
    expect(withinLiveHours(at('2026-09-14T15:30:00Z'), IST)).toBe(false);
    expect(withinLiveHours(at('2026-09-14T20:00:00Z'), IST)).toBe(false);
  });

  it('reads a window across midnight as a night shift', () => {
    const night = { from: '21:00', to: '06:00', tz: 'Asia/Kolkata' };
    expect(withinLiveHours(at('2026-09-14T16:00:00Z'), night)).toBe(true); // 21:30 IST
    expect(withinLiveHours(at('2026-09-14T22:00:00Z'), night)).toBe(true); // 03:30 IST
    expect(withinLiveHours(at('2026-09-14T04:00:00Z'), night)).toBe(false); // 09:30 IST
  });

  it('treats two equal edges as around the clock', () => {
    const always = { from: '00:00', to: '00:00', tz: 'Asia/Kolkata' };
    expect(withinLiveHours(at('2026-09-14T19:00:00Z'), always)).toBe(true);
    expect(nextOpening(at('2026-09-14T19:00:00Z'), always)).toBeNull();
  });

  it('falls back to IST when the zone is not one the runtime knows', () => {
    const nonsense = { from: '09:00', to: '21:00', tz: 'Mars/Olympus' };
    expect(withinLiveHours(at('2026-09-14T12:00:00Z'), nonsense)).toBe(true);
    expect(withinLiveHours(at('2026-09-14T20:00:00Z'), nonsense)).toBe(false);
  });
});

describe('the next opening', () => {
  it('is null while the desk is open', () => {
    expect(nextOpening(at('2026-09-14T12:00:00Z'), IST)).toBeNull();
  });

  it('is this morning before it, and tomorrow morning after it', () => {
    // 02:00 IST — the same day's 09:00 IST is 03:30 UTC.
    expect(nextOpening(at('2026-09-13T20:30:00Z'), IST)?.toISOString()).toBe('2026-09-14T03:30:00.000Z');
    // 22:00 IST — tomorrow's 09:00 IST.
    expect(nextOpening(at('2026-09-14T16:30:00Z'), IST)?.toISOString()).toBe('2026-09-15T03:30:00.000Z');
  });

  it('is cut to the whole minute, so everyone deferred in one night is promised one instant', () => {
    const a = nextOpening(at('2026-09-14T16:30:10Z'), IST);
    const b = nextOpening(at('2026-09-14T16:30:59Z'), IST);
    expect(a?.toISOString()).toBe(b?.toISOString());
    expect(a?.getSeconds()).toBe(0);
  });
});

describe('the opening as a person reads it (I4-B)', () => {
  it('prints the desk clock in its own zone, never an ISO instant', () => {
    expect(openingLabel(at('2026-09-15T03:30:00Z'), 'Asia/Kolkata')).toBe('9:00 am IST on Tue 15 Sep');
    expect(openingLabel(at('2026-09-14T15:30:00Z'), 'Asia/Kolkata')).toBe('9:00 pm IST on Mon 14 Sep');
    // Midnight and noon on the twelve-hour clock.
    expect(openingLabel(at('2026-09-14T18:30:00Z'), 'Asia/Kolkata')).toBe('12:00 am IST on Tue 15 Sep');
    expect(openingLabel(at('2026-09-14T06:30:00Z'), 'Asia/Kolkata')).toBe('12:00 pm IST on Mon 14 Sep');
  });

  it('falls back to IST, the platform\'s own, for a zone the runtime does not know', () => {
    expect(openingLabel(at('2026-09-15T03:30:00Z'), 'Mars/Olympus')).toBe('9:00 am IST on Tue 15 Sep');
  });
});
