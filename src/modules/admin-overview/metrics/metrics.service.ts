import { ApiError } from '../../../shared/errors';
import type { AnalyticsFilter, Window } from '../admin-overview.repository';
import {
  analyticsWindow,
  bucketStartDayIndex,
  filterFor,
  instantOfDayIndex,
  isoOfDayIndex,
  nextBucketStartDayIndex,
} from '../analytics.service';
import type { Dimension, Granularity, MetricDef, MetricValue } from './metric.types';
import { metricByKey, supportsDimension } from './registry';
import { rollup } from './rollup';
import { daysOf, loadDailyMetrics } from './sources';

/**
 * AN-1: one series read for any set of metrics, at any grain.
 *
 * The old `/admin/overview/series` answered a fixed struct of nine figures
 * and hard-coded which of them each segment drew. This answers whatever was
 * asked for, because the registry — not the wire type — says what exists.
 *
 * Both windows come out of one walk, as before: the previous window is the
 * same facts a little earlier, and a ledger walked once is a ledger.
 */

export interface MetricsSeriesQuery {
  from: string;
  to: string;
  grain: Granularity;
  metrics: readonly string[];
  category?: string | undefined;
  city?: string | undefined;
}

export interface MetricsBucket {
  /** The bucket's natural start — the day, the Monday, or the first of the month. */
  bucket: string;
  start: string;
  end: string;
  /** Only the metrics that were asked for. */
  values: Record<string, MetricValue>;
}

export interface MetricsSeries {
  from: string;
  to: string;
  grain: Granularity;
  metrics: string[];
  filters: { category: string | null; city: string | null };
  window: { start: string; end: string };
  previousWindow: { start: string; end: string };
  buckets: MetricsBucket[];
  totals: Record<string, MetricValue>;
  previous: { buckets: MetricsBucket[]; totals: Record<string, MetricValue> };
  /** When this was computed — accruals and campaign metrics can land late. */
  computedAt: string;
}

/** Refuse an unknown metric by name rather than answering an empty series. */
export function resolveMetrics(keys: readonly string[]): MetricDef[] {
  if (keys.length === 0) throw new ApiError(400, 'VALIDATION_ERROR', 'Name at least one metric');
  const out: MetricDef[] = [];
  for (const key of keys) {
    const def = metricByKey(key);
    if (!def) throw new ApiError(400, 'UNKNOWN_METRIC', `No metric named '${key}'`);
    out.push(def);
  }
  return out;
}

/** Refuse a grain a metric does not declare. */
export function assertGrain(defs: readonly MetricDef[], grain: Granularity): void {
  for (const def of defs) {
    if (!def.grains.includes(grain)) {
      throw new ApiError(400, 'UNSUPPORTED_GRAIN', `'${def.key}' cannot be read by ${grain}`);
    }
  }
}

/** Refuse a cut a metric does not declare — never silently ignored. */
export function assertDimension(def: MetricDef, dimension: Dimension): void {
  if (!supportsDimension(def, dimension)) {
    throw new ApiError(400, 'UNSUPPORTED_DIMENSION', `'${def.key}' cannot be broken down by ${dimension}`);
  }
}

/** The bucket starts covering a span, in order. */
function bucketsOf(fromIndex: number, toIndex: number, grain: Granularity): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = bucketStartDayIndex(fromIndex, grain);
  while (start <= toIndex) {
    const next = nextBucketStartDayIndex(start, grain);
    out.push({ start: Math.max(start, fromIndex), end: Math.min(next - 1, toIndex) });
    start = next;
  }
  return out;
}

/** An empty figure of the right shape, so a quiet bucket still draws. */
function zeroOf(def: MetricDef): MetricValue {
  if (def.kind === 'MONEY') return { value: '0.00' };
  return { value: 0 };
}

export async function loadMetricsSeries(query: MetricsSeriesQuery): Promise<MetricsSeries> {
  const defs = resolveMetrics(query.metrics);
  assertGrain(defs, query.grain);

  const window = analyticsWindow(query.from, query.to);
  const span: Window = { start: window.previous.start, end: window.end };
  /* The same resolver the old series uses: `?city=` is a slug or a name, and
     what `inCity` matches on is the catalogue key behind it. Building this by
     hand left the key undefined and a filtered read answered zero. */
  const filter: AnalyticsFilter = await filterFor({
    from: query.from,
    to: query.to,
    granularity: query.grain,
    segment: 'ALL',
    ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.city === undefined ? {} : { city: query.city }),
  });

  const daily = await loadDailyMetrics(span, filter);

  const viewOf = (fromIndex: number, toIndex: number) => {
    const spans = bucketsOf(fromIndex, toIndex, query.grain);
    const buckets: MetricsBucket[] = spans.map((s) => ({
      bucket: isoOfDayIndex(bucketStartDayIndex(s.start, query.grain)),
      start: instantOfDayIndex(s.start).toISOString(),
      end: instantOfDayIndex(s.end + 1).toISOString(),
      values: {},
    }));
    const byStart = new Map(spans.map((s, i) => [bucketStartDayIndex(s.start, query.grain), i]));
    const totals: Record<string, MetricValue> = {};

    for (const def of defs) {
      /* Clip to this window before rolling up: the walk covered both. */
      const clip = (points: readonly { day: number; value: import('../../../shared/money').Decimal; weight?: import('../../../shared/money').Decimal }[]) =>
        points.filter((point) => point.day >= fromIndex && point.day <= toIndex);

      const parts =
        def.rollup === 'RECOMPUTE' && def.numerator && def.denominator
          ? { numerator: clip(daysOf(daily, def.numerator)), denominator: clip(daysOf(daily, def.denominator)) }
          : undefined;

      const rolled = rollup(def, clip(daysOf(daily, def.key)), query.grain, (day) => bucketStartDayIndex(day, 'month'), parts);
      totals[def.key] = rolled.total;
      for (const [start, value] of rolled.byBucket) {
        const index = byStart.get(start);
        if (index !== undefined) buckets[index]!.values[def.key] = value;
      }
      for (const bucket of buckets) {
        if (!(def.key in bucket.values)) bucket.values[def.key] = zeroOf(def);
      }
    }
    return { buckets, totals };
  };

  const current = viewOf(window.fromIndex, window.toIndex);
  const before = viewOf(window.fromIndex - window.days, window.fromIndex - 1);

  return {
    from: query.from,
    to: query.to,
    grain: query.grain,
    metrics: defs.map((def) => def.key),
    filters: { category: query.category ?? null, city: query.city ?? null },
    window: { start: window.start.toISOString(), end: window.end.toISOString() },
    previousWindow: { start: window.previous.start.toISOString(), end: window.previous.end.toISOString() },
    buckets: current.buckets,
    totals: current.totals,
    previous: { buckets: before.buckets, totals: before.totals },
    computedAt: new Date().toISOString(),
  };
}

/** The cache key for a series read. */
export const metricsSeriesCacheKey = (query: MetricsSeriesQuery): string =>
  [
    'admin-analytics:series',
    query.from,
    query.to,
    query.grain,
    [...query.metrics].sort().join('+'),
    query.category ?? '',
    query.city ?? '',
  ].join(':');
