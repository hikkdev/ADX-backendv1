import { Decimal, money, type Money } from '../../shared/money';
import {
  foldProvenance,
  meanAgreement,
  provenanceOf,
  type AudienceProvenanceByField,
  type AudienceShare,
  type AudienceVendor,
  type BlendedAudienceCatchment,
} from '../../shared/audience';
import { audienceForSpots, currentPeriod, type SpotAudience } from '../listings';
import { dynamicCodeAnalytics, type Breakdown } from '../../shared/qr-engine';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import type { CampaignAggregate, MetricRow } from './campaigns.repository';
import { flightDays, type Actor } from './campaigns.service';

/**
 * Campaign analytics.
 *
 * The hard part of this file is not the arithmetic — it is refusing to make
 * numbers up. Out-of-home has no impression pixel. What ADX can actually
 * observe is: what was spent, how many sites were live on a given day, and how
 * many people scanned a code it issued. Everything else on an analytics screen
 * elsewhere in the industry is modelled, and modelling it here without a data
 * source would be inventing it.
 *
 * So every figure returned carries its provenance:
 *
 *   MEASURED   ADX watched it happen — spend, spots live, scans, clicks
 *   REPORTED   the advertiser told us — promo redemptions
 *   ESTIMATED  arithmetic over publisher-stated footfall, with the sample size
 *   UNAVAILABLE nothing backs it yet — location lift, demographics
 *
 * The screens render the label next to the number. An estimate that cannot say
 * how it was reached is a guess wearing a suit.
 */

export type Provenance = 'MEASURED' | 'REPORTED' | 'ESTIMATED' | 'UNAVAILABLE';

export type Metric = {
  value: number | null;
  provenance: Provenance;
  /** Says where the number came from, in words a person can check. */
  basis: string;
};

export type CampaignAnalytics = {
  campaignId: string;
  reference: string;
  name: string;
  status: CampaignAggregate['status'];
  startDate: string | null;
  endDate: string | null;
  /** Days elapsed of days booked. */
  daysElapsed: number;
  daysTotal: number;

  /** E11-2: `onTrack` the way the portfolio's budget tile says it — spend running no faster than what was committed; null with nothing committed. */
  spend: { toDate: Money; committed: Money; budget: Money | null; onTrack: boolean | null };
  spotsLive: number;
  spotsBooked: number;

  reach: Metric;
  scans: Metric;
  clicks: Metric;
  clickRate: Metric;
  redemptions: Metric;

  /** One point a day, for the performance chart. */
  series: {
    day: string;
    spend: Money;
    spotsLive: number;
    scans: number;
    clicks: number;
    estimatedReach: number | null;
  }[];

  /** What the campaign bought, by media type — the honest version of the donut. */
  mix: { label: string; spots: number; spend: Money; share: number }[];

  /** Per-site, so a booking can be judged on its own. */
  bySpot: {
    spotId: string;
    title: string;
    city: string | null;
    ratePerDay: Money;
    days: number;
    spend: Money;
    scans: number;
    clicks: number;
    estimatedDailyFootfall: number | null;
  }[];
  /**
   * Lot D (Q107): the same rows folded by the listing's city — what a
   * multi-market campaign did in each market. Cities are matched
   * case-insensitively and printed as first recorded; spots with no city
   * fold under null, last.
   */
  byMarket: { market: string | null; spots: number; spend: Money; scans: number; clicks: number }[];

  /**
   * Lot D (Q7): what happened on the landing page after the scan — views,
   * CTA presses, form submissions — folded by device class, IST hour, city
   * and CTA label. Every row is a TrackingEvent ADX recorded itself, so the
   * provenance is MEASURED; the panel is empty rather than invented when
   * the campaign has no page.
   */
  interactions: {
    provenance: 'MEASURED';
    basis: string;
    byDevice: { device: string | null; count: number }[];
    byHour: { hourIst: number | null; count: number }[];
    byCity: { city: string | null; count: number }[];
    byCta: { ctaLabel: string | null; count: number }[];
  };
  /** Nothing ADX observed backs an audience split: no pixel. The vendor panel, when one is configured, is `audience`. */
  demographics: Metric;
  /**
   * G7 (Q109): the Audience Breakdown — the footfall / data-panel vendor's
   * view of the campaign's sites, folded over the booked spots and weighted
   * by the days each ran (× quantity). PANEL provenance and the vendor's
   * name on every answer; null when no vendor is configured, so the screen
   * says "no panel backs this" rather than drawing a figure.
   */
  audience: CampaignAudience | null;
  /** E11-2: the deltas the frame prints — this window against the one before it, from the stored daily metrics. */
  comparison: WindowComparison;
  /**
   * QR-1: what the QR engine saw on the dynamic codes it hosts in front of
   * this campaign's `/t/` codes — folded across the codes. A second log of
   * the same scans, kept BESIDE `scans` (ADX's own, MEASURED) and never in
   * its place: the engine sees the phone's country, city, browser and OS
   * that ADX deliberately does not read. Provenance `ENGINE` and the
   * engine's name; null when no engine hosts any of the campaign's codes.
   */
  engine: CampaignEngineView | null;
};

export type CampaignEngineView = {
  provenance: 'ENGINE';
  engine: 'GENQR';
  basis: string;
  /** Codes the engine hosts, of the campaign's QR codes. */
  codesLinked: number;
  codesTotal: number;
  /** Codes the engine could not answer for on this read — the fold is over the rest. */
  codesUnanswered: number;
  days: number;
  totalScans: number;
  scansInWindow: number;
  scansByDay: { date: string; count: number }[];
  hourlyBreakdown: { hour: number; count: number }[];
  deviceBreakdown: Breakdown;
  browserBreakdown: Breakdown;
  osBreakdown: Breakdown;
  countryBreakdown: { label: string; code: string | null; count: number }[];
  cityBreakdown: Breakdown;
};

/** Sums labelled breakdowns across codes, most first. */
function foldBreakdown<T extends { label: string; count: number }>(rows: T[][]): T[] {
  const out = new Map<string, T>();
  for (const list of rows) {
    for (const row of list) {
      const found = out.get(row.label);
      if (found) found.count += row.count;
      else out.set(row.label, { ...row });
    }
  }
  return [...out.values()].sort((a, b) => b.count - a.count);
}

/**
 * QR-1: the engine's view of the campaign, folded over its hosted codes.
 * Null when nothing is hosted; a code the engine cannot answer for is
 * counted in `codesUnanswered` rather than failing the panel.
 */
export async function campaignEngineView(codes: CampaignAggregate['codes'], days: number): Promise<CampaignEngineView | null> {
  const qrCodes = codes.filter((code) => code.method === 'QR_OR_DEEPLINK');
  const hosted = qrCodes.filter((code) => code.engineCodeId);
  if (hosted.length === 0) return null;
  const answers = await dynamicCodeAnalytics(hosted.map((code) => code.engineCodeId!), days);
  const got = [...answers.values()];
  const byDate = new Map<string, number>();
  const byHour = new Map<number, number>();
  for (const answer of got) {
    for (const point of answer.scansByDay) byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.count);
    for (const point of answer.hourlyBreakdown) byHour.set(point.hour, (byHour.get(point.hour) ?? 0) + point.count);
  }
  return {
    provenance: 'ENGINE',
    engine: 'GENQR',
    basis: `Scans of the ${hosted.length} hosted code${hosted.length === 1 ? '' : 's'} as GenQR recorded them before sending the person to ADX — a second log of the same scans, with the phone's geography and browser`,
    codesLinked: hosted.length,
    codesTotal: qrCodes.length,
    codesUnanswered: hosted.length - got.length,
    days,
    totalScans: got.reduce((sum, answer) => sum + answer.totalScans, 0),
    scansInWindow: got.reduce((sum, answer) => sum + answer.scansInWindow, 0),
    scansByDay: [...byDate.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
    hourlyBreakdown: Array.from({ length: 24 }, (_, hour) => ({ hour, count: byHour.get(hour) ?? 0 })),
    deviceBreakdown: foldBreakdown(got.map((answer) => answer.deviceBreakdown)),
    browserBreakdown: foldBreakdown(got.map((answer) => answer.browserBreakdown)),
    osBreakdown: foldBreakdown(got.map((answer) => answer.osBreakdown)),
    countryBreakdown: foldBreakdown(got.map((answer) => answer.countryBreakdown)),
    cityBreakdown: foldBreakdown(got.map((answer) => answer.cityBreakdown)),
  };
}

/* ------------------------------------------------------------------ */
/* G7 (Q109): the audience panel, folded over the spots                */
/* ------------------------------------------------------------------ */

export type CampaignAudience = {
  provenance: 'PANEL';
  /** The one name an old reader prints — the footfall primary in force. */
  vendor: string;
  /** Y-B: the vendors in force, and per field group who the folded figures came from (one vendor, or BLENDED across sites or within one). */
  vendors: AudienceVendor[];
  provenanceByField: AudienceProvenanceByField;
  /** Y-B: the mean of the sites' vendor agreement on daily footfall (1 = identical); null unless both vendors answered somewhere. */
  agreement: { footfall: number | null };
  /** YYYY-MM the panels were read for. */
  period: string;
  basis: string;
  /** Sites with a panel, of the sites folded. */
  spotsWithData: number;
  spotsTotal: number;
  /** Footfall summed across the sites' catchments — the campaign's daily audience across its sites. */
  footfall: { daily: number | null; byHour: number[] | null; byWeekday: number[] | null };
  /** Shares averaged across sites, weighted by days × quantity. */
  demographics: {
    ageBands: AudienceShare[] | null;
    gender: AudienceShare[] | null;
    incomeBands: AudienceShare[] | null;
    affinities: AudienceShare[] | null;
  };
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Weighted mean of a share group across sites; null when no site carries it. */
function foldShares(rows: { weight: number; shares: AudienceShare[] | null }[]): AudienceShare[] | null {
  const carrying = rows.filter((r): r is { weight: number; shares: AudienceShare[] } => r.shares !== null && r.weight > 0);
  if (carrying.length === 0) return null;
  const totalWeight = carrying.reduce((sum, r) => sum + r.weight, 0);
  const byLabel = new Map<string, number>();
  for (const row of carrying) {
    for (const share of row.shares) {
      byLabel.set(share.label, (byLabel.get(share.label) ?? 0) + (share.share * row.weight) / totalWeight);
    }
  }
  return [...byLabel.entries()].map(([label, share]) => ({ label, share: round1(share) }));
}

/** Element-wise weighted mean of a profile; null when no site carries one of the right length. */
function foldProfile(rows: { weight: number; profile: number[] | null }[], length: number): number[] | null {
  const carrying = rows.filter((r): r is { weight: number; profile: number[] } => r.profile !== null && r.profile.length === length && r.weight > 0);
  if (carrying.length === 0) return null;
  const totalWeight = carrying.reduce((sum, r) => sum + r.weight, 0);
  return Array.from({ length }, (_, i) => round1(carrying.reduce((sum, r) => sum + (r.profile[i]! * r.weight) / totalWeight, 0)));
}

/**
 * Folds the per-spot panels into the campaign's — pure, so the arithmetic
 * is testable on its own. Footfall is SUMMED across sites (a campaign's
 * audience is every site's catchment); shares and profiles are AVERAGED,
 * weighted by the days each site ran × its quantity, so a site booked for
 * a month counts more than one booked for a weekend. A spot with no panel
 * is counted in `spotsTotal` and nowhere else.
 */
export function foldAudience(
  spots: { listingId: string; days: number; quantity: number }[],
  panels: SpotAudience[],
  vendor: string,
  period: string,
  vendors: AudienceVendor[] = [vendor as AudienceVendor],
): CampaignAudience {
  const byListing = new Map(panels.map((p) => [p.listingId, p.audience] as const));
  const rows = spots.map((spot) => ({ weight: Math.max(spot.days, 1) * Math.max(spot.quantity, 1), audience: byListing.get(spot.listingId) ?? null }));
  const withData = rows.filter((r): r is { weight: number; audience: BlendedAudienceCatchment } => r.audience !== null);
  const dailyRows = withData.filter((r) => r.audience.footfall.daily !== null);
  const label = vendors.length > 1 ? vendors.join(' + ') : vendor;
  return {
    provenance: 'PANEL',
    vendor,
    vendors,
    provenanceByField: foldProvenance(withData.map((r) => provenanceOf(r.audience))),
    agreement: { footfall: meanAgreement(withData.map((r) => r.audience.agreement?.footfall)) },
    period,
    basis:
      withData.length === 0
        ? `${label} ${vendors.length > 1 ? 'have' : 'has'} no panel for any of the ${spots.length} booked site${spots.length === 1 ? '' : 's'} in ${period}`
        : `${label} panel${vendors.length > 1 ? 's, blended,' : ''} on ${withData.length} of ${spots.length} booked site${spots.length === 1 ? '' : 's'}, ${period}; shares weighted by days booked`,
    spotsWithData: withData.length,
    spotsTotal: spots.length,
    footfall: {
      daily: dailyRows.length === 0 ? null : dailyRows.reduce((sum, r) => sum + (r.audience.footfall.daily ?? 0), 0),
      byHour: foldProfile(withData.map((r) => ({ weight: r.weight, profile: r.audience.footfall.byHour })), 24),
      byWeekday: foldProfile(withData.map((r) => ({ weight: r.weight, profile: r.audience.footfall.byWeekday })), 7),
    },
    demographics: {
      ageBands: foldShares(withData.map((r) => ({ weight: r.weight, shares: r.audience.demographics.ageBands }))),
      gender: foldShares(withData.map((r) => ({ weight: r.weight, shares: r.audience.demographics.gender }))),
      incomeBands: foldShares(withData.map((r) => ({ weight: r.weight, shares: r.audience.demographics.incomeBands }))),
      affinities: foldShares(withData.map((r) => ({ weight: r.weight, shares: r.audience.demographics.affinities }))),
    },
  };
}

/**
 * The month the panels are read for: the latest month the flight has
 * actually run in (a panel describes a month, and the most recent one is
 * the one the advertiser is watching); the start month before the flight
 * begins; this month for a campaign with no dates yet.
 */
export function audiencePeriodFor(start: Date | null, end: Date | null, now: Date): string {
  if (!start) return currentPeriod(now);
  if (start > now) return currentPeriod(start);
  const elapsedEnd = end && end < now ? end : now;
  return currentPeriod(elapsedEnd);
}

/** The audience for a campaign's booked spots, never throwing — a vendor failure is a null panel and a log line inside `audienceForSpots`. */
async function campaignAudienceFor(
  booked: { listingId: string; days: number; quantity: number; listing: { latitude: number | null; longitude: number | null } }[],
  start: Date | null,
  end: Date | null,
  now: Date,
): Promise<CampaignAudience | null> {
  if (booked.length === 0) return null;
  const period = audiencePeriodFor(start, end, now);
  const panels = await audienceForSpots(
    booked.map((spot) => ({ listingId: spot.listingId, latitude: spot.listing.latitude, longitude: spot.listing.longitude })),
    period,
  ).catch(() => null);
  if (!panels) return null;
  return foldAudience(booked, panels.spots, panels.vendor, period, panels.vendors ?? [panels.vendor]);
}

/* ------------------------------------------------------------------ */
/* E11-2: the previous window                                          */
/* ------------------------------------------------------------------ */

/**
 * One headline metric against the window of the same length immediately
 * before this one. `previous` is that window's value, `deltaPct` how far
 * this window moved from it (null when the previous value was zero — there
 * is no percentage of nothing). Null altogether when the previous window
 * has no stored rows, or none that can carry the metric: a campaign in its
 * first week prints no delta rather than "+100%".
 *
 * The provenance is the metric's own. Spend, scans and clicks were watched
 * by ADX (MEASURED); reach is arithmetic over publisher-stated footfall
 * (ESTIMATED), exactly as the tile it sits under says.
 */
export type MetricComparison<V = number> = {
  previous: V;
  deltaPct: number | null;
  provenance: 'MEASURED' | 'ESTIMATED';
  basis: string;
} | null;

export type WindowComparison = {
  /** Inclusive UTC days; the previous window ends the day before `from`. */
  window: { days: number; from: string; to: string; previousFrom: string; previousTo: string };
  totalReach: MetricComparison<number>;
  clickRate: MetricComparison<number>;
  budgetSpent: MetricComparison<Money>;
};

const utcDay = (date: Date): Date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/** The two windows the comparison reads: [previousFrom, to], `days` long each, ending today. */
export function comparisonSpan(now: Date, days: number): { from: Date; to: Date; previousFrom: Date; previousTo: Date } {
  const to = utcDay(now);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  const previousTo = new Date(from);
  previousTo.setUTCDate(previousTo.getUTCDate() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setUTCDate(previousFrom.getUTCDate() - (days - 1));
  return { from, to, previousFrom, previousTo };
}

const deltaPct = (current: Decimal, previous: Decimal): number | null =>
  previous.isZero() ? null : Math.round(current.minus(previous).dividedBy(previous).times(1000).toNumber()) / 10;

/**
 * Folds stored daily rows into the comparison — pure, so the arithmetic is
 * testable on two windows of rows. A row outside both windows is ignored;
 * `now` is the end of the current window and `days` its length.
 */
export function compareWindows(rows: MetricRow[], now: Date, days: number): WindowComparison {
  const span = comparisonSpan(now, days);
  const fold = (from: Date, to: Date) => {
    const inside = rows.filter((row) => row.day >= from && row.day <= to);
    const reached = inside.filter((row) => row.estimatedReach !== null);
    return {
      rows: inside.length,
      spend: inside.reduce((sum, row) => sum.plus(new Decimal(row.spend)), new Decimal(0)),
      scans: inside.reduce((sum, row) => sum + row.scans, 0),
      clicks: inside.reduce((sum, row) => sum + row.clicks, 0),
      reach: reached.length > 0 ? reached.reduce((sum, row) => sum + (row.estimatedReach ?? 0), 0) : null,
    };
  };
  const current = fold(span.from, span.to);
  const previous = fold(span.previousFrom, span.previousTo);
  const window = {
    days,
    from: dayKey(span.from),
    to: dayKey(span.to),
    previousFrom: dayKey(span.previousFrom),
    previousTo: dayKey(span.previousTo),
  };
  const previousLabel = `${window.previousFrom} to ${window.previousTo}`;
  if (previous.rows === 0) return { window, totalReach: null, clickRate: null, budgetSpent: null };

  const rate = (clicks: number, scans: number): Decimal | null =>
    scans > 0 ? new Decimal(clicks).dividedBy(scans).times(100) : null;
  const previousRate = rate(previous.clicks, previous.scans);
  const currentRate = rate(current.clicks, current.scans) ?? new Decimal(0);

  return {
    window,
    totalReach:
      previous.reach === null
        ? null
        : {
            previous: previous.reach,
            deltaPct: deltaPct(new Decimal(current.reach ?? 0), new Decimal(previous.reach)),
            provenance: 'ESTIMATED',
            basis: `Publisher-stated footfall over the stored days ${previousLabel}`,
          },
    clickRate:
      previousRate === null
        ? null
        : {
            previous: Math.round(previousRate.times(10).toNumber()) / 10,
            deltaPct: deltaPct(currentRate, previousRate),
            provenance: 'MEASURED',
            basis: `${previous.clicks} of ${previous.scans} scans reached the destination ${previousLabel}`,
          },
    budgetSpent: {
      previous: money(previous.spend),
      deltaPct: deltaPct(current.spend, previous.spend),
      provenance: 'MEASURED',
      basis: `Spend recorded over ${previous.rows} stored day${previous.rows === 1 ? '' : 's'} ${previousLabel}`,
    },
  };
}

/** The comparison for one or many campaigns, read in one query over both windows. */
async function comparisonFor(campaignIds: string[], now: Date, days: number): Promise<WindowComparison> {
  const span = comparisonSpan(now, days);
  const rows = campaignIds.length === 0 ? [] : await repository.dailyMetricsFor(campaignIds, span.previousFrom, span.to);
  return compareWindows(rows, now, days);
}

const DEFAULT_COMPARISON_DAYS = 7;

/** Folds the per-spot rows by city — pure, so the shape is testable on its own. */
export function foldByMarket(
  rows: { city: string | null; spend: Money; scans: number; clicks: number }[],
): CampaignAnalytics['byMarket'] {
  const buckets = new Map<string, { market: string | null; spots: number; spend: Decimal; scans: number; clicks: number }>();
  for (const row of rows) {
    const key = row.city ? row.city.trim().toLowerCase() : '';
    const bucket = buckets.get(key) ?? { market: row.city ? row.city.trim() : null, spots: 0, spend: new Decimal(0), scans: 0, clicks: 0 };
    bucket.spots += 1;
    bucket.spend = bucket.spend.plus(new Decimal(row.spend));
    bucket.scans += row.scans;
    bucket.clicks += row.clicks;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => (a.market === null ? 1 : b.market === null ? -1 : 0))
    .map((bucket) => ({ ...bucket, spend: money(bucket.spend) }));
}

const dayKey = (date: Date): string => date.toISOString().slice(0, 10);

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

/** Every day from `from` to `to` inclusive, capped so a decade-long typo cannot hang the request. */
function daysBetween(from: Date, to: Date, cap = 400): Date[] {
  const days: Date[] = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
  while (cursor <= end && days.length < cap) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

/**
 * Reads one campaign's performance.
 *
 * The series is built from the campaign's own dates rather than from whatever
 * rows happen to exist, so a day with no scans is a zero on the chart instead of
 * a gap — a gap reads as missing data when it is in fact a quiet Tuesday.
 */
export async function campaignAnalytics(
  campaign: CampaignAggregate,
  now = new Date(),
  /**
   * The portfolio view folds fifty campaigns and has no panel for the
   * interactions; it skips the four queries — and (E11-2) reads the
   * comparison once across every campaign rather than once per campaign.
   * `days` is the comparison window, seven by default.
   */
  options: { interactions?: boolean; comparison?: boolean; days?: number | undefined; audience?: boolean; engine?: boolean } = {}
): Promise<CampaignAnalytics> {
  const daysTotal = flightDays(campaign.startDate, campaign.endDate);
  const start = campaign.startDate;
  const end = campaign.endDate;

  const elapsedEnd = end && end < now ? end : now;
  const daysElapsed =
    start && start <= now ? Math.min(daysTotal, flightDays(start, elapsedEnd)) : 0;

  const live = campaign.spots.filter((spot) => spot.status === 'LIVE');
  const booked = campaign.spots.filter(
    (spot) => spot.status === 'BOOKED' || spot.status === 'LIVE' || spot.status === 'COMPLETED'
  );

  /* Spend to date: the daily rate of every booked spot, for the days that have
     actually run. Committed: the whole flight, which is what was authorised. */
  const dailyRate = booked.reduce(
    (sum, spot) => sum.plus(new Decimal(spot.ratePerDay).times(spot.quantity)),
    new Decimal(0)
  );
  const spendToDate = dailyRate.times(daysElapsed);
  const committed = campaign.total ? new Decimal(campaign.total) : dailyRate.times(daysTotal);

  const totals = await repository.trackingTotals(campaign.id);
  const interactions =
    options.interactions === false
      ? { byDevice: [], byHour: [], byCity: [], byCta: [] }
      : await repository.interactionTotals(campaign.id);
  const comparisonDays = Math.min(Math.max(options.days ?? DEFAULT_COMPARISON_DAYS, 1), 90);
  const comparison =
    options.comparison === false
      ? compareWindows([], now, comparisonDays)
      : await comparisonFor([campaign.id], now, comparisonDays);
  // G7 (Q109): the vendor panel, through the per-spot snapshots. Skipped for
  // the portfolio view, which has no panel for it and fifty campaigns to fold.
  const audience = options.audience === false ? null : await campaignAudienceFor(booked, start, end, now);
  // QR-1: the engine's log of the same scans — skipped for the portfolio
  // view, which has no panel for it and would ask the engine fifty times.
  const engine = options.engine === false ? null : await campaignEngineView(campaign.codes, Math.min(Math.max(daysTotal || 30, 1), 365));

  /* Reach: publisher-stated footfall, over the days each spot has run. Null when
     no booked site states one — which is common, and worth saying out loud. */
  const withFootfall = booked.filter((spot) => spot.listing.estimatedDailyFootfall);
  const estimatedReach =
    withFootfall.length > 0
      ? withFootfall.reduce(
          (sum, spot) => sum + (spot.listing.estimatedDailyFootfall ?? 0) * daysElapsed * spot.quantity,
          0
        )
      : null;

  const events =
    start && end
      ? await repository.eventTotalsByDay(campaign.id, start, addDays(elapsedEnd, 1))
      : [];
  const eventsByDay = new Map<string, { scans: number; clicks: number }>();
  for (const row of events) {
    const bucket = eventsByDay.get(row.day) ?? { scans: 0, clicks: 0 };
    if (row.type === 'SCAN') bucket.scans += row.count;
    if (row.type === 'CLICK') bucket.clicks += row.count;
    eventsByDay.set(row.day, bucket);
  }

  const series =
    start && daysElapsed > 0
      ? daysBetween(start, elapsedEnd).map((day) => {
          const key = dayKey(day);
          const counts = eventsByDay.get(key) ?? { scans: 0, clicks: 0 };
          const perDayReach = withFootfall.reduce(
            (sum, spot) => sum + (spot.listing.estimatedDailyFootfall ?? 0) * spot.quantity,
            0
          );
          return {
            day: key,
            spend: money(dailyRate),
            spotsLive: booked.length,
            scans: counts.scans,
            clicks: counts.clicks,
            estimatedReach: withFootfall.length > 0 ? perDayReach : null,
          };
        })
      : [];

  /* The mix: what was bought, by media type. This is what the frame's donut can
     honestly show — a demographic split would need audience data nobody has. */
  const byMedia = new Map<string, { spots: number; spend: Decimal }>();
  for (const spot of booked) {
    const label = spot.listing.mediaType?.name ?? 'Unclassified';
    const bucket = byMedia.get(label) ?? { spots: 0, spend: new Decimal(0) };
    bucket.spots += spot.quantity;
    bucket.spend = bucket.spend.plus(new Decimal(spot.lineTotal));
    byMedia.set(label, bucket);
  }
  const mixTotal = [...byMedia.values()].reduce((sum, row) => sum.plus(row.spend), new Decimal(0));
  const mix = [...byMedia.entries()]
    .map(([label, row]) => ({
      label,
      spots: row.spots,
      spend: money(row.spend),
      share: mixTotal.greaterThan(0)
        ? Math.round(row.spend.dividedBy(mixTotal).times(100).toNumber())
        : 0,
    }))
    .sort((a, b) => Number(b.spend) - Number(a.spend));

  const scansBySpot = new Map<string, { scans: number; clicks: number }>();
  for (const code of campaign.codes) {
    if (!code.spotId) continue;
    const bucket = scansBySpot.get(code.spotId) ?? { scans: 0, clicks: 0 };
    bucket.scans += code.scans;
    bucket.clicks += code.clicks;
    scansBySpot.set(code.spotId, bucket);
  }

  const bySpot: CampaignAnalytics['bySpot'] = booked.map((spot) => {
    const counts = scansBySpot.get(spot.id) ?? { scans: 0, clicks: 0 };
    return {
      spotId: spot.id,
      title: spot.listing.title,
      city: spot.listing.city,
      ratePerDay: money(spot.ratePerDay),
      days: spot.days,
      spend: money(new Decimal(spot.ratePerDay).times(spot.quantity).times(daysElapsed)),
      scans: counts.scans,
      clicks: counts.clicks,
      estimatedDailyFootfall: spot.listing.estimatedDailyFootfall,
    };
  });

  const clickRate =
    totals.scans > 0 ? Math.round((totals.clicks / totals.scans) * 1000) / 10 : null;

  const measuring = campaign.trackingMethod !== 'NONE' && campaign.codes.length > 0;

  return {
    campaignId: campaign.id,
    reference: campaign.reference,
    name: campaign.name,
    status: campaign.status,
    startDate: start ? dayKey(start) : null,
    endDate: end ? dayKey(end) : null,
    daysElapsed,
    daysTotal,

    spend: {
      toDate: money(spendToDate),
      committed: money(committed),
      budget: campaign.budget ? money(campaign.budget) : null,
      // E11-2: on track when spend is running no faster than the flight is —
      // the same test the portfolio's budget tile applies.
      onTrack: committed.greaterThan(0) ? spendToDate.lessThanOrEqualTo(committed) : null,
    },
    spotsLive: live.length,
    spotsBooked: booked.length,

    reach:
      estimatedReach === null
        ? {
            value: null,
            provenance: 'UNAVAILABLE',
            basis:
              booked.length === 0
                ? 'Nothing booked yet'
                : 'No booked site states a daily footfall figure',
          }
        : {
            value: estimatedReach,
            provenance: 'ESTIMATED',
            basis: `Publisher-stated footfall on ${withFootfall.length} of ${booked.length} sites, over ${daysElapsed} day${daysElapsed === 1 ? '' : 's'}`,
          },

    scans: measuring
      ? { value: totals.scans, provenance: 'MEASURED', basis: 'Codes resolved through ADX' }
      : { value: null, provenance: 'UNAVAILABLE', basis: 'This campaign is not tracked' },

    clicks: measuring
      ? { value: totals.clicks, provenance: 'MEASURED', basis: 'Redirects completed to the destination' }
      : { value: null, provenance: 'UNAVAILABLE', basis: 'This campaign is not tracked' },

    clickRate:
      clickRate === null
        ? {
            value: null,
            provenance: measuring ? 'MEASURED' : 'UNAVAILABLE',
            basis: measuring ? 'No scans yet' : 'This campaign is not tracked',
          }
        : { value: clickRate, provenance: 'MEASURED', basis: `${totals.clicks} of ${totals.scans} scans reached the destination` },

    redemptions:
      campaign.trackingMethod === 'VANITY_OR_PROMO'
        ? {
            value: totals.redemptions,
            provenance: 'REPORTED',
            basis: 'Reported by the advertiser, not observed by ADX',
          }
        : { value: null, provenance: 'UNAVAILABLE', basis: 'No promo code on this campaign' },

    series,
    mix,

    bySpot,
    byMarket: foldByMarket(bySpot),

    interactions: {
      provenance: 'MEASURED',
      basis:
        options.interactions === false
          ? 'Not read for the portfolio view'
          : 'Views, CTA presses and form submissions recorded on the ADX landing page',
      ...interactions,
    },
    demographics: {
      value: null,
      provenance: 'UNAVAILABLE',
      basis: audience
        ? `No pixel backs a demographic split of out-of-home; see audience for the ${audience.vendor} panel`
        : 'No audience panel or pixel backs a demographic split of out-of-home',
    },
    audience,
    comparison,
    engine,
  };
}

/* ------------------------------------------------------------------ */
/* Across campaigns                                                    */
/* ------------------------------------------------------------------ */

export type PortfolioAnalytics = {
  /** The four tiles at the top of DR 01's analytics screen. */
  totalReach: Metric;
  clickRate: Metric;
  activeCampaigns: { value: number; basis: string };
  budgetSpent: { value: Money; basis: string; onTrack: boolean | null };
  /** Last N days across every campaign, for the performance chart. */
  series: { day: string; spend: Money; scans: number; clicks: number }[];
  /** E11-2: the deltas under the tiles — this window against the one before it, across the same campaigns. */
  comparison: WindowComparison;
  /** Every campaign the search matched, newest first. */
  campaigns: {
    id: string;
    reference: string;
    name: string;
    status: CampaignAggregate['status'];
    brandName: string | null;
    startDate: string | null;
    endDate: string | null;
    spots: number;
    spend: Money;
    scans: number | null;
    clickRate: number | null;
  }[];
};

/**
 * The portfolio view — the screen behind "see full analytics", with its search.
 *
 * Reads each matching campaign's analytics and adds them up. Capped at fifty
 * campaigns because this is a screen, not a report: a hundred round trips to
 * paint four tiles is how a dashboard becomes the slowest page in the product.
 */
export async function portfolioAnalytics(
  actor: Actor,
  filter: { search?: string; days?: number; status?: CampaignAggregate['status'][] },
  now = new Date()
): Promise<PortfolioAnalytics> {
  const window = Math.min(Math.max(filter.days ?? 7, 1), 90);
  const rows = await repository.listCampaigns({
    ...(actor.isAdmin
      ? {}
      : actor.advertiserId
        ? { advertiserId: actor.advertiserId }
        : { agentId: actor.agentId ?? '__none__' }),
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.search ? { search: filter.search } : {}),
    limit: 50,
  });

  const analytics: CampaignAnalytics[] = [];
  for (const row of rows) {
    // Drafts have nothing to report and would drag the averages toward zero.
    if (row.status === 'DRAFT') continue;
    const campaign = await repository.findCampaign(row.id);
    if (campaign) analytics.push(await campaignAnalytics(campaign, now, { interactions: false, comparison: false, audience: false, engine: false }));
  }
  // E11-2: one read over both windows for every campaign the tiles count.
  const comparison = await comparisonFor(
    analytics.map((item) => item.campaignId),
    now,
    window
  );

  const reachable = analytics.filter((item) => item.reach.value !== null);
  const totalReach = reachable.reduce((sum, item) => sum + (item.reach.value ?? 0), 0);
  const totalScans = analytics.reduce((sum, item) => sum + (item.scans.value ?? 0), 0);
  const totalClicks = analytics.reduce((sum, item) => sum + (item.clicks.value ?? 0), 0);
  const spend = analytics.reduce((sum, item) => sum.plus(new Decimal(item.spend.toDate)), new Decimal(0));
  const committed = analytics.reduce(
    (sum, item) => sum.plus(new Decimal(item.spend.committed)),
    new Decimal(0)
  );
  const activeCount = analytics.filter((item) => item.status === 'LIVE').length;

  /* One row a day across everything, so the chart is comparable to a single
     campaign's. Days with nothing running are zeros, not gaps. */
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  from.setUTCDate(from.getUTCDate() - (window - 1));
  const byDay = new Map<string, { spend: Decimal; scans: number; clicks: number }>();
  for (const day of daysBetween(from, now)) {
    byDay.set(dayKey(day), { spend: new Decimal(0), scans: 0, clicks: 0 });
  }
  for (const item of analytics) {
    for (const point of item.series) {
      const bucket = byDay.get(point.day);
      if (!bucket) continue;
      bucket.spend = bucket.spend.plus(new Decimal(point.spend));
      bucket.scans += point.scans;
      bucket.clicks += point.clicks;
    }
  }

  const measured = analytics.filter((item) => item.scans.provenance === 'MEASURED');

  return {
    totalReach:
      reachable.length === 0
        ? {
            value: null,
            provenance: 'UNAVAILABLE',
            basis: 'No booked site states a daily footfall figure',
          }
        : {
            value: totalReach,
            provenance: 'ESTIMATED',
            basis: `Publisher-stated footfall across ${reachable.length} of ${analytics.length} campaigns`,
          },
    clickRate:
      totalScans === 0
        ? {
            value: null,
            provenance: measured.length > 0 ? 'MEASURED' : 'UNAVAILABLE',
            basis:
              measured.length > 0
                ? 'No scans yet'
                : `None of these campaigns carry a tracked code`,
          }
        : {
            value: Math.round((totalClicks / totalScans) * 1000) / 10,
            provenance: 'MEASURED',
            basis: `${totalClicks} of ${totalScans} scans across ${measured.length} tracked campaign${measured.length === 1 ? '' : 's'}`,
          },
    activeCampaigns: {
      value: activeCount,
      basis: `${activeCount} live of ${analytics.length} campaign${analytics.length === 1 ? '' : 's'}`,
    },
    budgetSpent: {
      value: money(spend),
      basis: committed.greaterThan(0)
        ? `${Math.round(spend.dividedBy(committed).times(100).toNumber())}% of ${money(committed)} committed`
        : 'Nothing committed yet',
      // On track when spend is running no faster than the flight is.
      onTrack: committed.greaterThan(0) ? spend.lessThanOrEqualTo(committed) : null,
    },
    series: [...byDay.entries()].map(([day, bucket]) => ({
      day,
      spend: money(bucket.spend),
      scans: bucket.scans,
      clicks: bucket.clicks,
    })),
    comparison,
    campaigns: analytics.map((item) => ({
      id: item.campaignId,
      reference: item.reference,
      name: item.name,
      status: item.status,
      brandName: rows.find((row) => row.id === item.campaignId)?.brandName ?? null,
      startDate: item.startDate,
      endDate: item.endDate,
      spots: item.spotsBooked,
      spend: item.spend.toDate,
      scans: item.scans.value,
      clickRate: item.clickRate.value,
    })),
  };
}

/**
 * Writes today's row for every live campaign.
 *
 * The analytics endpoints compute from source, so this is not what the screens
 * read — it is the history that makes yesterday's numbers still true tomorrow,
 * after a spot has been cancelled or a listing repriced.
 */
export async function snapshotDailyMetrics(now = new Date()): Promise<{ written: number }> {
  const rows = await repository.listCampaigns({ status: ['LIVE'], limit: 200 });
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let written = 0;

  for (const row of rows) {
    const campaign = await repository.findCampaign(row.id);
    if (!campaign) continue;
    const analytics = await campaignAnalytics(campaign, now, { audience: false, engine: false });
    const today = analytics.series[analytics.series.length - 1];

    await repository.upsertDailyMetric({
      campaignId: campaign.id,
      day,
      spotsLive: analytics.spotsLive,
      spend: new Decimal(today?.spend ?? 0),
      scans: today?.scans ?? 0,
      clicks: today?.clicks ?? 0,
      redemptions: analytics.redemptions.value ?? 0,
      estimatedReach: today?.estimatedReach ?? null,
      reachFromSpots: campaign.spots.filter((spot) => spot.listing.estimatedDailyFootfall).length,
    });
    written += 1;
  }

  return { written };
}
