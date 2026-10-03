import { describe, expect, it } from 'vitest';
import { Decimal } from '../../../shared/money';
import { allMetrics, metricByKey, metricKeys, supportsDimension, withParts } from '../metrics/registry';
import { bucketStartOf, rollup } from '../metrics/rollup';
import type { DailyPoint, MetricDef } from '../metrics/metric.types';

/**
 * AN-1: the metric model.
 *
 * Three things are worth holding here, and they are the three that make the
 * registry worth having at all.
 *
 * The registry is a contract: no key twice, every ratio's parts real, every
 * metric readable at every grain it claims.
 *
 * The roll-up rules are not interchangeable. A ratio that averages its days,
 * or a balance that sums them, produces a number that looks plausible and is
 * wrong — which is worse than an error, because nobody checks it.
 */

const monthStartOf = (day: number) => {
  const date = new Date(day * 86_400_000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 86_400_000;
};

const days = (...values: [number, number][]): DailyPoint[] => values.map(([day, value]) => ({ day, value: new Decimal(value) }));

const weighted = (...values: [number, number, number][]): DailyPoint[] =>
  values.map(([day, value, weight]) => ({ day, value: new Decimal(value), weight: new Decimal(weight) }));

const def = (over: Partial<MetricDef>): MetricDef => ({
  key: 'test',
  name: 'Test',
  description: 'A metric for the test.',
  family: 'scale',
  kind: 'COUNT',
  rollup: 'SUM',
  dimensions: [],
  grains: ['day', 'week', 'month'],
  source: 'the test',
  ...over,
});

describe('the registry is a contract', () => {
  it('never defines a metric twice', () => {
    const keys = metricKeys();
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every ratio a numerator and a denominator that exist', () => {
    for (const metric of allMetrics()) {
      if (metric.rollup !== 'RECOMPUTE') continue;
      expect(metric.numerator, `${metric.key} numerator`).toBeTruthy();
      expect(metric.denominator, `${metric.key} denominator`).toBeTruthy();
      expect(metricByKey(metric.numerator!), `${metric.key} numerator is registered`).toBeDefined();
      expect(metricByKey(metric.denominator!), `${metric.key} denominator is registered`).toBeDefined();
    }
  });

  it('reads every metric at day, week and month', () => {
    for (const metric of allMetrics()) {
      expect(metric.grains, metric.key).toEqual(['day', 'week', 'month']);
    }
  });

  it('gives every metric a description and a source, because the picker prints them', () => {
    for (const metric of allMetrics()) {
      expect(metric.description.length, metric.key).toBeGreaterThan(10);
      expect(metric.source.length, metric.key).toBeGreaterThan(10);
    }
  });

  it('fetches a ratio’s parts even when nobody asked for them', () => {
    const needed = withParts(['occupancyPct']);
    expect(needed).toContain('occupancyPct');
    expect(needed).toContain('bookedSlotDays');
    expect(needed).toContain('availableSlotDays');
  });

  it('refuses a cut a metric does not declare', () => {
    const occupancy = metricByKey('occupancyPct')!;
    expect(supportsDimension(occupancy, 'city')).toBe(true);
    expect(supportsDimension(occupancy, 'advertiser')).toBe(false);
  });
});

describe('days become weeks and months', () => {
  it('starts a week on the Monday', () => {
    /* Day 0 of the index is 1 Jan 1970, a Thursday, so its week began on the
       Monday two days earlier. */
    expect(bucketStartOf(0, 'week', monthStartOf)).toBe(-3);
    expect(bucketStartOf(-3, 'week', monthStartOf)).toBe(-3);
    expect(bucketStartOf(4, 'week', monthStartOf)).toBe(4);
  });

  it('leaves a day alone', () => {
    expect(bucketStartOf(12_345, 'day', monthStartOf)).toBe(12_345);
  });

  it('starts a month on the first', () => {
    expect(bucketStartOf(monthStartOf(20_000) + 5, 'month', monthStartOf)).toBe(monthStartOf(20_000));
  });
});

describe('the four roll-up rules', () => {
  it('SUM adds the days', () => {
    const rolled = rollup(def({ rollup: 'SUM' }), days([0, 3], [1, 4], [2, 5]), 'week', monthStartOf);
    expect(rolled.total.value).toBe(12);
  });

  it('CLOSING takes the last day, never the sum — a balance is a level', () => {
    const rolled = rollup(def({ rollup: 'CLOSING', kind: 'BALANCE' }), days([0, 100], [1, 120], [2, 90]), 'week', monthStartOf);
    expect(rolled.total.value).toBe(90);
  });

  it('WEIGHTED_MEAN divides by the weight, so a busy day counts for more', () => {
    /* Ten hours over one order and two hours over ninety-nine is not a
       six-hour mean. The source multiplies before it arrives, so 10×1 + 2×99. */
    const rolled = rollup(
      def({ rollup: 'WEIGHTED_MEAN', kind: 'DURATION' }),
      weighted([0, 10 * 1, 1], [1, 2 * 99, 99]),
      'week',
      monthStartOf,
    );
    expect(rolled.total.value).toBeCloseTo((10 + 198) / 100, 6);
  });

  /**
   * The rule the whole model exists for. Two days: one booked slot of one
   * available, then one booked of ninety-nine. The week is 2/100 = 2 %, not
   * the mean of 100 % and about 1 %.
   */
  it('RECOMPUTE divides the sums, never averages the daily ratios', () => {
    const ratio = def({ key: 'occupancyPct', rollup: 'RECOMPUTE', kind: 'RATIO', numerator: 'booked', denominator: 'available' });
    const rolled = rollup(ratio, [], 'week', monthStartOf, {
      numerator: days([0, 1], [1, 1]),
      denominator: days([0, 1], [1, 99]),
    });
    expect(rolled.total.value).toBe(2);
    expect(rolled.total.numerator).toBe(2);
    expect(rolled.total.denominator).toBe(100);

    /* The average of the daily percentages would have been about 50.5. */
    const naive = (100 + 100 / 99) / 2;
    expect(rolled.total.value).not.toBeCloseTo(naive, 1);
  });

  it('a week equals the recomputation of its days, not their mean', () => {
    const ratio = def({ rollup: 'RECOMPUTE', kind: 'RATIO', numerator: 'n', denominator: 'd' });
    const numerator = days([0, 5], [1, 15], [2, 30]);
    const denominator = days([0, 10], [1, 20], [2, 120]);

    const byWeek = rollup(ratio, [], 'week', monthStartOf, { numerator, denominator });
    const byDay = rollup(ratio, [], 'day', monthStartOf, { numerator, denominator });

    const dailyValues = [...byDay.byBucket.values()].map((value) => Number(value.value));
    const mean = dailyValues.reduce((sum, value) => sum + value, 0) / dailyValues.length;

    expect(byWeek.total.value).toBe(Number(((50 / 150) * 100).toFixed(2)));
    expect(byWeek.total.value).not.toBeCloseTo(mean, 1);
  });

  it('answers zero rather than dividing by nothing', () => {
    const ratio = def({ rollup: 'RECOMPUTE', kind: 'RATIO', numerator: 'n', denominator: 'd' });
    const rolled = rollup(ratio, [], 'day', monthStartOf, { numerator: days([0, 5]), denominator: [] });
    expect(rolled.total.value).toBe(0);
  });

  it('keeps money as a decimal string and never a float', () => {
    const rolled = rollup(def({ kind: 'MONEY', rollup: 'SUM' }), days([0, 0.1], [1, 0.2]), 'day', monthStartOf);
    expect(typeof rolled.total.value).toBe('string');
    expect(rolled.total.value).toBe('0.30');
  });

  it('buckets a ratio even on a bucket where only the denominator moved', () => {
    const ratio = def({ rollup: 'RECOMPUTE', kind: 'RATIO', numerator: 'n', denominator: 'd' });
    const rolled = rollup(ratio, [], 'day', monthStartOf, { numerator: [], denominator: days([7, 40]) });
    expect(rolled.byBucket.get(7)?.value).toBe(0);
    expect(rolled.byBucket.get(7)?.denominator).toBe(40);
  });
});
