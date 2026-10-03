import type { Decimal, Money } from '../../../shared/money';

/**
 * AN-1: the metric model.
 *
 * Every number Analytics can draw is declared here once — its formula's
 * shape, how it rolls up from days into weeks and months, and which cuts it
 * supports. The console reads the registry rather than knowing any of this,
 * so adding a metric is adding an entry and a source, never a wire change.
 *
 * The rule this model exists to enforce is that a metric cannot be defined
 * twice. Before it, `SeriesBucket` was a fixed struct of nine figures and
 * every screen that wanted a tenth computed its own.
 */

/** The cuts a metric can be broken down by. A metric declares its subset. */
export const DIMENSIONS = [
  'city',
  'state',
  'category',
  'venueType',
  'rateGrade',
  'publisher',
  'advertiser',
  'agent',
  'printPartner',
  'campaign',
  'door',
  'side',
  'tier',
  'leadSource',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/**
 * What a metric *is*, which decides how it prints and how it may be combined.
 *
 * - `COUNT`   a whole number of things that happened.
 * - `MONEY`   rupees, always a decimal string, never a float.
 * - `RATIO`   a percentage or a rate, carrying the two figures it came from.
 * - `DURATION` hours or days, always a mean, always weighted.
 * - `BALANCE` a level at a moment, not a flow across one.
 */
export const METRIC_KINDS = ['COUNT', 'MONEY', 'RATIO', 'DURATION', 'BALANCE'] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/**
 * How days become a week or a month. Getting this wrong is the classic
 * analytics bug, so it is declared per metric rather than inferred.
 *
 * - `SUM`           add the days. Only ever right for counts and flows.
 * - `RECOMPUTE`     a ratio: `sum(numerator) / sum(denominator)` over the
 *                   bucket. Never the mean of the daily percentages — seven
 *                   days of "50 %" on wildly different volumes do not make a
 *                   50 % week.
 * - `CLOSING`       a balance: the last day's value. Summing a wallet
 *                   balance over thirty days invents thirty times the money.
 * - `WEIGHTED_MEAN` a duration or an average price: `sum(value × weight) /
 *                   sum(weight)`, the weight being how many things each day's
 *                   figure was measured over.
 */
export const ROLLUPS = ['SUM', 'RECOMPUTE', 'CLOSING', 'WEIGHTED_MEAN'] as const;
export type Rollup = (typeof ROLLUPS)[number];

/** The families of §7 in the brief — how the catalogue groups on screen. */
export const METRIC_FAMILIES = [
  'scale',
  'margin',
  'inventory',
  'yield',
  'demand',
  'liquidity',
  'campaign',
  'fulfilment',
  'workforce',
  'acquisition',
  'retention',
  'money',
  'trust',
  'forecast',
] as const;
export type MetricFamily = (typeof METRIC_FAMILIES)[number];

export interface MetricDef {
  /** Stable and never renamed: the console and saved views address it. */
  key: string;
  /** What the operator reads on the chart. */
  name: string;
  /** One sentence, shown beside the name in the picker. */
  description: string;
  family: MetricFamily;
  kind: MetricKind;
  rollup: Rollup;
  /**
   * `RECOMPUTE` only: the two metrics this one is made of. Both must be in
   * the registry, and both are fetched whenever this one is asked for, so the
   * roll-up can be redone at every grain.
   */
  numerator?: string;
  denominator?: string;
  /** Cuts this metric supports. Asking for another is refused by name. */
  dimensions: readonly Dimension[];
  /** Day, week and month unless the metric genuinely cannot. */
  grains: readonly Granularity[];
  /** Where the figure comes from, for the README and for review. */
  source: string;
  /** What it does not mean. Printed under the chart. */
  caveat?: string;
}

export const GRANULARITIES = ['day', 'week', 'month'] as const;
export type Granularity = (typeof GRANULARITIES)[number];
export const ALL_GRAINS: readonly Granularity[] = GRANULARITIES;

/**
 * One day's contribution to a metric.
 *
 * `weight` is only read by `WEIGHTED_MEAN`: it is how many things the day's
 * figure was measured over, so that a day where one order took ten hours does
 * not outweigh a day where two hundred took two.
 */
export interface DailyPoint {
  /** The Indian day, as the module's day index. */
  day: number;
  value: Decimal;
  weight?: Decimal;
}

/** A metric's answer over a span of days, before bucketing. */
export type MetricDays = readonly DailyPoint[];

/** What a rolled-up bucket carries for one metric. */
export interface MetricValue {
  /** Money as a decimal string, everything else as a number. */
  value: Money | number;
  /** `RECOMPUTE` only: what it was computed from, so the UI can show both. */
  numerator?: Money | number;
  denominator?: Money | number;
}
