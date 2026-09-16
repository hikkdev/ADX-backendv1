import { ApiError } from '../../shared/errors';
import { auditDiff, logActivity } from '../../shared/audit';
import { Decimal, money } from '../../shared/money';
import type {
  ListingCategory,
  MediaType,
  PricingFactorMode,
  PricingSettings,
  SurgeEvent,
} from '../../shared/database';
import { redis } from '../../shared/cache';
import { logger } from '../../shared/logging';
import { createNotification } from '../notifications';
import { listingRepricePort } from './listing-reprice.port';
import { prismaPricingRepository as repository } from './prisma-pricing.repository';
import {
  CITY_KEYED_TABLES,
  type CityFunction,
  type CityKeyedTable,
  type CityRow,
  type CityStageValue,
  type CitySwitches,
  Comparable,
  ComparableTier,
  ListingPricingContext,
  Money,
  NewMarketDataPoint,
} from './pricing.repository';

/**
 * The pricing engine.
 *
 * ADX does not set prices — publishers do. This tells them whether the number
 * they just typed looks right for where they are, in one sentence under a form
 * field. It never blocks, and it never quotes.
 *
 * That one sentence is the whole design constraint. An engine that quotes has
 * to be right; an engine that comments has to be *defensible*. When a publisher
 * disagrees we have to be able to show them the exact spots we compared them
 * against, which is why the comparable set stays small, local and inspectable
 * rather than large and modelled.
 *
 * See docs/pricing-engine.md.
 */

const D = Decimal;

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/*
 * Moved to `shared/geo` when campaign targeting needed the same arithmetic:
 * "within 200 m of this spot" and "within 8 km of this pin" are one question.
 * Re-exported here because the comparables tests and callers name them from
 * this module, and one implementation cannot drift from itself.
 */
import { boundingBox, haversineMeters } from '../../shared/geo';

export { haversineMeters, boundingBox };

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * Defaults matching the migration's seeded row.
 *
 * Duplicated rather than imported so the engine still answers if the settings
 * row is missing — an evaluation failing closed would take the listing form
 * down with it, and the indicator is the least important thing on that page.
 */
export const SETTINGS_FALLBACK = {
  radiusMeters: 200,
  highEdgePct: '0.05',
  lowEdgePct: '0.05',
  thinEvidenceCount: 3,
  validatedTakeoverCount: 3,
  minContributors: 1,
  stalenessMonths: 6,
  mediaTypeMatchThreshold: '0.75',
  maxCompoundMultiplier: '3.0',
  sizeTolerancePct: '0.03',
  maxBindingChangePct: '0.25',
};

export type ResolvedSettings = {
  radiusMeters: number;
  highEdgePct: Decimal;
  lowEdgePct: Decimal;
  /** Below this, the indicator says what little it is standing on. */
  thinEvidenceCount: number;
  /**
   * Distinct ADX contributors with a sale before research is dropped entirely.
   *
   * Separate from `thinEvidenceCount` on purpose: they happen to start equal,
   * but one governs a sentence and the other governs which data decides the
   * price. Sharing a column means raising the caveat threshold silently delays
   * the research-to-ADX handover, with nothing to say that it did.
   */
  validatedTakeoverCount: number;
  minContributors: number;
  stalenessMonths: number;
  mediaTypeMatchThreshold: number;
  maxCompoundMultiplier: Decimal;
  /**
   * How far a measurement may sit from an existing size class and still be
   * filed as it, as a fraction of each dimension.
   *
   * A size class is a pool. Mint one per exact measurement and two spots that
   * any buyer would call identical are never compared — which is what happens
   * without this, because the listing flow measures rather than picks and no
   * two tapes agree to the centimetre.
   */
  sizeTolerancePct: Decimal;
  /**
   * Lot E (Q125): how far a BINDING factor may move a rate on its own, as a
   * fraction of the rate it found. Above it the apply is refused and a price
   * case is raised, so the big moves stay a person's decision.
   */
  maxBindingChangePct: Decimal;
};

export async function getSettings(): Promise<ResolvedSettings> {
  const row = (await repository.getSettings()) as PricingSettings | null;
  const src = row ?? SETTINGS_FALLBACK;
  return {
    radiusMeters: src.radiusMeters,
    highEdgePct: new D(src.highEdgePct),
    lowEdgePct: new D(src.lowEdgePct),
    thinEvidenceCount: src.thinEvidenceCount,
    validatedTakeoverCount: src.validatedTakeoverCount,
    minContributors: src.minContributors,
    stalenessMonths: src.stalenessMonths,
    mediaTypeMatchThreshold: new D(src.mediaTypeMatchThreshold).toNumber(),
    maxCompoundMultiplier: new D(src.maxCompoundMultiplier),
    sizeTolerancePct: new D(src.sizeTolerancePct),
    maxBindingChangePct: new D(src.maxBindingChangePct),
  };
}

/* ------------------------------------------------------------------ */
/* Comparables                                                         */
/* ------------------------------------------------------------------ */

/** A comparable with the staleness verdict the caller needs to label it. */
export type AnnotatedComparable = Comparable & { stale: boolean };

export type Contributor = {
  key: string;
  name: string | null;
  ratePerDay: Money;
  count: number;
  /** Every one of their observations is past the staleness window. */
  stale: boolean;
};

export type ComparableSet = {
  comparables: AnnotatedComparable[];
  /** One entry per contributor, already collapsed to their median. */
  contributors: Contributor[];
  tier: ComparableTier | null;
  low: Money | null;
  high: Money | null;
  /**
   * Contributors whose evidence is entirely stale — deliberately not a count of
   * rows. One publisher with ten old listings is one stale opinion, and a count
   * of ten against a contributor count of one is a number no screen can render
   * honestly.
   */
  staleContributors: number;
};

/**
 * A contributor speaks once.
 *
 * Ten hoardings on one road owned by one publisher, priced identically, is one
 * opinion. Taking their median rather than their first or their cheapest means
 * a contributor cannot move the range by adding listings, only by changing what
 * they actually ask.
 */
function collapseByContributor(rows: AnnotatedComparable[]): Contributor[] {
  const groups = new Map<string, AnnotatedComparable[]>();
  for (const row of rows) {
    const bucket = groups.get(row.contributorKey);
    if (bucket) bucket.push(row);
    else groups.set(row.contributorKey, [row]);
  }
  return [...groups.entries()].map(([key, items]) => {
    const sorted = [...items].sort((a, b) => new D(a.ratePerDay).comparedTo(new D(b.ratePerDay)));
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 1
        ? new D(sorted[mid]!.ratePerDay)
        : new D(sorted[mid - 1]!.ratePerDay).plus(new D(sorted[mid]!.ratePerDay)).dividedBy(2);
    return {
      key,
      name: items[0]?.contributorName ?? null,
      ratePerDay: money(median),
      count: items.length,
      stale: items.every((item) => item.stale),
    };
  });
}

/**
 * The cutoff a data point is stale before.
 *
 * The day is pinned before the month moves: `setMonth` on the 31st rolls into
 * the next month when the target is shorter, which would slide the staleness
 * boundary by a day at every month end for no reason anyone could explain.
 */
function staleBefore(months: number, now: Date): Date {
  const cutoff = new Date(now);
  const day = cutoff.getDate();
  cutoff.setDate(1);
  cutoff.setMonth(cutoff.getMonth() - months);
  const lastDayOfTarget = new Date(cutoff.getFullYear(), cutoff.getMonth() + 1, 0).getDate();
  cutoff.setDate(Math.min(day, lastDayOfTarget));
  return cutoff;
}

/**
 * The three-tier ladder.
 *
 * Trust is expressed as *which tier is present*, not as a coefficient someone
 * has to remember to retune. At launch ADX has nothing that has sold, so the
 * range comes from research; as real orders accumulate, tier one crosses the
 * evidence threshold and takes over on its own. That is the shift from research
 * to ADX data, implemented rather than scheduled.
 */
function pickTier(
  validated: AnnotatedComparable[],
  listed: AnnotatedComparable[],
  provisional: AnnotatedComparable[],
  settings: ResolvedSettings
): { rows: AnnotatedComparable[]; tier: ComparableTier | null } {
  const distinct = (rows: AnnotatedComparable[]): number =>
    new Set(rows.map((r) => r.contributorKey)).size;

  if (distinct(validated) >= settings.validatedTakeoverCount) {
    return { rows: validated, tier: 'VALIDATED' };
  }
  const withListed = [...validated, ...listed];
  if (distinct(withListed) >= settings.minContributors) {
    return { rows: withListed, tier: weakestTier(withListed) };
  }
  const all = [...withListed, ...provisional];
  if (distinct(all) >= settings.minContributors) {
    return { rows: all, tier: weakestTier(all) };
  }
  return { rows: [], tier: null };
}

/**
 * The tier label describes the set, so it has to be the weakest evidence in it.
 *
 * One ADX listing that sold, pooled with five field observations, is not
 * VALIDATED evidence — it is mostly unverified, and labelling it by its single
 * strongest member would show ops the highest possible provenance for a range
 * that five-sixths of the market has not tested.
 */
function weakestTier(rows: AnnotatedComparable[]): ComparableTier | null {
  if (rows.length === 0) return null;
  if (rows.some((r) => r.tier === 'PROVISIONAL')) return 'PROVISIONAL';
  if (rows.some((r) => r.tier === 'LISTED')) return 'LISTED';
  return 'VALIDATED';
}

export type ComparableInput = {
  /** Null for a spot with no venue, which matches other spots that have none. */
  venueTypeId?: string | null;
  mediaTypeId: string;
  sizeClassId: string;
  latitude: number;
  longitude: number;
  excludeListingId?: string;
};

/**
 * Every spot that counts as the same kind of thing in the same place.
 *
 * The radius does not widen when the circle is empty. A hoarding two kilometres
 * away is not evidence about this one, and an engine that reaches for it to
 * avoid saying nothing is an engine that is quietly wrong.
 */
export async function comparablesFor(
  input: ComparableInput,
  now: Date = new Date()
): Promise<ComparableSet> {
  const settings = await getSettings();
  const { latDelta, lngDelta } = boundingBox(input.latitude, settings.radiusMeters);
  const query = { ...input, venueTypeId: input.venueTypeId ?? null, latDelta, lngDelta, now };

  const [listingRows, marketRows] = await Promise.all([
    repository.listingComparables(query),
    repository.marketDataComparables(query),
  ]);

  const cutoff = staleBefore(settings.stalenessMonths, now);
  const withinRadius: AnnotatedComparable[] = [...listingRows, ...marketRows]
    .map((row) => ({
      ...row,
      distanceMeters: haversineMeters(
        input.latitude,
        input.longitude,
        row.latitude,
        row.longitude
      ),
      stale: row.observedAt < cutoff,
    }))
    .filter((row) => row.distanceMeters <= settings.radiusMeters);

  const { rows, tier } = pickTier(
    withinRadius.filter((r) => r.tier === 'VALIDATED'),
    withinRadius.filter((r) => r.tier === 'LISTED'),
    withinRadius.filter((r) => r.tier === 'PROVISIONAL'),
    settings
  );

  const contributors = collapseByContributor(rows);
  const rates = contributors.map((c) => new D(c.ratePerDay));

  return {
    comparables: rows.sort((a, b) => a.distanceMeters - b.distanceMeters),
    contributors,
    tier,
    low: rates.length ? money(D.min(...rates)) : null,
    high: rates.length ? money(D.max(...rates)) : null,
    staleContributors: contributors.filter((c) => c.stale).length,
  };
}

/**
 * What a publisher may see of the set behind their indicator.
 *
 * Publishers are meant to see their comparables — showing the working is what
 * makes the verdict arguable rather than arbitrary. But the full set names
 * competitors, pins them to exact coordinates and quotes their rates, and most
 * of those rows are research ADX paid a field team to gather that exists
 * nowhere public.
 *
 * Rounding coordinates is not enough, and an earlier version that rounded
 * distance to 10 m was not either. Deterministic rounding is not noise: each
 * probe still yields a hard annulus, the caller picks the probe points, and
 * there is no rate limiting in front of this router — so distances converge on
 * a few metres. An exact per-row rate then fingerprints each spot well enough to
 * match rows across probes, which is what turns a set of annuli into positions.
 *
 * So the public shape carries no per-row anything: a count, the range, how much
 * of it is stale, and how the spots are spread across three coarse distance
 * bands. That is exactly what "six similar spots within 200 m list at X to Y"
 * needs, and nothing that survives being swept.
 */
export type PublicComparableSet = {
  contributorCount: number;
  low: Money | null;
  high: Money | null;
  staleContributors: number;
  /** How many comparables sit in each distance band, nearest first. */
  distanceBands: { label: string; count: number }[];
};

const DISTANCE_BANDS: { label: string; limit: number }[] = [
  { label: 'under 50 m', limit: 50 },
  { label: '50 to 100 m', limit: 100 },
  { label: '100 m or more', limit: Number.POSITIVE_INFINITY },
];

export function redactComparables(set: ComparableSet): PublicComparableSet {
  const counts = DISTANCE_BANDS.map((band) => ({ label: band.label, count: 0 }));
  for (const row of set.comparables) {
    const index = DISTANCE_BANDS.findIndex((band) => row.distanceMeters < band.limit);
    counts[index === -1 ? counts.length - 1 : index]!.count += 1;
  }
  return {
    contributorCount: set.contributors.length,
    low: set.low,
    high: set.high,
    staleContributors: set.staleContributors,
    distanceBands: counts,
  };
}

/* ------------------------------------------------------------------ */
/* Cities                                                              */
/* ------------------------------------------------------------------ */

/**
 * Free-text city name to a canonical key.
 *
 * Surge windows used to match on the raw string, so "Bengaluru" and "Bangalore"
 * were different cities and a window naming one silently covered none of the
 * spots recorded under the other. Harmless while a miss only failed to render a
 * sentence; not harmless once the same comparison began deciding whether a
 * listing's rate is kept out of every neighbour's comparable pool.
 *
 * Returns null for a name the table does not know. That is a real answer and
 * has to stay distinguishable from a match: a window whose city resolves to
 * nothing can never apply on name, and ops should be able to see that rather
 * than watch it quietly cover nobody.
 */
export type CityResolver = (name: string | null | undefined) => string | null;

export function buildCityResolver(
  cities: { slug: string; name: string; aliases: string[] }[]
): CityResolver {
  const bySpelling = new Map<string, string>();
  // Lot V: names and slugs first, aliases only where no name claims the
  // spelling — with the whole country catalogued, one town's alias is
  // another town's name, and the name is the stronger claim.
  for (const city of cities) {
    bySpelling.set(city.slug, city.slug);
    bySpelling.set(slugify(city.name), city.slug);
  }
  for (const city of cities) {
    for (const alias of city.aliases) {
      const key = slugify(alias);
      if (!bySpelling.has(key)) bySpelling.set(key, city.slug);
    }
  }
  return (name) => {
    if (!name) return null;
    return bySpelling.get(slugify(name)) ?? null;
  };
}

/** The city table, for a caller building its own resolver over a batch. */
export async function listCities(): Promise<
  { id: string; slug: string; name: string; aliases: string[] }[]
> {
  return repository.listCities();
}

/** Convenience for a single lookup. Prefer the resolver when doing many. */
export async function resolveCity(name: string | null | undefined): Promise<string | null> {
  return buildCityResolver(await repository.listCities())(name);
}

/* ------------------------------------------------------------------ */
/* The city key — Lot X-B                                              */
/* ------------------------------------------------------------------ */

/**
 * Lot X-B: the key a party row carries beside its typed city.
 *
 * Every write that sets a city string (`publishers`, `advertisers`,
 * `agents`, `print-partners`, `listings`, `leads`, `visits`, `campaigns`)
 * asks this for the `City` row the string denotes and stores its id as
 * `cityId` (`targetMarketCityId` on a campaign). The string stays as typed
 * — the owner's rule that a town outside the catalogue is allowed — and a
 * string that resolves to nothing leaves the key null. Every group-by,
 * count and facet then compares keys, with the spelling as the fallback for
 * the rows whose key is null.
 *
 * Resolved the way the gate resolves (`citySupport`): one query by slug,
 * alias or display name over the whole catalogue, PLANNED towns included
 * — a publisher in a town ADX has not opened yet still keys to that town,
 * which is what makes the geo counts exact — and `pickCityRow` picks when
 * India has several of the name. Cached a minute per normalised spelling,
 * so an importer resolving five hundred rows asks the table once per
 * distinct town.
 */
export type CityKey = { cityId: string; slug: string };

const CITY_KEY_CACHE_MS = 60_000;
const cityKeyCache = new Map<string, { at: number; key: CityKey | null }>();

/** Tests and the alias edit: forget every cached answer. */
export function clearCityKeyCache(): void {
  cityKeyCache.clear();
}

export async function cityKeyFor(name: string | null | undefined, now = Date.now()): Promise<CityKey | null> {
  if (!name || !name.trim()) return null;
  const spelling = slugify(name);
  if (!spelling) return null;
  const cached = cityKeyCache.get(spelling);
  if (cached && now - cached.at < CITY_KEY_CACHE_MS) return cached.key;
  const city = pickCityRow(await repository.findCitiesBySpelling(spelling, name.trim()), spelling);
  const key = city ? { cityId: city.id, slug: city.slug } : null;
  cityKeyCache.set(spelling, { at: now, key });
  return key;
}

/**
 * The write helper: `{ ...data, cityId }` when `data.city` is present (a
 * string, or null — clearing the city clears the key), `data` untouched
 * when the write does not name a city at all (a patch of other fields).
 */
export async function withCityKey<T extends { city?: string | null | undefined }>(data: T): Promise<T & { cityId?: string | null }> {
  if (!('city' in data) || data.city === undefined) return data;
  return { ...data, cityId: (await cityKeyFor(data.city))?.cityId ?? null };
}

/** A batch resolver over the active catalogue, for `supply`'s five-hundred-row attempt. */
export function buildCityKeyResolver(cities: { id: string; slug: string; name: string; aliases: string[] }[]): (name: string | null | undefined) => CityKey | null {
  const bySlug = new Map(cities.map((city) => [city.slug, city]));
  const resolve = buildCityResolver(cities);
  return (name) => {
    const slug = resolve(name);
    const city = slug ? bySlug.get(slug) : undefined;
    return city ? { cityId: city.id, slug: city.slug } : null;
  };
}

/** Every spelling the free-text columns may hold for one alias: as stored (slugified) and de-hyphenated. */
const spellingsOfAlias = (alias: string): string[] => [...new Set([alias, alias.replace(/-/g, ' ')])];

export type UnresolvedCity = { city: string; total: number; tables: Partial<Record<CityKeyedTable, number>> };

/**
 * The typed strings with no key, folded case-insensitively across the
 * eight tables with their row counts — what the Geographies overview draws
 * so ops can add an alias or a manual city and fold them in.
 */
export async function listUnresolvedCities(): Promise<UnresolvedCity[]> {
  const rows = await repository.listUnresolvedCityStrings();
  const byString = new Map<string, UnresolvedCity>();
  for (const row of rows) {
    const key = row.city.trim().toLowerCase();
    const entry = byString.get(key) ?? { city: row.city.trim(), total: 0, tables: {} };
    entry.total += row.count;
    entry.tables[row.table] = (entry.tables[row.table] ?? 0) + row.count;
    byString.set(key, entry);
  }
  return [...byString.values()].sort((a, b) => b.total - a.total || a.city.localeCompare(b.city));
}

export type CityKeyBackfill = Record<CityKeyedTable, { resolved: number; stillNull: number }>;

/**
 * Re-runs the resolver over every null key: each distinct typed string per
 * table is resolved once and, when it now denotes a row, folded in with one
 * `updateMany`. For the day an alias or a manual city arrives after the
 * rows did; `npm run backfill:city-keys`.
 */
export async function backfillCityKeys(): Promise<CityKeyBackfill> {
  clearCityKeyCache();
  const out = {} as CityKeyBackfill;
  for (const table of CITY_KEYED_TABLES) out[table] = { resolved: 0, stillNull: 0 };
  for (const row of await repository.listUnresolvedCityStrings()) {
    const key = await cityKeyFor(row.city);
    if (!key) {
      out[row.table].stillNull += row.count;
      continue;
    }
    out[row.table].resolved += await repository.foldCityKey(row.table, key.cityId, [row.city]);
  }
  return out;
}

/** Lot X-B: `citySupport` by the key a row already carries — no spelling in the way. */
async function citySupportByKey(cityId: string): Promise<CitySupportView | null> {
  const city = await repository.findCityById(cityId);
  if (!city) return null;
  return { support: city.isActive ? 'ACTIVE' : 'INACTIVE', city, resolved: true, stage: city.stage, switches: city.switches };
}

/**
 * Is ADX open for business in the place this name denotes — and for what?
 *
 * Three answers, and the middle one is the point. `ACTIVE` is a city whose
 * stage resolves (SEEDING, LAUNCHED, PAUSED). `INACTIVE` is a city in the
 * catalogue whose stage does not (PLANNED — the six thousand towns the
 * country catalogue added, or WITHDRAWN). `UNKNOWN` is a name the catalogue
 * has never heard of, which is allowed: the city field is free text, and a
 * listing form that refused a hamlet ADX had not catalogued would be a worse
 * product than one that takes the name and sorts it out later.
 *
 * Lot V (the owner, 15 Sep 2026) put the *function* beside the stage: the
 * six `switches` say which of supply intake, publishing, demand, agent
 * onboarding, print partners and lead feeds the city is open for right now.
 * `resolved` is false for an unknown name, whose switches all read true —
 * nothing gates what the catalogue cannot see.
 *
 * One query per call, by slug, alias or display name, never the whole
 * table: a name India has several of (Rampur) picks the most advanced
 * stage, then the biggest place.
 */
export type CitySupport = 'ACTIVE' | 'INACTIVE' | 'UNKNOWN';

export type CitySupportView = {
  support: CitySupport;
  city: CityRow | null;
  resolved: boolean;
  stage: CityStageValue | null;
  switches: CitySwitches;
};

const OPEN_SWITCHES: CitySwitches = Object.freeze({
  supplyIntake: true,
  publishing: true,
  demand: true,
  agentOnboarding: true,
  printPartners: true,
  leadFeeds: true,
}) as CitySwitches;

const STAGE_RANK: Record<CityStageValue, number> = { LAUNCHED: 4, SEEDING: 3, PAUSED: 2, WITHDRAWN: 1, PLANNED: 0 };

/** The row a typed name means when several carry the spelling. */
export function pickCityRow(rows: CityRow[], spelling: string): CityRow | null {
  if (rows.length === 0) return null;
  const score = (row: CityRow): number =>
    (row.slug === spelling ? 300 : slugify(row.name) === spelling ? 200 : 100) + STAGE_RANK[row.stage] * 10;
  return [...rows].sort((a, b) => score(b) - score(a) || (b.population ?? 0) - (a.population ?? 0))[0] ?? null;
}

export async function citySupport(name: string | null | undefined): Promise<CitySupportView> {
  const unknown: CitySupportView = { support: 'UNKNOWN', city: null, resolved: false, stage: null, switches: OPEN_SWITCHES };
  if (!name || !name.trim()) return unknown;
  const spelling = slugify(name);
  if (!spelling) return unknown;
  const city = pickCityRow(await repository.findCitiesBySpelling(spelling, name.trim()), spelling);
  if (!city) return unknown;
  return { support: city.isActive ? 'ACTIVE' : 'INACTIVE', city, resolved: true, stage: city.stage, switches: city.switches };
}

const FUNCTION_LABEL: Record<CityFunction, string> = {
  supplyIntake: 'new listings',
  publishing: 'publishing',
  demand: 'campaigns',
  agentOnboarding: 'agent onboarding',
  printPartners: 'print partners',
  leadFeeds: 'lead feeds',
};

/**
 * Lot V: a name outside the catalogue is allowed, and noted once a day so
 * ops can see which towns people type that the catalogue lacks (`POST
 * /geo/cities` adds one by hand). Never fails the write: Redis being away
 * means the note is simply not made.
 */
async function noteUnknownCity(name: string, spelling: string): Promise<void> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const first = await redis.set(`geo:unknown-city:${day}:${spelling}`, '1', 'EX', 36 * 60 * 60, 'NX');
    if (first) logger.info('City name outside the geography catalogue', { tag: 'cityGate', name, spelling });
  } catch {
    /* the note is a convenience; the write goes on */
  }
}

/**
 * Refuses a write in a city whose rollout stage has this function switched
 * off — 400 `CITY_NOT_OPEN` with `{ stage, function, city }`. Free text
 * stays free: a name with no row passes (and is noted once a day), and so
 * does an empty one. Replaces Lot A's `assertCitySupported`, which knew
 * only on and off.
 */
export async function assertCityAllows(name: string | null | undefined, fn: CityFunction, cityId?: string | null): Promise<CitySupportView> {
  // Lot X-B: a row that already carries its key is judged by the key; the
  // spelling only decides for a row (or a fresh input) that has none.
  const view = (cityId ? await citySupportByKey(cityId) : null) ?? (await citySupport(name));
  if (!view.resolved) {
    if (name && name.trim()) void noteUnknownCity(name.trim(), slugify(name));
    return view;
  }
  if (!view.switches[fn]) {
    throw new ApiError(
      400,
      'CITY_NOT_OPEN',
      `ADX is not open for ${FUNCTION_LABEL[fn]} in ${view.city!.name} (${view.stage!.toLowerCase()}).`,
      { stage: view.stage, function: fn, city: view.city!.slug },
    );
  }
  return view;
}

/** The city table as ops see it, retired rows included. */
export async function listAllCities(): Promise<CityRow[]> {
  return repository.listAllCities();
}

/**
 * Opens or closes a geography, or teaches the resolver another spelling.
 *
 * Aliases are normalised on the way in — the resolver slugifies every
 * spelling before comparing, so storing "Bangalore " and "bangalore" as two
 * different aliases would be two rows saying one thing.
 */
export async function updateCity(
  slug: string,
  patch: { isActive?: boolean; aliases?: string[] },
): Promise<{ before: CityRow; after: CityRow }> {
  const before = await repository.findCity(slug);
  if (!before) throw new ApiError(404, 'NOT_FOUND', 'City not found');
  // Lot V: `isActive` is a mirror of the rollout stage now, written by
  // `geo`'s stage machine and nothing else. A direct write would leave the
  // mirror disagreeing with the stage it mirrors, so the old switch answers
  // with the door to use instead.
  if (patch.isActive !== undefined && patch.isActive !== before.isActive) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'A city is opened and closed through its rollout stage — PATCH /geo/cities/:slug/rollout — not the isActive flag.',
      { stage: before.stage, rollout: `/api/v1/geo/cities/${slug}/rollout` },
    );
  }
  const after = await repository.updateCity(slug, {
    ...(patch.aliases === undefined
      ? {}
      : { aliases: [...new Set(patch.aliases.map(slugify).filter(Boolean))] }),
  });
  // Lot X-B: a new spelling folds in the rows typed under it whose key is
  // still null — one `updateMany` per table for the aliases added, so an
  // old "Bangalore" row keys to Bengaluru the moment ops teach the alias.
  // Rows already keyed elsewhere are left alone: the key is the stronger
  // claim.
  const added = after.aliases.filter((alias) => !before.aliases.includes(alias));
  if (added.length > 0) {
    clearCityKeyCache();
    const spellings = added.flatMap(spellingsOfAlias);
    const folded: Partial<Record<CityKeyedTable, number>> = {};
    for (const table of CITY_KEYED_TABLES) {
      const count = await repository.foldCityKey(table, after.id, spellings);
      if (count > 0) folded[table] = count;
    }
    if (Object.keys(folded).length > 0) logger.info('City alias folded typed rows onto the key', { tag: 'cityKey', city: after.slug, aliases: added, folded });
  }
  return { before, after };
}

/* ------------------------------------------------------------------ */
/* Surge                                                               */
/* ------------------------------------------------------------------ */

export type ActiveSurge = {
  /** Null on a window the caller is not entitled to identify. */
  id: string | null;
  /**
   * Null for a non-public window.
   *
   * The schema says national events are surfaced to advertisers and city ones
   * are not, and this is where that is enforced. The *effect* is still reported
   * — a publisher can see their ceiling has lifted, which they must, since it
   * changes what the indicator tells them — but a confidential event does not
   * announce itself by name to anyone who can reach POST /pricing/evaluate.
   */
  name: string | null;
  upliftPct: string;
  /** When *this* event ends. What an advertiser is told. */
  endsAt: Date;
  /**
   * When the last of the covering windows ends.
   *
   * A different quantity from `endsAt` and kept separate after they were once
   * conflated: a price set during an IPL final that overlaps a three-month
   * festive window has to stay out of the comparable pool for the whole three
   * months, but the advertiser must still be told about the final. Merging them
   * produced screens reading "IPL final, higher rates until 30 November".
   */
  coverUntil: Date;
  isPublic: boolean;
};

/**
 * Which windows cover this spot right now.
 *
 * A national or international window covers everywhere. A city window covers
 * its city, or a radius around a point when the scraper gave one — a stadium
 * lifts prices around the stadium, not across the whole metro.
 */
export function surgeApplies(
  event: SurgeEvent,
  place: { latitude: number; longitude: number; citySlug: string | null }
): boolean {
  if (event.scope !== 'CITY') return true;
  if (event.latitude !== null && event.longitude !== null && event.radiusMeters !== null) {
    return (
      haversineMeters(place.latitude, place.longitude, event.latitude, event.longitude) <=
      event.radiusMeters
    );
  }
  // Canonical keys, not the strings people typed. Both sides resolve through
  // the same table, so a window naming Bangalore covers spots recorded in
  // Bengaluru — and a name neither side recognises matches nothing rather than
  // matching only its own exact spelling.
  if (event.citySlug && place.citySlug) return event.citySlug === place.citySlug;
  return false;
}

/**
 * The strongest window wins; they do not compound.
 *
 * Two overlapping events are two descriptions of one busy week, not two
 * independent reasons to double a price.
 */
export type SurgePlace = { latitude: number; longitude: number; city: string | null };

/**
 * Resolves the place's city and asks the calendar in one go.
 *
 * Takes the raw city name rather than a slug so callers cannot forget to
 * resolve it — a forgotten resolve looks exactly like a city with no windows.
 */
export async function activeSurge(
  place: SurgePlace,
  now: Date = new Date()
): Promise<ActiveSurge | null> {
  const [windows, resolver] = await Promise.all([
    repository.activeSurgeWindows(now),
    repository.listCities().then(buildCityResolver),
  ]);
  return strongestSurgeFor(windows, { ...place, citySlug: resolver(place.city) });
}

/**
 * The windows in force right now, fetched once.
 *
 * Paired with `strongestSurgeFor`, which is pure, so a caller classifying five
 * hundred spreadsheet rows makes one query rather than five hundred. `activeSurge`
 * above is the single-spot convenience over the same pair.
 */
export async function surgeWindowsAt(now: Date = new Date()): Promise<SurgeEvent[]> {
  return repository.activeSurgeWindows(now);
}

/** Pure: which of these windows covers this spot, and which lifts most. */
export function strongestSurgeFor(
  windows: SurgeEvent[],
  place: { latitude: number; longitude: number; citySlug: string | null }
): ActiveSurge | null {
  const covering = windows.filter((event) => surgeApplies(event, place));
  if (covering.length === 0) return null;
  const strongest = covering.reduce((best, event) =>
    new D(event.upliftPct).greaterThan(new D(best.upliftPct)) ? event : best
  );
  return {
    id: strongest.id,
    name: strongest.name,
    upliftPct: new D(strongest.upliftPct).toString(),
    endsAt: strongest.endsAt,
    coverUntil: covering.reduce(
      (latest, event) => (event.endsAt > latest ? event.endsAt : latest),
      strongest.endsAt
    ),
    isPublic: strongest.isPublic,
  };
}

/* ------------------------------------------------------------------ */
/* The indicator                                                       */
/* ------------------------------------------------------------------ */

export type IndicatorState = 'NO_DATA' | 'TOO_LOW' | 'LOW_SIDE' | 'GOOD' | 'TOO_HIGH';

export type PriceIndicator = {
  state: IndicatorState;
  message: string;
  range: { low: Money; high: Money } | null;
  /** The ceiling after surge, which is what TOO_HIGH is actually measured against. */
  effectiveHigh: Money | null;
  contributorCount: number;
  /** True below the comfortable count — the indicator says what it stands on. */
  thin: boolean;
  /** Contributors whose evidence is entirely past the staleness window. */
  staleContributors: number;
  tier: ComparableTier | null;
  surge: ActiveSurge | null;
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * What a caller outside ops may know about an active window.
 *
 * A public window is reported in full. A private one keeps its effect and loses
 * its identity: the uplift and the end date are the parts a publisher needs to
 * understand their own ceiling, and the name is the part that would leak an
 * unannounced event to anybody with a login.
 */
export function redactSurge(surge: ActiveSurge | null): ActiveSurge | null {
  if (surge === null || surge.isPublic) return surge;
  return { ...surge, id: null, name: null };
}

function describe(
  state: IndicatorState,
  count: number,
  thin: boolean,
  surge: ActiveSurge | null,
  radiusMeters: number
): string {
  const basis = thin
    ? ` — based on only ${count} nearby ${plural(count, 'spot', 'spots')}`
    : ` across ${count} nearby ${plural(count, 'spot', 'spots')}`;
  // Named only when the window is public. A private one still explains that the
  // ceiling moved, without saying which event moved it.
  const during = surge
    ? surge.name
      ? `, allowing for ${surge.name}`
      : ', allowing for an event running now'
    : '';

  switch (state) {
    case 'NO_DATA':
      return `No comparable spots within ${radiusMeters} m, so there is nothing to check this against.`;
    case 'TOO_LOW':
      return `This is below everything comparable nearby${basis}.`;
    case 'LOW_SIDE':
      return `This is on the cheaper side for the area${basis}.`;
    case 'TOO_HIGH':
      return `This is at or above the highest comparable rate nearby${during}${basis}.`;
    case 'GOOD':
      return `This sits within the going rate for the area${basis}.`;
  }
}

/**
 * Where a typed price falls against the range.
 *
 * Two stages, and the separation is the whole point.
 *
 * First the verdict against the market as it actually is, surge ignored
 * entirely. Below the floor is TOO_LOW; the two 5% edges are then tested
 * independently, and where both fire — which happens for any spread under about
 * 10.5%, so routinely — the nearer end wins. An exact tie is dead centre, which
 * is neither cheap nor expensive but the going rate; that is also what makes a
 * single comparable read GOOD at its own price.
 *
 * Then surge, which may only ever *relax* a TOO_HIGH into a GOOD. It lifts the
 * ceiling a publisher is allowed to reach; it is not evidence about the market,
 * so it must not touch TOO_LOW, LOW_SIDE, or the proximity comparison. Earlier
 * versions let it in on both of those and produced the same absurdity twice: a
 * publisher who typed the exact price of the only comparable nearby was told
 * they were on the cheaper side, because an invisible national window had moved
 * the ceiling out from under the calculation.
 */
export function classify(
  price: Decimal,
  low: Decimal,
  high: Decimal,
  settings: ResolvedSettings,
  upliftPct: Decimal
): { state: Exclude<IndicatorState, 'NO_DATA'>; effectiveHigh: Decimal } {
  const effectiveHigh = high.times(new D(1).plus(upliftPct));

  if (price.lessThan(low)) return { state: 'TOO_LOW', effectiveHigh };

  const observed = observedVerdict(price, low, high, settings);
  if (observed !== 'TOO_HIGH') return { state: observed, effectiveHigh };

  // Surge earns its keep here and nowhere else.
  const permitted = effectiveHigh.times(new D(1).minus(settings.highEdgePct));
  if (price.lessThan(permitted)) return { state: 'GOOD', effectiveHigh };
  return { state: 'TOO_HIGH', effectiveHigh };
}

/** The verdict against the observed market, before surge is considered. */
function observedVerdict(
  price: Decimal,
  low: Decimal,
  high: Decimal,
  settings: ResolvedSettings
): Exclude<IndicatorState, 'NO_DATA' | 'TOO_LOW'> {
  if (price.greaterThan(high)) return 'TOO_HIGH';

  const nearCeiling = price.greaterThanOrEqualTo(high.times(new D(1).minus(settings.highEdgePct)));
  const nearFloor = price.lessThanOrEqualTo(low.times(new D(1).plus(settings.lowEdgePct)));

  if (nearCeiling && nearFloor) {
    const toFloor = price.minus(low);
    const toCeiling = high.minus(price);
    if (toFloor.lessThan(toCeiling)) return 'LOW_SIDE';
    if (toCeiling.lessThan(toFloor)) return 'TOO_HIGH';
    return 'GOOD';
  }
  if (nearCeiling) return 'TOO_HIGH';
  if (nearFloor) return 'LOW_SIDE';
  return 'GOOD';
}

export type EvaluateInput = ComparableInput & {
  ratePerDay: Money;
  city?: string | null;
};

/** The sentence under the pricing field. */
export async function evaluatePrice(
  input: EvaluateInput,
  now: Date = new Date()
): Promise<PriceIndicator> {
  const [settings, set, surge] = await Promise.all([
    getSettings(),
    comparablesFor(input, now),
    activeSurge(
      { latitude: input.latitude, longitude: input.longitude, city: input.city ?? null },
      now
    ),
  ]);

  // Redacted once, here, and everything downstream — the verdict, the message,
  // the response — sees only what the caller is entitled to. Redacting the
  // returned field alone left the event named in the sentence beside it.
  const shown = redactSurge(surge);
  const count = set.contributors.length;
  if (set.low === null || set.high === null || count < settings.minContributors) {
    return {
      state: 'NO_DATA',
      message: describe('NO_DATA', 0, false, null, settings.radiusMeters),
      range: null,
      effectiveHigh: null,
      contributorCount: count,
      thin: false,
      staleContributors: set.staleContributors,
      tier: null,
      surge: shown,
    };
  }

  const { state, effectiveHigh } = classify(
    new D(input.ratePerDay),
    new D(set.low),
    new D(set.high),
    settings,
    surge ? new D(surge.upliftPct) : new D(0)
  );
  const thin = count <= settings.thinEvidenceCount;

  return {
    state,
    message: describe(state, count, thin, state === 'TOO_HIGH' ? shown : null, settings.radiusMeters),
    range: { low: set.low, high: set.high },
    effectiveHigh: money(effectiveHigh),
    contributorCount: count,
    thin,
    staleContributors: set.staleContributors,
    tier: set.tier,
    surge: shown,
  };
}

/** Same evaluation, for a listing that already exists. */
export async function evaluateListing(
  listingId: string,
  now: Date = new Date()
): Promise<PriceIndicator> {
  const listing = await requirePricedListing(listingId);
  return evaluatePrice(
    {
      venueTypeId: listing.venueTypeId,
      mediaTypeId: listing.mediaTypeId!,
      sizeClassId: listing.sizeClassId!,
      latitude: listing.latitude!,
      longitude: listing.longitude!,
      ratePerDay: listing.ratePerDay!,
      city: listing.city,
      excludeListingId: listing.id,
    },
    now
  );
}

/**
 * Enough to find comparables: what the spot *is*, and where.
 *
 * Deliberately does not require a price. A listing with no rate yet is exactly
 * the one a suggestion is for.
 */
async function requirePlaceableListing(listingId: string): Promise<ListingPricingContext> {
  const listing = await repository.listingContext(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (
    listing.mediaTypeId === null ||
    listing.sizeClassId === null ||
    listing.latitude === null ||
    listing.longitude === null
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'This listing has no media type, size class or coordinates, so it cannot be compared'
    );
  }
  return listing;
}

/** The above, plus a price to judge. Only what checks an existing rate needs. */
async function requirePricedListing(listingId: string): Promise<ListingPricingContext> {
  const listing = await requirePlaceableListing(listingId);
  if (listing.ratePerDay === null) {
    throw new ApiError(400, 'BAD_REQUEST', 'This listing has no rate to check');
  }
  return listing;
}

/* ------------------------------------------------------------------ */
/* Media type matching                                                 */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'with', 'on', 'in']);

/**
 * Crude singularisation, on purpose.
 *
 * Not a stemmer — "hoarding" must not collapse to "hoard". This exists for one
 * failure that would otherwise be constant: someone types "Unipole Hoardings"
 * and the plural alone drops the score under the threshold, minting a duplicate
 * media type and splitting every comparable set that should have been one.
 */
function singularise(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function tokenise(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(singularise);
}

/**
 * Dice coefficient over name tokens, gated on category.
 *
 * Deliberately simple and explainable: when ops asks why two things matched,
 * the answer has to be a sentence, not a model. Category is a hard gate because
 * a transit panel and a mall panel sharing the word "panel" are not the same
 * kind of thing however similar their names read.
 */
export function similarity(
  a: { name: string; category: ListingCategory },
  b: { name: string; category: ListingCategory }
): number {
  if (a.category !== b.category) return 0;
  const left = new Set(tokenise(a.name));
  const right = new Set(tokenise(b.name));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

export const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export type MatchResult = {
  mediaType: MediaType;
  similarity: number;
  outcome: 'MATCHED' | 'CREATED';
};

/**
 * Resolves a proposed media type against the existing taxonomy.
 *
 * Biased toward matching on purpose. Two types that should have been one is a
 * mistake ops can repair with a merge; a fragmented taxonomy empties every
 * comparable set silently, and nobody notices until the indicator has stopped
 * appearing for half the catalogue. Every decision is logged either way — that
 * log is the early warning.
 */
export async function matchMediaType(input: {
  name: string;
  category: ListingCategory;
  /** The venue the spot is in. A type minted from a name inherits it. */
  venueTypeId?: string | null;
  listingId?: string | null;
  attributes?: Record<string, unknown>;
}): Promise<MatchResult> {
  const settings = await getSettings();
  const all = (await repository.listMediaTypes()).filter((t) => t.status === 'ACTIVE');
  // Only formats from the same venue are candidates. A mall's floor graphic and
  // a hospital's score identically on name, and matching across the two would
  // file one venue's spot under the other's type — which is the same pool split
  // this level of the key exists to prevent, arrived at from the other side.
  const venueTypeId = input.venueTypeId ?? null;
  const existing = all.filter((t) => (t.venueTypeId ?? null) === venueTypeId);

  let best: { type: MediaType; score: number } | null = null;
  for (const candidate of existing) {
    const score = similarity(input, { name: candidate.name, category: candidate.category });
    if (!best || score > best.score) best = { type: candidate, score };
  }

  const attributes = { name: input.name, category: input.category, ...(input.attributes ?? {}) };

  if (best && best.score >= settings.mediaTypeMatchThreshold) {
    await repository.logMediaTypeMatch({
      proposedName: input.name,
      attributes,
      mediaTypeId: best.type.id,
      similarity: best.score,
      outcome: 'MATCHED',
      listingId: input.listingId ?? null,
    });
    return { mediaType: best.type, similarity: best.score, outcome: 'MATCHED' };
  }

  const created = await repository.createMediaType({
    name: input.name,
    slug: await uniqueSlug(slugify(input.name)),
    category: input.category,
    venueTypeId,
    origin: 'AUTO_MATCHED',
  });
  await repository.logMediaTypeMatch({
    proposedName: input.name,
    attributes,
    mediaTypeId: created.id,
    similarity: best?.score ?? null,
    outcome: 'CREATED',
    listingId: input.listingId ?? null,
  });
  await repository.recordVocabularyProposal('MEDIA_TYPE', input.name, {
    listingId: input.listingId ?? null,
  });
  return { mediaType: created, similarity: best?.score ?? 0, outcome: 'CREATED' };
}

async function uniqueSlug(base: string): Promise<string> {
  const candidate = base || 'media-type';
  if (!(await repository.findMediaTypeBySlug(candidate))) return candidate;
  for (let n = 2; n < 100; n += 1) {
    const next = `${candidate}-${n}`;
    if (!(await repository.findMediaTypeBySlug(next))) return next;
  }
  return `${candidate}-${Date.now()}`;
}

/**
 * Folds one media type into another.
 *
 * The repair tool, and the reason matching can afford to be eager. The source
 * is kept as a tombstone rather than deleted so anything still pointing at it
 * resolves instead of dangling.
 */
export async function mergeMediaTypes(sourceId: string, targetId: string): Promise<MediaType> {
  if (sourceId === targetId) {
    throw new ApiError(400, 'BAD_REQUEST', 'A media type cannot be merged into itself');
  }
  const [source, target] = await Promise.all([
    repository.findMediaType(sourceId),
    repository.findMediaType(targetId),
  ]);
  if (!source) throw new ApiError(404, 'NOT_FOUND', 'Media type to merge not found');
  if (!target) throw new ApiError(404, 'NOT_FOUND', 'Media type to merge into not found');
  if (target.status === 'MERGED') {
    throw new ApiError(
      409,
      'CONFLICT',
      'That media type has itself been merged away — merge into the type it points at instead'
    );
  }
  if (source.category !== target.category) {
    throw new ApiError(
      409,
      'CONFLICT',
      'These media types are in different categories, so merging them would mix comparable sets'
    );
  }
  return repository.mergeMediaTypes(sourceId, targetId);
}

/**
 * Resolves a spot described in words into the ids the engine matches on.
 *
 * The one place a listing becomes comparable. Called by both listing paths so
 * they cannot drift: a spot with a media type but no size class never enters
 * any pool, because the match key needs all of them, and a silent partial
 * classification would look like a working listing that the indicator quietly
 * ignores forever.
 *
 * Ids win over names — an id is a decision already taken. Names go through the
 * similarity threshold; slugs must already exist, and an unknown one is
 * recorded for ops rather than invented.
 */
export type SpotDescription = {
  category: ListingCategory;
  /**
   * The venue, and the coarsest thing the match key divides on.
   *
   * Absent means the spot has no venue, which is correct for a roadside
   * hoarding and a latent mistake for anything indoors: null matches null, so
   * an unclassified indoor listing pools with the hoardings rather than with
   * the other spots in its own building.
   */
  venueTypeId?: string | null;
  venueTypeSlug?: string | null;
  mediaTypeId?: string | null;
  mediaTypeName?: string | null;
  sizeClassId?: string | null;
  sizeClassSlug?: string | null;
  /**
   * Measured dimensions, when the publisher was asked for a tape measure
   * rather than a dropdown. Used only when no class was named: DR 02 measures
   * the spot, and the class is derived from the pair the way a media type is
   * derived from a name.
   */
  widthFt?: string | null;
  heightFt?: string | null;
  materialId?: string | null;
  materialSlug?: string | null;
  listingId?: string | null;
};

export type ClassifiedSpot = {
  venueTypeId: string | null;
  mediaTypeId: string | null;
  sizeClassId: string | null;
  materialId: string | null;
  /**
   * Set when the class was derived from dimensions rather than named. The
   * caller stores the measurements alongside it, so a later disagreement about
   * which class a spot belongs in can be settled against the tape rather than
   * against whoever picked from the list.
   */
  derivedFromDimensions: boolean;
};

/**
 * Checks a batch of described spots without writing anything.
 *
 * Exists so a bulk import can reject every bad row at once, with row numbers,
 * *before* `classifySpot` starts creating media types. Without it the first bad
 * slug aborted the batch with no index, having already committed new media
 * types, match logs and vocabulary proposals that nothing then pointed at — and
 * the operator's corrected re-upload would classify differently, because those
 * types now existed to match against.
 */
export async function checkSpotVocabulary(
  rows: SpotDescription[]
): Promise<{ row: number; reason: string }[]> {
  const [mediaTypes, sizeClasses, materials, venueTypes] = await Promise.all([
    repository.listMediaTypes(),
    repository.listSizeClasses(),
    repository.listMaterials(),
    repository.listVenueTypes(true),
  ]);
  const mediaIds = new Set(mediaTypes.map((t) => t.id));
  const sizeIds = new Set(sizeClasses.map((c) => c.id));
  const sizeSlugs = new Set(sizeClasses.map((c) => c.slug));
  const materialIds = new Set(materials.map((m) => m.id));
  const materialSlugs = new Set(materials.map((m) => m.slug));
  // Ids come from every venue, active or not: an id on a patch is usually the
  // listing echoing back its own venue, and rejecting it the day ops retire
  // that venue would make the listing uneditable with a message saying its own
  // venue does not exist. Slugs stay active-only — a slug is a fresh choice, and
  // a retired venue must not accept new spots.
  const venueIds = new Set(venueTypes.map((v) => v.id));
  const venueSlugs = new Set(venueTypes.filter((v) => v.isActive).map((v) => v.slug));

  const problems: { row: number; reason: string }[] = [];
  for (const [index, row] of rows.entries()) {
    const at = index + 1;
    // Ids are foreign keys. Unchecked they reach createMany and surface as a
    // constraint violation the error handler renders as a 500 — taking the
    // whole batch with it, the same failure a bad price used to cause.
    if (row.venueTypeId && !venueIds.has(row.venueTypeId)) {
      problems.push({ row: at, reason: `Unknown venue type id "${row.venueTypeId}"` });
    }
    if (!row.venueTypeId && row.venueTypeSlug && !venueSlugs.has(row.venueTypeSlug)) {
      problems.push({ row: at, reason: `Unknown venue type "${row.venueTypeSlug}"` });
    }
    if (row.mediaTypeId && !mediaIds.has(row.mediaTypeId)) {
      problems.push({ row: at, reason: `Unknown media type id "${row.mediaTypeId}"` });
    }
    if (row.sizeClassId && !sizeIds.has(row.sizeClassId)) {
      problems.push({ row: at, reason: `Unknown size class id "${row.sizeClassId}"` });
    }
    if (row.materialId && !materialIds.has(row.materialId)) {
      problems.push({ row: at, reason: `Unknown material id "${row.materialId}"` });
    }
    if (!row.sizeClassId && row.sizeClassSlug && !sizeSlugs.has(row.sizeClassSlug)) {
      problems.push({ row: at, reason: `Unknown size class "${row.sizeClassSlug}"` });
    }
    if (!row.materialId && row.materialSlug && !materialSlugs.has(row.materialSlug)) {
      problems.push({ row: at, reason: `Unknown material "${row.materialSlug}"` });
    }
  }
  return problems;
}

export async function classifySpot(input: SpotDescription): Promise<ClassifiedSpot> {
  const problems = await checkSpotVocabulary([input]);
  if (problems.length > 0) {
    throw new ApiError(400, 'BAD_REQUEST', problems[0]!.reason, { problems });
  }

  let venueTypeId = input.venueTypeId ?? null;
  if (!venueTypeId && input.venueTypeSlug) {
    const found = await repository.findVenueTypeBySlug(input.venueTypeSlug);
    if (!found) {
      await repository.recordVocabularyProposal('VENUE_TYPE', input.venueTypeSlug, {
        listingId: input.listingId ?? null,
      });
      throw new ApiError(400, 'BAD_REQUEST', `Unknown venue type "${input.venueTypeSlug}"`);
    }
    venueTypeId = found.id;
  }

  const mediaTypeId =
    input.mediaTypeId ??
    (input.mediaTypeName
      ? (
          await matchMediaType({
            name: input.mediaTypeName,
            category: input.category,
            venueTypeId,
            listingId: input.listingId ?? null,
          })
        ).mediaType.id
      : null);

  // A format belongs to one venue, so the type already knows the answer. Taking
  // it from there when the caller did not say closes the gap where a listing
  // and a market data point describing the same real spot disagree about which
  // pool they are in — one having named a venue and the other not.
  if (venueTypeId === null && mediaTypeId !== null) {
    const type = await repository.findMediaType(mediaTypeId);
    venueTypeId = type?.venueTypeId ?? null;
  }

  let sizeClassId = input.sizeClassId ?? null;
  if (!sizeClassId && input.sizeClassSlug) {
    const found = await repository.findSizeClassBySlug(input.sizeClassSlug);
    if (!found) {
      await repository.recordVocabularyProposal('SIZE_CLASS', input.sizeClassSlug, {
        listingId: input.listingId ?? null,
      });
      throw new ApiError(400, 'BAD_REQUEST', `Unknown size class "${input.sizeClassSlug}"`);
    }
    sizeClassId = found.id;
  }

  let materialId = input.materialId ?? null;
  if (!materialId && input.materialSlug) {
    const found = await repository.findMaterialBySlug(input.materialSlug);
    if (!found) {
      await repository.recordVocabularyProposal('MATERIAL', input.materialSlug, {
        listingId: input.listingId ?? null,
      });
      throw new ApiError(400, 'BAD_REQUEST', `Unknown material "${input.materialSlug}"`);
    }
    materialId = found.id;
  }

  // Last resort, and the one DR 02 actually walks a publisher through: a width
  // and a height, no class named. Deriving here rather than at the call site
  // keeps both listing paths on one rule -- and keeps the derived class out of
  // the way whenever somebody did name one, since a measurement should not
  // silently overrule a decision.
  let derivedFromDimensions = false;
  if (!sizeClassId && input.widthFt && input.heightFt) {
    // The tolerance comes from settings rather than the repository, because it
    // is a pricing judgement — how coarsely the market is cut — and ops can
    // move it without a deploy.
    const { sizeTolerancePct } = await getSettings();
    const resolved = await repository.resolveSizeClassForDimensions(
      input.widthFt,
      input.heightFt,
      sizeTolerancePct.toString()
    );
    sizeClassId = resolved.id;
    derivedFromDimensions = true;
  }

  return { venueTypeId, mediaTypeId, sizeClassId, materialId, derivedFromDimensions };
}

/* ------------------------------------------------------------------ */
/* Factors                                                             */
/* ------------------------------------------------------------------ */

/**
 * A tiny predicate language for `PricingFactor.suggestWhen`.
 *
 * Deliberately not an expression evaluator: ops-authored JSON that reaches an
 * eval is a remote code execution waiting to happen, and everything these rules
 * need to say fits in comparisons joined by all/any/not.
 */
export function evaluatePredicate(rule: unknown, facts: Record<string, unknown>): boolean {
  if (rule === null || typeof rule !== 'object') return false;
  const node = rule as Record<string, unknown>;

  if (Array.isArray(node['all'])) return node['all'].every((r) => evaluatePredicate(r, facts));
  if (Array.isArray(node['any'])) return node['any'].some((r) => evaluatePredicate(r, facts));
  if ('not' in node) return !evaluatePredicate(node['not'], facts);

  const field = node['field'];
  if (typeof field !== 'string') return false;
  // Own properties only. `facts` is null-prototyped at source, but this function
  // is exported and the next caller's object may not be.
  const actual = Object.prototype.hasOwnProperty.call(facts, field)
    ? facts[field]
    : undefined;

  if ('eq' in node) return actual === node['eq'];
  if (Array.isArray(node['in'])) return node['in'].includes(actual);

  const numeric = typeof actual === 'number' ? actual : Number.NaN;
  if (Number.isNaN(numeric)) return false;
  if (typeof node['gt'] === 'number') return numeric > node['gt'];
  if (typeof node['gte'] === 'number') return numeric >= node['gte'];
  if (typeof node['lt'] === 'number') return numeric < node['lt'];
  if (typeof node['lte'] === 'number') return numeric <= node['lte'];
  return false;
}

/**
 * What a factor rule can read. Derived from the place, never typed by hand.
 *
 * `sizeClass` is deliberately absent, and its absence is the enforcement rather
 * than a comment elsewhere saying not to. Size is already counted once, in the
 * size class the comparables were matched on; a multiplier keyed on size would
 * compound it onto a base that already reflects it. Prose in three files did not
 * stop an admin writing that rule — not putting the field within reach does.
 *
 * Built with a null prototype so a rule naming `__proto__` or `constructor`
 * reads undefined rather than reaching Object.prototype. Nothing here writes,
 * so there is no pollution today; this keeps that true for the next caller.
 */
export function factsFor(listing: ListingPricingContext): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, {
    city: listing.city,
    category: listing.category,
    mediaType: listing.mediaTypeSlug,
    material: listing.materialSlug,
    latitude: listing.latitude,
    longitude: listing.longitude,
    // Physical attributes. DR 10 priced these as fixed multipliers on a central
    // rate card; here they are inputs a factor rule may read, which is the same
    // observation put behind a decision a person still makes.
    illumination: listing.illumination,
    facing: listing.facing,
    elevation: listing.elevation,
    visibility: listing.visibility,
    trafficGrade: listing.trafficGrade,
    // Deliberately NOT sizeClass. Area is offered because a rule may want a
    // threshold on it, but the size *class* is already counted in the base and
    // keying a multiplier on it would double-count.
    areaSqFt: listing.areaSqFt === null ? null : Number(listing.areaSqFt),
  });
}

export type FactorProposal = {
  factorId: string;
  name: string;
  kind: 'BASE_ADJUST' | 'MULTIPLIER';
  multiplier: string | null;
  baseAdjust: Money | null;
  description: string | null;
  /** Lot E (Q125): ADVISORY proposes; BINDING reprices when applied. */
  mode: PricingFactorMode;
  bindingDuringSurgeOnly: boolean;
  suggested: boolean;
  applied: boolean;
  /** The rate a BINDING apply wrote, for the trail. Null on an advisory apply. */
  appliedRatePerDay: Money | null;
};

/**
 * Every candidate factor for a listing, with the favourable ones marked.
 *
 * The engine proposes; ADX decides. Nothing here multiplies a price on its own
 * — `suggested` and `applied` are separate columns because a suggestion the
 * engine made and a decision a person took are different facts, and collapsing
 * them into one state would lose the audit trail on every price we set.
 */
export async function factorProposals(listingId: string): Promise<FactorProposal[]> {
  const listing = await repository.listingContext(listingId);
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  if (!listing.mediaTypeId) return [];

  const [factors, applications] = await Promise.all([
    repository.listFactors(listing.mediaTypeId),
    repository.listingFactorApplications(listingId),
  ]);
  const applied = new Map(applications.map((a) => [a.factorId, a]));
  const facts = factsFor(listing);

  return factors
    .filter((factor) => factor.isActive)
    .map((factor) => {
      const suggested =
        factor.suggestWhen !== null && evaluatePredicate(factor.suggestWhen, facts);
      const application = applied.get(factor.id);
      return {
        factorId: factor.id,
        name: factor.name,
        kind: factor.kind,
        multiplier: factor.multiplier === null ? null : new D(factor.multiplier).toString(),
        baseAdjust: factor.baseAdjust === null ? null : money(factor.baseAdjust),
        description: factor.description,
        mode: factor.mode,
        bindingDuringSurgeOnly: factor.bindingDuringSurgeOnly,
        suggested,
        applied: application?.applied ?? false,
        appliedRatePerDay: application?.appliedRatePerDay ?? null,
      };
    });
}

/** Records which factors the engine currently proposes, without applying any. */
export async function refreshSuggestions(listingId: string): Promise<FactorProposal[]> {
  const proposals = await factorProposals(listingId);
  await repository.setFactorSuggestions(
    listingId,
    proposals.filter((p) => p.suggested).map((p) => p.factorId)
  );
  return proposals;
}

/**
 * Whether this factor binds for this listing right now.
 *
 * A BINDING factor binds. One flagged `bindingDuringSurgeOnly` binds only
 * while a surge window covers the spot — the rest of the time it is an
 * advisory like any other, because the lift it describes is the window's.
 */
async function bindsNow(
  factor: { mode: PricingFactorMode; bindingDuringSurgeOnly: boolean },
  listing: ListingPricingContext
): Promise<{ binding: boolean; surgeId: string | null }> {
  if (factor.mode !== 'BINDING') return { binding: false, surgeId: null };
  if (!factor.bindingDuringSurgeOnly) return { binding: true, surgeId: null };
  if (listing.latitude === null || listing.longitude === null) return { binding: false, surgeId: null };
  const surge = await activeSurge({
    latitude: listing.latitude,
    longitude: listing.longitude,
    city: listing.city,
  });
  return { binding: surge !== null, surgeId: surge?.id ?? null };
}

/**
 * A person applies (or un-applies) a factor to a listing.
 *
 * ADVISORY: the decision is recorded and nothing else moves — the publisher
 * sees the offer at `GET /listings/me/:id/suggested-rate` and takes it or not.
 *
 * BINDING (Lot E, Q125): the listing is repriced to the suggested rate with
 * the factor worked in, through the listing module's own update path so the
 * surge provenance and the unit pair stay honest. The move is capped: above
 * `maxBindingChangePct` of the current rate the apply is refused with 409
 * BINDING_CHANGE_TOO_LARGE and a price case is raised carrying the rate the
 * factor wanted, so a person decides the big ones. The row is only written
 * when the reprice went through — a factor marked applied whose price never
 * moved would be a lie in the trail.
 *
 * Un-applying a binding factor reprices the same way, minus the factor. A
 * price that kept a multiplier nobody applied any more would be the quiet
 * drift this column exists to prevent.
 */
export async function setFactorApplied(
  listingId: string,
  factorId: string,
  applied: boolean,
  userId: string
): Promise<FactorProposal[]> {
  const [factor, listing] = await Promise.all([
    repository.findFactor(factorId),
    repository.listingContext(listingId),
  ]);
  if (!factor) throw new ApiError(404, 'NOT_FOUND', 'Pricing factor not found');
  if (!listing) throw new ApiError(404, 'NOT_FOUND', 'Listing not found');
  // Factors are per media type, and `factorProposals` filters by the listing's.
  // Without this check the row is written, never surfaced and never applied — a
  // decision someone took that silently does nothing.
  if (factor.mediaTypeId !== listing.mediaTypeId) {
    throw new ApiError(
      409,
      'CONFLICT',
      'That factor belongs to a different media type, so it can never apply to this listing'
    );
  }

  const { binding, surgeId } = await bindsNow(factor, listing);

  if (!binding) {
    await repository.setFactorApplied(listingId, factorId, applied, userId, null);
    await logActivity(userId, 'LISTING_FACTOR_APPLIED', {
      targetType: 'Listing',
      targetId: listingId,
      module: 'pricing',
      metadata: {
        factorId,
        factorName: factor.name,
        applied,
        mode: factor.mode,
        binding: false,
        ...(factor.mode === 'BINDING' && factor.bindingDuringSurgeOnly
          ? { reason: 'No surge window covers this listing, so the factor is advisory today' }
          : {}),
      },
    });
    return factorProposals(listingId);
  }

  // What the price would be with this decision taken — computed before
  // anything is written, so a refused apply leaves no trace but the case.
  const [settings, current] = await Promise.all([getSettings(), factorProposals(listingId)]);
  const assumed = current.map((p) => (p.factorId === factorId ? { ...p, applied } : p));
  const offer = await suggestedRateFrom(listing, assumed, settings);
  const next = new D(offer.ratePerDay);
  const previous = listing.ratePerDay === null ? null : new D(listing.ratePerDay);

  // Q125's cap is a ratio of the rate the listing already had — |new − old| /
  // old — so it has nothing to measure against when there is no previous
  // rate, or a previous rate of zero (a division by zero, and a listing
  // nobody priced). Both are deliberately skipped: the binding apply simply
  // prices the spot, the same as a listing being priced for the first time.
  // A listing that was live at zero is a data fault, not a price move, and
  // holding it to a percentage of nothing would refuse every apply for ever.
  if (previous !== null && previous.greaterThan(0)) {
    const change = next.minus(previous).abs().dividedBy(previous);
    if (change.greaterThan(settings.maxBindingChangePct)) {
      const capPct = settings.maxBindingChangePct.times(100).toString();
      const reason = `binding factor exceeded cap: "${factor.name}" would move the rate from ${money(previous)} to ${money(next)} a day (${change.times(100).toDecimalPlaces(1).toString()}%), above the ${capPct}% a binding factor may move on its own`;
      const raised = await listingRepricePort().raisePriceCase({
        listingId,
        requestedRatePerDay: money(next),
        requestedById: userId,
        reason,
      });
      await logActivity(userId, 'LISTING_FACTOR_CASE_RAISED', {
        targetType: 'Listing',
        targetId: listingId,
        module: 'pricing',
        metadata: { factorId, factorName: factor.name, applied, priceApprovalId: raised.id, reason },
      });
      throw new ApiError(
        409,
        'BINDING_CHANGE_TOO_LARGE',
        `"${factor.name}" would move this rate by more than ${capPct}%. A price case has been raised for a person to decide.`,
        { priceApprovalId: raised.id, from: money(previous), to: money(next), capPct }
      );
    }
  }

  await listingRepricePort().reprice({ listingId, ratePerDay: money(next), actorUserId: userId });
  await repository.setFactorApplied(listingId, factorId, applied, userId, applied ? money(next) : null);
  await logActivity(userId, 'LISTING_REPRICED_BY_FACTOR', {
    targetType: 'Listing',
    targetId: listingId,
    module: 'pricing',
    diff: auditDiff(
      { ratePerDay: previous === null ? null : money(previous) },
      { ratePerDay: money(next) }
    ),
    metadata: { factorId, factorName: factor.name, applied, mode: factor.mode, binding: true, surgeId },
  });

  const ownerUserId = listing.publisherId ? await repository.publisherUserId(listing.publisherId) : null;
  if (ownerUserId) {
    void createNotification({
      userId: ownerUserId,
      type: 'SYSTEM',
      title: 'Your listing was repriced',
      message: `ADX ${applied ? 'applied' : 'removed'} the "${factor.name}" pricing factor on your listing. The rate is now ${money(next)} a day${previous === null ? '' : ` (was ${money(previous)})`}.`,
      relatedId: listingId,
      relatedType: 'LISTING',
    }).catch(() => {});
  }

  return factorProposals(listingId);
}

export type SuggestedRate = {
  base: Money;
  ratePerDay: Money;
  compoundMultiplier: string;
  /** True when the compounded multipliers hit the ceiling. Flagged, not clamped. */
  cappedOut: boolean;
  applied: {
    name: string;
    kind: 'BASE_ADJUST' | 'MULTIPLIER';
    value: string;
    /** Which ones already moved the price (BINDING) and which are the offer (ADVISORY). */
    mode: PricingFactorMode;
  }[];
};

/**
 * Base rate with the applied factors worked through, for exclusive publishers.
 *
 * Base adjusters move the base, then multipliers scale the result — order
 * matters and this is the only order that makes a base adjuster mean what its
 * name says.
 *
 * The compounding cap flags rather than clamps. Ten individually reasonable
 * multipliers still reach somewhere absurd, and silently trimming the answer
 * would hide the misconfiguration that caused it.
 */
export async function suggestedRate(listingId: string): Promise<SuggestedRate> {
  const [settings, listing, proposals] = await Promise.all([
    getSettings(),
    requirePlaceableListing(listingId),
    factorProposals(listingId),
  ]);
  return suggestedRateFrom(listing, proposals, settings);
}

/**
 * The arithmetic behind `suggestedRate`, over proposals the caller supplies.
 *
 * Split out so a binding apply can price the decision it is about to take
 * before writing it: the proposals it passes carry the factor as applied,
 * while the table still says otherwise.
 */
async function suggestedRateFrom(
  listing: ListingPricingContext,
  proposals: FactorProposal[],
  settings: ResolvedSettings
): Promise<SuggestedRate> {
  if (
    listing.mediaTypeId === null ||
    listing.sizeClassId === null ||
    listing.latitude === null ||
    listing.longitude === null
  ) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      'This listing has no media type, size class or coordinates, so it cannot be compared'
    );
  }

  const set = await comparablesFor({
    venueTypeId: listing.venueTypeId,
    mediaTypeId: listing.mediaTypeId,
    sizeClassId: listing.sizeClassId,
    latitude: listing.latitude,
    longitude: listing.longitude,
    excludeListingId: listing.id,
  });

  // Midpoint of the range is the base. With no comparables there is nothing to
  // build on, and inventing a base would be exactly the quoting this engine
  // refuses to do.
  if (set.low === null || set.high === null) {
    throw new ApiError(
      409,
      'CONFLICT',
      `No comparable spots within ${settings.radiusMeters} m, so there is no base rate to build a suggestion from`
    );
  }
  const base = new D(set.low).plus(new D(set.high)).dividedBy(2);

  const active = proposals.filter((p) => p.applied);
  let adjusted = base;
  for (const factor of active.filter((p) => p.kind === 'BASE_ADJUST')) {
    adjusted = adjusted.plus(new D(factor.baseAdjust ?? 0));
  }
  let compound = new D(1);
  for (const factor of active.filter((p) => p.kind === 'MULTIPLIER')) {
    compound = compound.times(new D(factor.multiplier ?? 1));
  }

  const cappedOut = compound.greaterThan(settings.maxCompoundMultiplier);

  return {
    base: money(base),
    ratePerDay: money(adjusted.times(compound)),
    compoundMultiplier: compound.toString(),
    cappedOut,
    applied: active.map((p) => ({
      name: p.name,
      kind: p.kind,
      value: p.kind === 'MULTIPLIER' ? (p.multiplier ?? '1') : (p.baseAdjust ?? '0'),
      mode: p.mode,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Market data import                                                  */
/* ------------------------------------------------------------------ */

export type ImportRow = {
  contributorName: string;
  /** The venue a researched spot sits in. Part of the match key. */
  venueTypeId?: string | null;
  /** The same, as the sweep spelled it. Resolved against the controlled list. */
  venueTypeSlug?: string | null;
  /**
   * Set when the researched company is also an ADX publisher.
   *
   * Without it the same company speaks twice — once as `res:<name>` from the
   * field sweep and once as `pub:<id>` through their own listings — and a
   * two-contributor range is really one opinion counted twice.
   */
  publisherId?: string | null;
  mediaTypeSlug: string;
  sizeClassSlug: string;
  materialSlug?: string | null;
  latitude: number;
  longitude: number;
  city?: string | null;
  locality?: string | null;
  ratePerDay: string;
  observedAt: string;
};

/**
 * Whose opinion a row represents.
 *
 * A publisher id wins wherever there is one, so a company that is both an ADX
 * publisher and a research subject collapses to a single voice. Falling back to
 * a slugified name is best-effort: "Acme Outdoor" and "Acme Outdoor Pvt Ltd" are
 * two contributors, which is why the id matters. A name that slugifies to
 * nothing keeps its raw text rather than collapsing every unnameable
 * contributor into one bucket.
 */
export function contributorKeyFor(
  source: 'RESEARCH' | 'RATE_CARD',
  publisherId: string | null,
  row: Pick<ImportRow, 'contributorName' | 'publisherId'>
): string {
  const linked = row.publisherId ?? (source === 'RATE_CARD' ? publisherId : null);
  if (linked) return `pub:${linked}`;
  return `res:${slugify(row.contributorName) || row.contributorName.trim().toLowerCase()}`;
}

export type ImportResult = {
  importId: string;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  rejections: { row: number; reason: string }[];
};

/**
 * Loads the research team's output.
 *
 * Their fieldwork happens entirely outside this platform — no admin screen is
 * part of it. Only the rows land here, and at launch they are very nearly the
 * only comparables that exist, which is why an unrecognised vocabulary value is
 * a rejection with a reason rather than a silently invented media type.
 */
export async function importMarketData(input: {
  source: 'RESEARCH' | 'RATE_CARD';
  filename: string | null;
  note: string | null;
  uploadedById: string | null;
  publisherId?: string | null;
  rows: ImportRow[];
}): Promise<ImportResult> {
  if (input.source === 'RATE_CARD' && !input.publisherId) {
    throw new ApiError(400, 'BAD_REQUEST', 'A rate card import must name the publisher it came from');
  }

  const batch = await repository.createImport({
    source: input.source,
    filename: input.filename,
    note: input.note,
    uploadedById: input.uploadedById,
  });

  const [mediaTypes, sizeClasses, materials, venueTypes] = await Promise.all([
    repository.listMediaTypes(),
    repository.listSizeClasses(),
    repository.listMaterials(),
    repository.listVenueTypes(),
  ]);
  /**
   * Slug first, then name.
   *
   * A field researcher works in a spreadsheet, and nobody types
   * `flyovers-overpasses-elevated-roads-skywalks-elevated-metro-under-viaduct`
   * into a cell. They write what the thing is called. Accepting both costs one
   * extra key per row and removes the only reason the import needed a
   * pre-generated template to be usable at all.
   *
   * Later entries never overwrite earlier ones, so a slug always wins over a
   * name that happens to slugify to the same string — the slug is the identity,
   * and the name is a convenience laid beside it.
   */
  const lookup = <T extends { slug: string; name?: string | null }>(rows: T[]): Map<string, T> => {
    const byKey = new Map<string, T>();
    for (const row of rows) byKey.set(row.slug, row);
    for (const row of rows) {
      // A row with no name contributes only its slug. Nothing in the schema
      // makes `name` optional, but a lookup that throws on one malformed row
      // takes a five-thousand-row upload with it.
      if (!row.name) continue;
      const key = slugify(row.name);
      if (key && !byKey.has(key)) byKey.set(key, row);
    }
    return byKey;
  };

  const mediaBySlug = lookup(mediaTypes);
  const sizeBySlug = lookup(sizeClasses);
  const materialBySlug = lookup(materials);
  const venueBySlug = lookup(venueTypes);

  /**
   * A format's short name, within its venue.
   *
   * Catalogue names are venue-qualified — "Shopping Malls / Retail Centers —
   * Atrium LED Wall" — because the same words mean different markets in
   * different buildings. A researcher writing "Atrium LED Wall" in a sheet whose
   * Venue column already says which building means exactly one thing, and
   * refusing it would be pedantry the row cannot answer.
   */
  const shortNameByVenue = new Map<string, (typeof mediaTypes)[number]>();
  for (const type of mediaTypes) {
    if (!type.name) continue;
    const parts = type.name.split(' — ');
    const short = parts[parts.length - 1] ?? type.name;
    const key = `${type.venueTypeId ?? 'none'}|${slugify(short)}`;
    if (!shortNameByVenue.has(key)) shortNameByVenue.set(key, type);
  }

  const accepted: NewMarketDataPoint[] = [];
  const rejections: { row: number; reason: string }[] = [];

  for (const [index, row] of input.rows.entries()) {
    // Rejected rather than filed venue-less: a row whose venue the sweep named
    // but this platform does not recognise is a vocabulary gap ops should see,
    // and quietly dropping the venue would file it into the wrong pool instead.
    let venueTypeId: string | null = row.venueTypeId ?? null;
    if (!venueTypeId && row.venueTypeSlug) {
      const venue = venueBySlug.get(row.venueTypeSlug);
      if (!venue) {
        rejections.push({ row: index + 1, reason: `Unknown venue type "${row.venueTypeSlug}"` });
        await repository.recordVocabularyProposal('VENUE_TYPE', row.venueTypeSlug, {
          importId: batch.id,
        });
        continue;
      }
      venueTypeId = venue.id;
    }

    const mediaType =
      mediaBySlug.get(row.mediaTypeSlug) ??
      shortNameByVenue.get(`${venueTypeId ?? 'none'}|${row.mediaTypeSlug}`);
    if (!mediaType) {
      rejections.push({ row: index + 1, reason: `Unknown media type "${row.mediaTypeSlug}"` });
      await repository.recordVocabularyProposal('MEDIA_TYPE', row.mediaTypeSlug, {
        importId: batch.id,
      });
      continue;
    }
    if (mediaType.status === 'MERGED') {
      rejections.push({
        row: index + 1,
        reason: `Media type "${row.mediaTypeSlug}" has been merged away`,
      });
      continue;
    }
    const sizeClass = sizeBySlug.get(row.sizeClassSlug);
    if (!sizeClass) {
      rejections.push({ row: index + 1, reason: `Unknown size class "${row.sizeClassSlug}"` });
      await repository.recordVocabularyProposal('SIZE_CLASS', row.sizeClassSlug, {
        importId: batch.id,
      });
      continue;
    }
    let materialId: string | null = null;
    if (row.materialSlug) {
      const material = materialBySlug.get(row.materialSlug);
      if (!material) {
        rejections.push({ row: index + 1, reason: `Unknown material "${row.materialSlug}"` });
        await repository.recordVocabularyProposal('MATERIAL', row.materialSlug, {
          importId: batch.id,
        });
        continue;
      }
      materialId = material.id;
    }

    const observedAt = new Date(row.observedAt);
    if (Number.isNaN(observedAt.getTime())) {
      rejections.push({ row: index + 1, reason: `Unreadable observation date "${row.observedAt}"` });
      continue;
    }

    // The MarketDataPoint_rate_positive constraint would catch this, but
    // createMany is all-or-nothing: one zero would take a five-thousand-row
    // upload down with a database error instead of a row number and a reason.
    if (new D(row.ratePerDay).lessThanOrEqualTo(0)) {
      rejections.push({ row: index + 1, reason: `Rate must be greater than zero` });
      continue;
    }

    // The format already knows its venue, so a sweep that omitted the column
    // still lands in the right pool. Without this, a research file with no
    // Venue column filed every observation as venue-less while every listing of
    // the same spots carried a venue, and the two halves never met.
    const typeVenue = mediaType.venueTypeId ?? null;
    if (venueTypeId === null) venueTypeId = typeVenue;
    // And when the sheet says one thing and the catalogue says another, that is
    // a disagreement about which market this is — not something to average over.
    if (typeVenue !== null && venueTypeId !== typeVenue) {
      rejections.push({
        row: index + 1,
        reason: `"${row.mediaTypeSlug}" belongs to a different venue than the one named on this row`,
      });
      continue;
    }

    accepted.push({
      source: input.source,
      importId: batch.id,
      // A rate card keys to its publisher, so it cannot double-count against
      // that publisher's own listings. Research keys to the competitor's name,
      // which is only as stable as the researcher's typing — and if the company
      // is *also* an ADX publisher, naming them here unifies the two so they
      // still speak once.
      contributorKey: contributorKeyFor(input.source, input.publisherId ?? null, row),
      contributorName: row.contributorName,
      publisherId: row.publisherId ?? input.publisherId ?? null,
      venueTypeId,
      mediaTypeId: mediaType.id,
      sizeClassId: sizeClass.id,
      materialId,
      latitude: row.latitude,
      longitude: row.longitude,
      city: row.city ?? null,
      locality: row.locality ?? null,
      ratePerDay: money(row.ratePerDay),
      observedAt,
    });
  }

  const inserted = accepted.length > 0 ? await repository.insertMarketDataPoints(accepted) : 0;
  await repository.finishImport(
    batch.id,
    {
      rowCount: input.rows.length,
      acceptedCount: inserted,
      rejectedCount: rejections.length,
    },
    rejections
  );

  return {
    importId: batch.id,
    rowCount: input.rows.length,
    acceptedCount: inserted,
    rejectedCount: rejections.length,
    rejections,
  };
}

/** Undoes an import without losing the audit trail. */
export async function revokeImport(importId: string): Promise<{ deactivated: number }> {
  return { deactivated: await repository.deactivateImport(importId) };
}
