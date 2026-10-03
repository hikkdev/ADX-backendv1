import { Decimal, ZERO, money } from '../../../shared/money';
import type { DailyPoint, Granularity, MetricDef, MetricValue } from './metric.types';

/**
 * AN-1: days into buckets, by the metric's declared rule.
 *
 * This file is the whole reason the registry declares a roll-up. The four
 * rules are not interchangeable and picking the wrong one produces a number
 * that looks plausible and is wrong, which is worse than an error.
 *
 * It is deliberately free of Prisma, of the repository and of the window
 * model: give it days and a definition and it answers buckets, which is what
 * makes the rules testable on their own.
 */

/** The Monday of an index's week, or the first of its month; days are themselves. */
export function bucketStartOf(day: number, grain: Granularity, monthStartOf: (day: number) => number): number {
  if (grain === 'day') return day;
  /* Day 0 of the index is a Thursday, so +3 lands the modulo on Monday. */
  if (grain === 'week') return day - ((((day + 3) % 7) + 7) % 7);
  return monthStartOf(day);
}

/** The days of one bucket, summed into a numerator and a weight. */
interface Sums {
  value: Decimal;
  weight: Decimal;
  /** The last day present in the bucket, for `CLOSING`. */
  lastDay: number | null;
  lastValue: Decimal;
}

const emptySums = (): Sums => ({ value: ZERO, weight: ZERO, lastDay: null, lastValue: ZERO });

function fold(points: readonly DailyPoint[]): Sums {
  const sums = emptySums();
  for (const point of points) {
    sums.value = sums.value.plus(point.value);
    sums.weight = sums.weight.plus(point.weight ?? ZERO);
    if (sums.lastDay === null || point.day > sums.lastDay) {
      sums.lastDay = point.day;
      sums.lastValue = point.value;
    }
  }
  return sums;
}

/**
 * The rolled-up figure for one bucket.
 *
 * `WEIGHTED_MEAN` folds `value` already multiplied by its weight — the source
 * is responsible for that, because only it knows what the weight is — so the
 * division here is the second half of the mean, not the whole of it.
 */
function apply(def: MetricDef, own: Sums, numerator: Sums | null, denominator: Sums | null): MetricValue {
  const asKind = (value: Decimal): MetricValue['value'] => (def.kind === 'MONEY' ? money(value) : value.toNumber());

  switch (def.rollup) {
    case 'SUM':
      return { value: asKind(own.value) };

    case 'CLOSING':
      return { value: asKind(own.lastValue) };

    case 'WEIGHTED_MEAN': {
      if (own.weight.isZero()) return { value: def.kind === 'MONEY' ? money(ZERO) : 0 };
      return { value: asKind(own.value.dividedBy(own.weight)) };
    }

    case 'RECOMPUTE': {
      /* The rule: sum both sides over the bucket, then divide. Averaging the
         daily ratios is the bug this exists to prevent. */
      const top = numerator?.value ?? ZERO;
      const bottom = denominator?.value ?? ZERO;
      const value = bottom.isZero() ? ZERO : top.dividedBy(bottom).times(100);
      return {
        value: value.toDecimalPlaces(2).toNumber(),
        numerator: def.kind === 'MONEY' ? money(top) : top.toNumber(),
        denominator: def.kind === 'MONEY' ? money(bottom) : bottom.toNumber(),
      };
    }
  }
}

export interface BucketedMetric {
  /** Bucket start day index → the metric's value there. */
  byBucket: Map<number, MetricValue>;
  /** The same rule applied across every day in the span. */
  total: MetricValue;
}

/**
 * Roll one metric's days up to a grain.
 *
 * `numerator` and `denominator` are the *days* of those metrics, not their
 * buckets: a ratio is recomputed from raw days at whatever grain is asked
 * for, which is what stops a week from being the mean of its days.
 */
export function rollup(
  def: MetricDef,
  days: readonly DailyPoint[],
  grain: Granularity,
  monthStartOf: (day: number) => number,
  parts?: { numerator: readonly DailyPoint[]; denominator: readonly DailyPoint[] },
): BucketedMetric {
  const group = (points: readonly DailyPoint[]) => {
    const out = new Map<number, DailyPoint[]>();
    for (const point of points) {
      const key = bucketStartOf(point.day, grain, monthStartOf);
      const bucket = out.get(key);
      if (bucket) bucket.push(point);
      else out.set(key, [point]);
    }
    return out;
  };

  const own = group(days);
  const top = parts ? group(parts.numerator) : null;
  const bottom = parts ? group(parts.denominator) : null;

  /* Every bucket any side touched, so a ratio still answers on a day its
     numerator was empty and its denominator was not. */
  const keys = new Set<number>([...own.keys(), ...(top?.keys() ?? []), ...(bottom?.keys() ?? [])]);

  const byBucket = new Map<number, MetricValue>();
  for (const key of [...keys].sort((a, b) => a - b)) {
    byBucket.set(
      key,
      apply(def, fold(own.get(key) ?? []), top ? fold(top.get(key) ?? []) : null, bottom ? fold(bottom.get(key) ?? []) : null),
    );
  }

  const total = apply(def, fold(days), parts ? fold(parts.numerator) : null, parts ? fold(parts.denominator) : null);
  return { byBucket, total };
}
