import { describe, expect, it } from 'vitest';
import {
  arrivedOnTime,
  BASE_SCORE,
  DELTA,
  driversOf,
  ledgerOf,
  MIN_COHORT,
  MIN_JOBS_FOR_A_RATING,
  percentileLabel,
  percentileOf,
  reviewDelta,
  reviewGoodness,
  scoreOf,
  WEIGHTS,
} from '../rating.rules';

/**
 * DR 07, wave 6 — the rating, decisions 3 and 4.
 *
 * What is pinned: a driver with no sample is left out rather than counted as
 * zero; an agent with too little history has no score at all rather than a
 * flattering one; the ledger names real orders; and the percentile is printed
 * only when there is a cohort to compute it from.
 */

const clean = { accepted: 20, completed: 19, arrivalsJudged: 16, arrivalsOnTime: 14, offered: 24, declined: 2 };

describe('the drivers', () => {
  it('are three ratios and the publishers’ stars, with the rejection one marked as the inverted good', () => {
    const drivers = driversOf(clean);
    expect(drivers.map((driver) => driver.key)).toEqual(['completion', 'onTime', 'rejection', 'review']);
    expect(drivers[0]).toMatchObject({ rate: 0.95, sample: 20, inverted: false });
    expect(drivers[1]!.rate).toBeCloseTo(0.875, 3);
    expect(drivers[2]).toMatchObject({ rate: 2 / 24, inverted: true });
    // Lot D (Q112): nobody has rated this agent, so the fourth driver has no sample.
    expect(drivers[3]).toMatchObject({ key: 'review', rate: null, sample: 0, inverted: false });
  });

  it('report null rather than zero when there is nothing to judge', () => {
    const drivers = driversOf({ ...clean, arrivalsJudged: 0, arrivalsOnTime: 0 });
    expect(drivers[1]).toMatchObject({ rate: null, sample: 0 });
  });
});

describe('the score', () => {
  it('is one decimal out of five, and rewards a clean record', () => {
    const rating = scoreOf(clean);
    expect(rating.provisional).toBe(false);
    expect(rating.score).toBeGreaterThan(BASE_SCORE);
    expect(rating.score).toBeLessThanOrEqual(5);
    expect(Number.isInteger((rating.score as number) * 10)).toBe(true);
  });

  it('marks a poor record down, and never below one star', () => {
    const poor = scoreOf({ accepted: 20, completed: 8, arrivalsJudged: 10, arrivalsOnTime: 2, offered: 30, declined: 21 });
    expect(poor.score).toBeLessThan(BASE_SCORE);
    expect(poor.score).toBeGreaterThanOrEqual(1);
  });

  it('has no score at all below the minimum history, rather than a flattering one', () => {
    const thin = scoreOf({ accepted: 2, completed: 2, arrivalsJudged: 2, arrivalsOnTime: 2, offered: 2, declined: 0 });
    expect(thin).toMatchObject({ score: null, provisional: true });
    expect(thin.sample).toBeLessThan(MIN_JOBS_FOR_A_RATING);
    // The drivers are still reported: the screen shows what it knows.
    expect(thin.drivers[0]!.rate).toBe(1);
  });

  it('re-weights around a driver with no sample, so an agent is not marked down for having no visits', () => {
    const withArrivals = scoreOf(clean);
    const without = scoreOf({ ...clean, arrivalsJudged: 0, arrivalsOnTime: 0 });
    expect(without.score).not.toBeNull();
    expect(without.score).toBeGreaterThanOrEqual(withArrivals.score as number);
  });
});

describe('the publishers’ stars (Lot D, Q112 — the fourth driver)', () => {
  it('weighs 0.4 / 0.2 / 0.2 / 0.2, and is re-weighted away while there is no review', () => {
    expect(WEIGHTS).toEqual({ completion: 0.4, onTime: 0.2, rejection: 0.2, review: 0.2 });
    // Without a review the three derived drivers keep their old proportions,
    // so the score of an unrated agent is exactly what it was before the lot.
    const unrated = scoreOf({ ...clean, reviewAvg: null, reviewCount: 0 });
    expect(unrated.score).toBe(scoreOf(clean).score);
  });

  it('is neutral at four stars, lifts at five and drags below four', () => {
    expect(reviewGoodness(4)).toBeCloseTo(0.85, 6);
    expect(reviewGoodness(5)).toBe(1);
    expect(reviewGoodness(1)).toBe(0);
    const fours = scoreOf({ ...clean, reviewAvg: 4, reviewCount: 6 });
    const fives = scoreOf({ ...clean, reviewAvg: 5, reviewCount: 6 });
    const twos = scoreOf({ ...clean, reviewAvg: 2, reviewCount: 6 });
    expect(fives.score).toBeGreaterThan(fours.score as number);
    expect(twos.score).toBeLessThan(fours.score as number);
    expect(driversOf({ ...clean, reviewAvg: 4.5, reviewCount: 6 })[3]).toMatchObject({ sample: 6 });
  });

  it('is worth +0.1 for five stars, nothing for four, −0.1 for three or fewer in the ledger', () => {
    expect(reviewDelta(5)).toBe(DELTA.fiveStars);
    expect(reviewDelta(4)).toBe(0);
    expect(reviewDelta(3)).toBe(DELTA.threeStarsOrLess);
    expect(reviewDelta(1)).toBe(-0.1);
    const ledger = ledgerOf({
      completions: [],
      rejections: [],
      reviews: [
        { reviewId: 'rev_1', at: new Date('2026-09-10T10:00:00.000Z'), rating: 5, note: 'Quick and tidy' },
        { reviewId: 'rev_2', at: new Date('2026-09-08T10:00:00.000Z'), rating: 3, note: null },
      ],
    });
    expect(ledger.map((entry) => entry.id)).toEqual(['review:rev_1', 'review:rev_2']);
    expect(ledger[0]).toMatchObject({ kind: 'review', title: 'Publisher rated you 5 stars', detail: 'Quick and tidy', delta: 0.1 });
    expect(ledger[1]).toMatchObject({ kind: 'review', delta: -0.1 });
  });
});

describe('on-time arrival (decision 4: the platform does hold this)', () => {
  const slot = new Date('2026-09-11T09:00:00.000Z');

  it('is the check-in against the confirmed slot, with a grace period', () => {
    expect(arrivedOnTime(slot, new Date('2026-09-11T08:55:00.000Z'))).toBe(true);
    expect(arrivedOnTime(slot, new Date('2026-09-11T09:14:00.000Z'))).toBe(true);
    expect(arrivedOnTime(slot, new Date('2026-09-11T09:16:00.000Z'))).toBe(false);
    expect(arrivedOnTime(slot, new Date('2026-09-11T09:16:00.000Z'), 30)).toBe(true);
  });
});

describe('what changed recently', () => {
  it('reads back real orders, newest first, with the delta each is worth', () => {
    const ledger = ledgerOf({
      completions: [
        { orderId: 'ord_1', at: new Date('2026-09-09T10:00:00.000Z'), campaignName: 'Monsoon sale', onTime: true },
        { orderId: 'ord_2', at: new Date('2026-09-05T10:00:00.000Z'), campaignName: null, onTime: false },
      ],
      rejections: [{ orderId: 'ord_3', at: new Date('2026-09-06T10:00:00.000Z'), reason: 'TOO_MANY_ACTIVE_ORDERS' }],
    });
    expect(ledger.map((entry) => entry.id)).toEqual(['completion:ord_1', 'rejection:ord_3', 'completion:ord_2']);
    expect(ledger[0]).toMatchObject({ title: 'On-time installation', detail: 'Monsoon sale', delta: DELTA.completion });
    expect(ledger[1]).toMatchObject({ title: 'Order rejected', detail: 'too many active orders', delta: DELTA.rejection });
    expect(ledger[2]).toMatchObject({ kind: 'arrival', title: 'Late arrival', delta: DELTA.lateArrival });
  });
});

describe('the percentile (decision 3: real, or not printed)', () => {
  const cohort = Array.from({ length: 20 }, (_, index) => 3 + index * 0.1);

  it('is the share of the cohort scoring above the agent, rounded against them', () => {
    expect(percentileOf(4.8, cohort)).toBe(5);
    expect(percentileOf(3.0, cohort)).toBe(95);
    expect(percentileOf(5.0, cohort)).toBe(1);
  });

  it('is not computed from a handful of people, or for an unrated agent', () => {
    expect(percentileOf(4.6, cohort.slice(0, MIN_COHORT - 1))).toBeNull();
    expect(percentileOf(null, cohort)).toBeNull();
  });

  it('says nothing at all when it cannot name the city or the number', () => {
    expect(percentileLabel(15, 'Bengaluru')).toBe('Top 15% of agents in Bengaluru');
    expect(percentileLabel(null, 'Bengaluru')).toBeNull();
    expect(percentileLabel(15, null)).toBeNull();
  });
});
