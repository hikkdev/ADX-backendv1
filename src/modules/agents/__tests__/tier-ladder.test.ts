import { describe, expect, it } from 'vitest';
import { LADDER, rungFor, tierLabel } from '../tier-ladder';

/**
 * The agent tier ladder the DR 01 dashboard header draws — "BRONZE III" with
 * "3/10" toward "SILVER I".
 *
 * What is pinned: that the rungs climb strictly, that an agent lands on the
 * last rung whose threshold they have reached, that the step figures are
 * relative to the current rung and not to zero, and that the top rung has no
 * next. The thresholds themselves are a product decision the file states in
 * one place; the tests do not repeat them, they read them.
 */

describe('the ladder itself', () => {
  it('starts at zero and climbs strictly', () => {
    expect(LADDER[0]).toMatchObject({ tier: 'BRONZE', level: 'I', from: 0 });
    for (let i = 1; i < LADDER.length; i += 1) {
      expect(LADDER[i]!.from).toBeGreaterThan(LADDER[i - 1]!.from);
    }
  });

  it('runs I → II → III inside a tier before the next tier begins', () => {
    const levels = LADDER.map((rung) => `${rung.tier} ${rung.level}`);
    expect(levels.slice(0, 4)).toEqual(['BRONZE I', 'BRONZE II', 'BRONZE III', 'SILVER I']);
  });
});

describe('rungFor', () => {
  it('a brand-new agent is Bronze I with the whole first step ahead', () => {
    const rung = rungFor(0);
    expect(rung.tier).toBe('BRONZE');
    expect(rung.level).toBe('I');
    expect(rung.stepDone).toBe(0);
    expect(rung.stepTarget).toBe(LADDER[1]!.from - LADDER[0]!.from);
    expect(rung.next).toMatchObject({ tier: 'BRONZE', level: 'II' });
  });

  it('counts the step from the current rung, not from zero', () => {
    const third = LADDER[2]!;
    const fourth = LADDER[3]!;
    const rung = rungFor(third.from + 3);
    expect(rung).toMatchObject({ tier: third.tier, level: third.level, stepDone: 3 });
    expect(rung.stepTarget).toBe(fourth.from - third.from);
    expect(rung.next).toMatchObject({ tier: fourth.tier, level: fourth.level });
  });

  it('lands exactly on a threshold as that rung, with nothing done yet on it', () => {
    const fourth = LADDER[3]!;
    expect(rungFor(fourth.from)).toMatchObject({ tier: fourth.tier, level: fourth.level, stepDone: 0 });
  });

  it('the top rung has no next and a full step', () => {
    const top = LADDER[LADDER.length - 1]!;
    const rung = rungFor(top.from + 500);
    expect(rung).toMatchObject({ tier: top.tier, level: top.level, next: null });
    expect(rung.stepDone).toBe(rung.stepTarget);
  });

  it('never goes negative', () => {
    expect(rungFor(-4)).toMatchObject({ tier: 'BRONZE', level: 'I', stepDone: 0 });
  });
});

describe('tierLabel', () => {
  it('prints the way the frame does', () => {
    expect(tierLabel('BRONZE', 'III')).toBe('Bronze III');
    expect(tierLabel('SILVER', 'I')).toBe('Silver I');
  });
});
