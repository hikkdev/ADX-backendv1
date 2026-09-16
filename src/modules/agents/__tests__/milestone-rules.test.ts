import { describe, expect, it } from 'vitest';

import {
  chipOf,
  deadlineLabel,
  milestoneChipOf,
  pctOf,
  rupeesProgress,
  stateOf,
  timingOf,
  windowOf,
} from '../milestones/milestone.rules';

/**
 * DR 05 — the board's states, from the frame's three chips (UPCOMING, IN
 * PROGRESS, LOCKED) and the three lines under them ("Starts in 5 days", "Due
 * in 10 days", "Complete 2 milestones first"), plus the tracker's "30th APR".
 */

const NOW = new Date('2026-09-11T06:00:00.000Z'); // 11:30 IST
const day = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

const template = (over: Partial<Parameters<typeof windowOf>[0]> = {}) => ({
  target: 10,
  windowDays: null,
  startsAt: null,
  unlockAfter: null,
  ...over,
});
const row = (over: Partial<Parameters<typeof windowOf>[1]> = {}) => ({
  createdAt: day(-20),
  completedAt: null,
  claimedAt: null,
  ...over,
});

describe('the window', () => {
  it('is all time when the template has neither a start nor a length', () => {
    expect(windowOf(template(), row())).toEqual({ from: null, to: null });
  });

  it('starts at the agent\'s own row when there is a length but no start', () => {
    const w = windowOf(template({ windowDays: 30 }), row());
    expect(w.from).toEqual(day(-20));
    expect(w.to).toEqual(day(10));
  });

  it('starts at the template\'s start when it has one, and never closes without a length', () => {
    expect(windowOf(template({ startsAt: day(-5) }), row())).toEqual({ from: day(-5), to: null });
  });
});

describe('the state', () => {
  const state = (t = template(), r = row(), progress = 0, completedByAgent = 0) =>
    stateOf({ template: t, row: r, progress, completedByAgent, now: NOW });

  it('is ACTIVE by default', () => {
    expect(state()).toBe('ACTIVE');
  });

  it('is COMPLETED the moment the derived progress reaches the target', () => {
    expect(state(template(), row(), 10)).toBe('COMPLETED');
  });

  it('is CLAIMED once claimed, whatever else is true', () => {
    expect(state(template({ unlockAfter: 5 }), row({ completedAt: day(-1), claimedAt: NOW }), 10)).toBe('CLAIMED');
  });

  it('is LOCKED until enough milestones are completed — checked before the start date', () => {
    expect(state(template({ unlockAfter: 2, startsAt: day(5) }), row(), 0, 1)).toBe('LOCKED');
    expect(state(template({ unlockAfter: 2, startsAt: day(5) }), row(), 0, 2)).toBe('UPCOMING');
  });

  it('is UPCOMING before it starts and EXPIRED after its window closes', () => {
    expect(state(template({ startsAt: day(5) }))).toBe('UPCOMING');
    expect(state(template({ windowDays: 10 }), row({ createdAt: day(-20) }))).toBe('EXPIRED');
    expect(state(template({ windowDays: 30 }), row({ createdAt: day(-20) }))).toBe('ACTIVE');
  });

  it('a completion stamped earlier outranks a window that has since closed', () => {
    expect(state(template({ windowDays: 10 }), row({ createdAt: day(-20), completedAt: day(-12) }), 10)).toBe('COMPLETED');
  });
});

describe('the chips', () => {
  it('file six states under three chips, with EXPIRED under ALL only', () => {
    expect(chipOf('ACTIVE')).toBe('ACTIVE');
    expect(chipOf('LOCKED')).toBe('UPCOMING');
    expect(chipOf('UPCOMING')).toBe('UPCOMING');
    expect(chipOf('COMPLETED')).toBe('COMPLETED');
    expect(chipOf('CLAIMED')).toBe('COMPLETED');
    expect(chipOf('EXPIRED')).toBeNull();
  });

  it('draw the frame\'s three labels', () => {
    expect(milestoneChipOf('ACTIVE')).toEqual({ label: 'In progress', tone: 'new' });
    expect(milestoneChipOf('UPCOMING').label).toBe('Upcoming');
    expect(milestoneChipOf('LOCKED')).toEqual({ label: 'Locked', tone: 'neutral' });
  });
});

describe('the line under the title', () => {
  const timing = (state: Parameters<typeof timingOf>[0]['state'], t = template(), r = row()) =>
    timingOf({ state, template: t, row: r, now: NOW });

  it('names the precondition on a locked milestone', () => {
    expect(timing('LOCKED', template({ unlockAfter: 2 }))).toBe('Complete 2 milestones first');
    expect(timing('LOCKED', template({ unlockAfter: 1 }))).toBe('Complete 1 milestone first');
  });

  it('counts down to the start and to the deadline in whole days, rounded up', () => {
    expect(timing('UPCOMING', template({ startsAt: day(5) }))).toBe('Starts in 5 days');
    expect(timing('UPCOMING', template({ startsAt: new Date(NOW.getTime() + 3600_000) }))).toBe('Starts in 1 day');
    expect(timing('ACTIVE', template({ windowDays: 30 }), row({ createdAt: day(-20) }))).toBe('Due in 10 days');
  });

  it('says nothing on an active milestone with no deadline', () => {
    expect(timing('ACTIVE')).toBeNull();
  });

  it('dates a completion, a claim and an end the way the frame does', () => {
    expect(timing('COMPLETED', template(), row({ completedAt: new Date('2026-07-05T10:00:00.000Z') }))).toBe('Completed 05 Jul');
    expect(timing('CLAIMED', template(), row({ claimedAt: new Date('2026-07-05T10:00:00.000Z') }))).toBe('Claimed 05 Jul');
    expect(timing('EXPIRED', template({ windowDays: 10 }), row({ createdAt: new Date('2026-06-25T10:00:00.000Z') }))).toBe('Ended 05 Jul');
  });
});

describe('the tracker', () => {
  it('prints the deadline as "30th APR"', () => {
    expect(deadlineLabel(new Date('2026-04-30T10:00:00.000Z'))).toBe('30th APR');
    expect(deadlineLabel(new Date('2026-05-01T10:00:00.000Z'))).toBe('1st MAY');
    expect(deadlineLabel(new Date('2026-05-22T10:00:00.000Z'))).toBe('22nd MAY');
    expect(deadlineLabel(new Date('2026-05-11T10:00:00.000Z'))).toBe('11th MAY');
    // Just before IST midnight is still the earlier day.
    expect(deadlineLabel(new Date('2026-05-03T18:00:00.000Z'))).toBe('3rd MAY');
  });

  it('fills whole segments and never more than all of them', () => {
    expect(pctOf(7, 10)).toBe(70);
    expect(pctOf(12, 10)).toBe(100);
    expect(pctOf(0, 0)).toBe(100);
  });

  it('segments a revenue milestone on whole rupees and prints the amount as money', () => {
    expect(rupeesProgress('32000.50')).toEqual({ progress: 32000, amount: '32000.50' });
    expect(rupeesProgress(0)).toEqual({ progress: 0, amount: '0.00' });
  });
});
