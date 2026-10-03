import { ALL_GRAINS, type Dimension, type MetricDef } from './metric.types';

/**
 * AN-1: the catalogue.
 *
 * Declared in code and read by the console over `GET /admin/analytics/
 * catalogue`, the way `modules/reports/catalogue.ts` declares the thirteen
 * reports. A request naming a metric that is not here, or a cut a metric does
 * not declare, is refused by name rather than silently ignored.
 *
 * **The nine metrics `/admin/overview/series` already served are the first
 * nine entries, unchanged in key and in meaning.** AN-1 is a refactor: a
 * parity test asserts the registry answers exactly what the old path answers
 * for the same window, and any difference there is a regression, not an
 * improvement.
 *
 * Adding a metric is adding an entry here and a source in `sources.ts`. It
 * must never change a wire type.
 */

const registry = new Map<string, MetricDef>();

/** Register one metric. Throws on a duplicate key — the whole point of this file. */
function metric(def: MetricDef): MetricDef {
  if (registry.has(def.key)) {
    throw new Error(`Metric '${def.key}' is already defined — a metric is defined once.`);
  }
  registry.set(def.key, def);
  return def;
}

/* The cuts the ported nine already support: the series read takes a city and
   a category filter, so those are real today. The rest of `DIMENSIONS` is
   declared per metric as each lot lands its breakdown. */
const CITY_AND_CATEGORY: readonly Dimension[] = ['city', 'state', 'category'];
const CITY_ONLY: readonly Dimension[] = ['city', 'state'];

/* ── A. Scale and value ─────────────────────────────────────────────── */

metric({
  key: 'gmvRecognised',
  name: 'GMV recognised',
  description: 'What left advertiser wallets for media, on the day it was delivered.',
  family: 'scale',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'Platform-side legs of CAMPAIGN_SPEND by occurredAt; accrual gross until any such leg exists.',
  caveat: 'Delivery, not commitment. A month capturing many bookings and delivering few reads low.',
});

metric({
  key: 'bookingsValue',
  name: 'Bookings authorised',
  description: 'What advertisers committed, on the day they pressed pay.',
  family: 'scale',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'Campaign.total by paidAt, status not CANCELLED, plus PackageSale.total paid.',
  caveat: 'Commitment, not delivery. Never add it to GMV — they are the same money counted at two moments.',
});

metric({
  key: 'bookingsCount',
  name: 'Bookings',
  description: 'How many campaigns and package sales were paid for.',
  family: 'scale',
  kind: 'COUNT',
  rollup: 'SUM',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'Count of the rows behind bookingsValue.',
});

metric({
  key: 'packageSales',
  name: 'Package sales',
  description: 'What was paid for packages rather than for a campaign of spots.',
  family: 'scale',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'PackageSale.total by paidAt.',
  caveat: 'Not cut by category or listing: a package is not bought against a spot, so a listing filter drops it entirely.',
});

metric({
  key: 'averageBookingValue',
  name: 'Average booking value',
  description: 'What a booking is worth on average.',
  family: 'scale',
  kind: 'MONEY',
  rollup: 'RECOMPUTE',
  numerator: 'bookingsValue',
  denominator: 'bookingsCount',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'bookingsValue / bookingsCount, recomputed at every grain.',
});

/* ── E. Demand ──────────────────────────────────────────────────────── */

metric({
  key: 'advertiserSpend',
  name: 'Advertiser spend',
  description: 'GMV recognised plus package sales — what left advertiser wallets altogether.',
  family: 'demand',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'gmvRecognised + packageSales.',
});

/* ── L. Money ───────────────────────────────────────────────────────── */

metric({
  key: 'publisherEarnings',
  name: 'Publisher earnings',
  description: 'What publishers earned, net of commission and tax, on the day it accrued.',
  family: 'money',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'EarningAccrual.net by forDate.',
});

/* ── I. Workforce ───────────────────────────────────────────────────── */

metric({
  key: 'agentCommissions',
  name: 'Agent commissions',
  description: 'Incentives credited to agents.',
  family: 'workforce',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'AgentIncentive.amount by verifiedAt, placed in the agent’s city.',
});

metric({
  key: 'agentsActivated',
  name: 'Agents activated',
  description: 'Agents who became active.',
  family: 'workforce',
  kind: 'COUNT',
  rollup: 'SUM',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'Agent activation stamp.',
});

/* ── J. Acquisition ─────────────────────────────────────────────────── */

metric({
  key: 'publishersOnboarded',
  name: 'Publishers onboarded',
  description: 'Publishers who came on, by whichever door.',
  family: 'acquisition',
  kind: 'COUNT',
  rollup: 'SUM',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'Publisher onboarding stamp (onboardedAt).',
});

metric({
  key: 'advertisersOnboarded',
  name: 'Advertisers onboarded',
  description: 'Advertisers who came on, by whichever door.',
  family: 'acquisition',
  kind: 'COUNT',
  rollup: 'SUM',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'Advertiser onboarding stamp (onboardedAt).',
});

metric({
  key: 'accountsOnboarded',
  name: 'Accounts onboarded',
  description: 'Publishers and advertisers together.',
  family: 'acquisition',
  kind: 'COUNT',
  rollup: 'SUM',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'publishersOnboarded + advertisersOnboarded.',
});

/* ── C. Inventory ───────────────────────────────────────────────────── */

metric({
  key: 'bookedSlotDays',
  name: 'Booked slot-days',
  description: 'Spot flight-days inside the bucket, times the slots each took.',
  family: 'inventory',
  kind: 'COUNT',
  rollup: 'SUM',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'BOOKED, LIVE or COMPLETED spots on ACTIVE listings, clipped to the bucket.',
});

metric({
  key: 'availableSlotDays',
  name: 'Available slot-days',
  description: 'Every live listing’s slots, for each day it was live in the bucket.',
  family: 'inventory',
  kind: 'COUNT',
  rollup: 'SUM',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'Listing.slotsTotal × days live from publishedAt.',
});

metric({
  key: 'occupancyPct',
  name: 'Occupancy',
  description: 'The share of available slot-days that were booked.',
  family: 'inventory',
  kind: 'RATIO',
  rollup: 'RECOMPUTE',
  numerator: 'bookedSlotDays',
  denominator: 'availableSlotDays',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'bookedSlotDays / availableSlotDays — the same arithmetic as the fill-rate tile.',
  caveat: 'Quantity is not capped at the slot count, so an over-booked screen reads above 100 %. That is the fact, not a bug.',
});

/* ── D. Yield ───────────────────────────────────────────────────────── */

metric({
  key: 'realisedRatePerDay',
  name: 'Realised rate per day',
  description: 'What a booked slot-day actually earned, gross.',
  family: 'yield',
  kind: 'MONEY',
  rollup: 'RECOMPUTE',
  numerator: 'accrualGross',
  denominator: 'bookedSlotDays',
  dimensions: CITY_ONLY,
  grains: ALL_GRAINS,
  source: 'Accrual gross / booked slot-days.',
  caveat: 'Gross, before commission and tax — this is what the market cleared at, not what the publisher kept.',
});

metric({
  key: 'accrualGross',
  name: 'Accrued gross',
  description: 'The gross value accrued against listings, before commission and tax.',
  family: 'yield',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'EarningAccrual.gross by forDate.',
});

metric({
  key: 'effectiveCommissionPct',
  name: 'Effective commission',
  description: 'The commission ADX actually kept, over the gross it was taken from.',
  family: 'margin',
  kind: 'RATIO',
  rollup: 'RECOMPUTE',
  numerator: 'accrualCommission',
  denominator: 'accrualGross',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'sum(EarningAccrual.commission) / sum(EarningAccrual.gross).',
  caveat: 'Not the take rate. This is commission on accrued media only; the take rate is over all GMV.',
});

metric({
  key: 'platformRevenue',
  name: 'Platform revenue',
  description: 'What ADX kept — net movement on the revenue account, reversals included.',
  family: 'margin',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: [],
  grains: ALL_GRAINS,
  source: 'LedgerLeg on platform:revenue by transaction occurredAt.',
  caveat: 'Recognised as each day accrues, so it follows delivery rather than the day a booking was paid for.',
});

metric({
  key: 'takeRatePct',
  name: 'Take rate',
  description: 'ADX’s revenue as a share of the money that moved through the platform.',
  family: 'margin',
  kind: 'RATIO',
  rollup: 'RECOMPUTE',
  numerator: 'platformRevenue',
  denominator: 'gmvRecognised',
  dimensions: [],
  grains: ALL_GRAINS,
  source: 'platformRevenue / gmvRecognised, recomputed at every grain.',
  caveat: 'Over GMV recognised, never over bookings authorised — a month capturing many bookings and delivering few would otherwise read low for the wrong reason.',
});

metric({
  key: 'accrualCommission',
  name: 'Commission accrued',
  description: 'ADX’s commission on accrued media.',
  family: 'margin',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'EarningAccrual.commission by forDate.',
});

metric({
  key: 'taxWithheld',
  name: 'Tax withheld',
  description: 'Tax withheld from publisher earnings at source.',
  family: 'money',
  kind: 'MONEY',
  rollup: 'SUM',
  dimensions: CITY_AND_CATEGORY,
  grains: ALL_GRAINS,
  source: 'EarningAccrual.taxWithheld by forDate.',
});

/* ── The reads ──────────────────────────────────────────────────────── */

/** Every metric, in declaration order — the order the picker groups by family. */
export const allMetrics = (): MetricDef[] => [...registry.values()];

/** One metric, or undefined; the caller refuses by name. */
export const metricByKey = (key: string): MetricDef | undefined => registry.get(key);

export const metricKeys = (): string[] => [...registry.keys()];

/** Whether a metric supports a cut. The controller refuses when it does not. */
export const supportsDimension = (def: MetricDef, dimension: Dimension): boolean => def.dimensions.includes(dimension);

/**
 * The metrics that must be fetched to answer these — a `RECOMPUTE` metric
 * needs its two parts, and nothing else does.
 */
export function withParts(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    const def = registry.get(key);
    if (!def) continue;
    out.add(key);
    if (def.numerator) out.add(def.numerator);
    if (def.denominator) out.add(def.denominator);
  }
  return [...out];
}
