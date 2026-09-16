import { redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { haversineMeters } from '../../shared/geo';
import { logger } from '../../shared/logging';
import { toListPage, type ListPage } from '../../shared/pagination';
import { getPlatformSettings } from '../app-config';
import { findUserLabels, type UserLabel } from '../users';
import { CITY_KEYED_TABLES, CITY_STAGES, backfillCityKeys, slugify, type CityKeyedTable, type CityStageValue, type CitySwitches } from '../pricing';
import { prismaGeoRepository } from './prisma-geo.repository';
import type {
  CityCounts,
  CityMatch,
  CityKind,
  CityListFilter,
  GeoCityRow,
  GeoRepository,
  MapBounds,
  RolloutEventRow,
  StageCounts,
} from './geo.repository';
import { cachedCityAudienceProfile, type CityAudienceProfile } from './audience-profile.service';
import { planRollout, type RolloutPlan } from './rollout.rules';
import { runGeoSeed, type GeoDataset, type GeoOverrides, type GeoSeedSummary } from './seed.service';

/**
 * The rollout — Lot V.
 *
 * Every read the console draws over the catalogue, and the one write that
 * moves a city: `changeRollout` (one city), `bulkRollout` (a list, a state
 * or a district), `addCity` (a place the dataset lacks). The controller
 * audits; this returns what it needs to. The repository is swappable for
 * the tests' in-memory one.
 */

let repository: GeoRepository = prismaGeoRepository;

/** Tests only: swap the repository. */
export function setGeoRepository(next: GeoRepository | null): void {
  repository = next ?? prismaGeoRepository;
}

/** Lot X-B: how the party tables are asked about a city — its key, the spellings as the fallback for rows keyed to nothing. */
export const matchOf = (city: Pick<GeoCityRow, 'id' | 'name' | 'slug' | 'aliases'>): CityMatch => ({ cityId: city.id, spellings: spellingsOf(city) });

/** Every spelling a city's free-text columns may carry: its name, its slug, its aliases (de-hyphenated too). */
export function spellingsOf(city: Pick<GeoCityRow, 'name' | 'slug' | 'aliases'>): string[] {
  const out = new Map<string, string>();
  const add = (spelling: string) => {
    const key = spelling.toLowerCase();
    if (!out.has(key)) out.set(key, spelling);
  };
  add(city.name);
  add(city.slug);
  add(city.slug.replace(/-/g, ' '));
  for (const alias of city.aliases) {
    add(alias);
    add(alias.replace(/-/g, ' '));
  }
  return [...out.values()];
}

/* ── views ─────────────────────────────────────────────────────── */

export type CityView = GeoCityRow;

const toView = (city: GeoCityRow): CityView => city;

const flat = (city: GeoCityRow) => ({
  stage: city.stage,
  isActive: city.isActive,
  ...city.switches,
  launchedAt: city.launchedAt,
  pausedAt: city.pausedAt,
  withdrawnAt: city.withdrawnAt,
  rolloutNote: city.rolloutNote,
});

export type RolloutFlat = ReturnType<typeof flat>;

/* ── reads ─────────────────────────────────────────────────────── */

function emptyCounts(): StageCounts {
  const counts = {} as StageCounts;
  for (const stage of CITY_STAGES) counts[stage] = 0;
  return counts;
}

export async function listStates(): Promise<{ id: string; code: string; name: string; latitude: number | null; longitude: number | null; counts: StageCounts; cities: number }[]> {
  const [states, groups] = await Promise.all([repository.listStates(), repository.stageCountsByState()]);
  const byState = new Map<string, StageCounts>();
  for (const group of groups) {
    const counts = byState.get(group.stateId) ?? emptyCounts();
    counts[group.stage] += group.count;
    byState.set(group.stateId, counts);
  }
  return states.map((state) => {
    const counts = byState.get(state.id) ?? emptyCounts();
    return { id: state.id, code: state.code, name: state.name, latitude: state.latitude, longitude: state.longitude, counts, cities: Object.values(counts).reduce((a, b) => a + b, 0) };
  });
}

export async function listDistricts(stateCode: string) {
  const state = await repository.findStateByCode(stateCode);
  if (!state) throw new ApiError(404, 'NOT_FOUND', 'No such state');
  const [districts, groups] = await Promise.all([repository.listDistricts(state.id), repository.stageCountsByDistrict(state.id)]);
  const byDistrict = new Map<string, StageCounts>();
  for (const group of groups) {
    const counts = byDistrict.get(group.districtId) ?? emptyCounts();
    counts[group.stage] += group.count;
    byDistrict.set(group.districtId, counts);
  }
  return {
    state: { id: state.id, code: state.code, name: state.name },
    items: districts.map((district) => {
      const counts = byDistrict.get(district.id) ?? emptyCounts();
      return { id: district.id, code: district.code, name: district.name, latitude: district.latitude, longitude: district.longitude, counts, cities: Object.values(counts).reduce((a, b) => a + b, 0) };
    }),
  };
}

export type CityListQuery = Omit<CityListFilter, 'stateId' | 'districtId'> & { state?: string | undefined; district?: string | undefined };

export async function listCities(query: CityListQuery): Promise<ListPage<CityView>> {
  const { state, district, ...rest } = query;
  const filter: CityListFilter = { ...rest };
  if (state) {
    const row = await repository.findStateByCode(state);
    if (!row) return toListPage([], 0, emptyCounts(), query);
    filter.stateId = row.id;
  }
  if (district) filter.districtId = district;
  const { items, total, counts } = await repository.listCities(filter);
  return toListPage(items.map(toView), total, counts, query);
}

export async function requireCity(slug: string): Promise<GeoCityRow> {
  const city = await repository.findCityBySlug(slug);
  if (!city) throw new ApiError(404, 'NOT_FOUND', 'No such city');
  return city;
}

/** An event as the city page draws it — W-B: who moved the city, by name. */
export type RolloutEventView = RolloutEventRow & { byUser: UserLabel };

export async function getCity(slug: string): Promise<CityView & { counts: CityCounts; events: RolloutEventView[] }> {
  const city = await requireCity(slug);
  const [counts, events] = await Promise.all([repository.cityCounts(matchOf(city)), repository.listRolloutEvents(city.id, 50)]);
  // W-B: one label lookup for the page, never one per event.
  const labels = await findUserLabels([...new Set(events.map((event) => event.byUserId))]);
  return {
    ...toView(city),
    counts,
    events: events.map((event) => ({ ...event, byUser: labels.get(event.byUserId) ?? { id: event.byUserId, name: null } })),
  };
}

export type ReadinessCheck = {
  key: 'rateCard' | 'agents' | 'listings' | 'printPartner' | 'vocabulary' | 'audience';
  ok: boolean;
  detail: string;
  /** Y-B: a soft check is printed but never counted in `ready`. */
  soft?: true;
};

/**
 * Y-B: the city audience profile — the blend over the city's spots'
 * snapshots for a month, cached a minute; no vendor is called unless
 * `settings.audience.cityProfileSamplePoints` is on. Exported for the
 * console read and for the lead score (the leads lots) to read a city's
 * footfall for fit.
 */
export async function cityAudienceProfile(slug: string, period?: string, now = new Date()): Promise<CityAudienceProfile> {
  const city = await requireCity(slug);
  return cachedCityAudienceProfile(city, matchOf(city), repository, period, now);
}

/**
 * What ops look at before launching: advisory, never a gate — the owner
 * asked for control, not a platform that argues about where it goes.
 * Y-B: `audience` is softer still — whether a panel backs the city, never
 * counted in `ready`, and a failed read is a detail, not an error.
 */
export async function cityReadiness(slug: string, now = new Date()): Promise<{ city: string; stage: CityStageValue; ready: boolean; checks: ReadinessCheck[] }> {
  const city = await requireCity(slug);
  const match = matchOf(city);
  const settings = (await getPlatformSettings()).geo;
  const [card, agents, counts, partners, vocabulary, audience] = await Promise.all([
    repository.rateCardInForce(city.id, now),
    repository.activeAgentsBySide(match),
    repository.cityCounts(match),
    repository.activePrintPartners(match),
    repository.vocabularyPresent(),
    cachedCityAudienceProfile(city, match, repository, undefined, now).then(
      (profile) => ({ profile, error: null as string | null }),
      (err: unknown) => ({ profile: null, error: err instanceof Error ? err.message : String(err) }),
    ),
  ]);
  const panels = (audience.profile?.coverage.withSnapshot ?? 0) + (audience.profile?.samplePoints?.withSnapshot ?? 0);
  const checks: ReadinessCheck[] = [
    {
      key: 'rateCard',
      ok: card !== null,
      detail: card ? `${card.name}${card.national ? ' (national)' : ''} is in force` : 'No rate card is in force for this city — the publish gate passes without one, but nothing floors the prices',
    },
    {
      key: 'agents',
      ok: agents.publisher >= 1 && agents.advertiser >= 1,
      detail: `${agents.publisher} publisher-side and ${agents.advertiser} advertiser-side agent(s) active`,
    },
    {
      key: 'listings',
      ok: counts.listingsLive >= settings.launchMinListings,
      detail: `${counts.listingsLive} live listing(s) of ${settings.launchMinListings} wanted (geo.launchMinListings)`,
    },
    {
      key: 'printPartner',
      ok: !settings.launchNeedsPrintPartner || partners >= 1,
      detail: settings.launchNeedsPrintPartner ? `${partners} active print partner(s); one is required (geo.launchNeedsPrintPartner)` : `${partners} active print partner(s); not required`,
    },
    { key: 'vocabulary', ok: vocabulary, detail: vocabulary ? 'Pricing vocabulary present' : 'No media types — run seed:pricing' },
    {
      key: 'audience',
      ok: panels > 0,
      soft: true,
      detail: audience.profile
        ? audience.profile.vendors.length === 0
          ? 'No audience vendor is configured (soft: never blocks a launch)'
          : `${audience.profile.basis} (soft: never blocks a launch)`
        : `Audience data unavailable: ${audience.error} (soft: never blocks a launch)`,
    },
  ];
  return { city: city.slug, stage: city.stage, ready: checks.every((check) => check.soft || check.ok), checks };
}

export async function mapPoints(bounds: MapBounds | null, stages: readonly CityStageValue[] | null) {
  const points = await repository.mapPoints(bounds, stages);
  // Live-listing counts only where a city could have any: one grouped query
  // over the non-PLANNED points, never one per pin.
  const open = points.filter((point) => point.stage !== 'PLANNED');
  // Lot X-B: by key, the name and the slug as the spelling fallback (the map point carries no aliases).
  const live = await repository.liveListingsByCity(open.map((point) => ({ cityId: point.id, spellings: [...new Set([point.name, point.slug.replace(/-/g, ' ')])] })));
  return points.map((point) => ({
    ...point,
    listingsLive: point.stage === 'PLANNED' ? 0 : (live.get(point.id) ?? 0),
  }));
}

export async function summary() {
  const [stages, states] = await Promise.all([repository.stageCounts(), listStates()]);
  const active = states.filter((state) => state.cities - state.counts.PLANNED > 0);
  return {
    stages,
    cities: Object.values(stages).reduce((a, b) => a + b, 0),
    statesWithActivity: active.length,
    states: active.map((state) => ({ code: state.code, name: state.name, counts: state.counts })),
  };
}

/* ── writes ────────────────────────────────────────────────────── */

export type RolloutChange = {
  stage?: CityStageValue | undefined;
  switches?: Partial<CitySwitches> | undefined;
  note?: string | undefined;
};

export type RolloutOutcome = {
  before: GeoCityRow;
  after: GeoCityRow;
  plan: RolloutPlan;
  beforeFlat: RolloutFlat;
  afterFlat: RolloutFlat;
};

async function applyPlan(city: GeoCityRow, plan: RolloutPlan, note: string | undefined, byUserId: string): Promise<GeoCityRow> {
  const after = await repository.updateCity(city.id, {
    stage: plan.stage,
    switches: plan.switches,
    isActive: plan.isActive,
    launchedAt: plan.launchedAt,
    pausedAt: plan.pausedAt,
    withdrawnAt: plan.withdrawnAt,
    ...(note !== undefined ? { rolloutNote: note } : {}),
  });
  await repository.createRolloutEvents([
    {
      cityId: city.id,
      fromStage: city.stage,
      toStage: plan.stage,
      flags: { switches: plan.switches, flipped: plan.flipped },
      byUserId,
      note: note ?? null,
    },
  ]);
  return after;
}

/**
 * One city, one patch: the stage (checked against the table), the switch
 * overrides, the note. Writes the row, the mirror and one event; answers
 * both sides for the audit. A patch that changes nothing writes nothing.
 */
export async function changeRollout(slug: string, change: RolloutChange, byUserId: string, now = new Date()): Promise<RolloutOutcome> {
  const city = await requireCity(slug);
  const plan = planRollout(city, change, now);
  if (!plan.changed && change.note === undefined) {
    return { before: city, after: city, plan, beforeFlat: flat(city), afterFlat: flat(city) };
  }
  const after = plan.changed ? await applyPlan(city, plan, change.note, byUserId) : await repository.updateCity(city.id, { rolloutNote: change.note ?? null });
  return { before: city, after, plan, beforeFlat: flat(city), afterFlat: flat(after) };
}

export type BulkScope = { citySlugs?: string[] | undefined; stateCode?: string | undefined; districtId?: string | undefined };

export type BulkOutcome = {
  changed: { slug: string; from: CityStageValue; to: CityStageValue }[];
  unchanged: string[];
  skipped: { slug: string; reason: string }[];
};

/**
 * Many cities to one stage — a list of slugs, a whole state or a district.
 * Each city is planned on its own: one the table refuses from its current
 * stage is skipped and named, never the whole batch failed, because "launch
 * Karnataka" over forty towns in three stages is the normal case. One event
 * per city that moved; the controller writes one audit summary.
 */
export async function bulkRollout(scope: BulkScope, change: RolloutChange & { stage: CityStageValue }, byUserId: string, now = new Date()): Promise<BulkOutcome> {
  let cities: GeoCityRow[];
  if (scope.citySlugs && scope.citySlugs.length > 0) {
    cities = await repository.findCitiesBySlugs(scope.citySlugs);
    const found = new Set(cities.map((city) => city.slug));
    const missing = scope.citySlugs.filter((slug) => !found.has(slug));
    if (missing.length > 0) throw new ApiError(404, 'NOT_FOUND', `No such city: ${missing.join(', ')}`, { missing });
  } else if (scope.stateCode) {
    const state = await repository.findStateByCode(scope.stateCode);
    if (!state) throw new ApiError(404, 'NOT_FOUND', 'No such state');
    cities = await repository.findCitiesIn({ stateId: state.id });
  } else if (scope.districtId) {
    const district = await repository.findDistrict(scope.districtId);
    if (!district) throw new ApiError(404, 'NOT_FOUND', 'No such district');
    cities = await repository.findCitiesIn({ districtId: district.id });
  } else {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Name citySlugs, a stateCode or a districtId');
  }

  const outcome: BulkOutcome = { changed: [], unchanged: [], skipped: [] };
  for (const city of cities) {
    let plan: RolloutPlan;
    try {
      plan = planRollout(city, change, now);
    } catch (err) {
      outcome.skipped.push({ slug: city.slug, reason: err instanceof ApiError ? err.message : String(err) });
      continue;
    }
    if (!plan.changed) {
      outcome.unchanged.push(city.slug);
      continue;
    }
    await applyPlan(city, plan, change.note, byUserId);
    outcome.changed.push({ slug: city.slug, from: city.stage, to: plan.stage });
  }
  return outcome;
}

export type NewManualCity = {
  name: string;
  stateCode: string;
  districtCode?: string | undefined;
  lat: number;
  lng: number;
  aliases?: string[] | undefined;
  population?: number | undefined;
  kind?: CityKind | undefined;
};

/**
 * A place the dataset lacks, added by hand — `source` MANUAL, PLANNED like
 * every other new row. The slug is the name, then `name-state`; a name
 * already under the state is a 409.
 */
export async function addCity(input: NewManualCity): Promise<GeoCityRow> {
  const state = await repository.findStateByCode(input.stateCode);
  if (!state) throw new ApiError(404, 'NOT_FOUND', 'No such state');
  let districtId: string | null = null;
  if (input.districtCode) {
    const district = (await repository.listDistricts(state.id)).find((d) => d.code === input.districtCode) ?? null;
    if (!district) throw new ApiError(404, 'NOT_FOUND', 'No such district in that state');
    districtId = district.id;
  }
  const base = slugify(input.name);
  if (!base) throw new ApiError(400, 'VALIDATION_ERROR', 'That name has no letters or digits to make a slug from');
  const stateSlug = slugify(state.name);
  const existing = await repository.findCitiesBySlugs([base, `${base}-${stateSlug}`]);
  const slug = existing.some((c) => c.slug === base) ? `${base}-${stateSlug}` : base;
  if (existing.some((c) => c.slug === slug)) {
    throw new ApiError(409, 'CONFLICT', `${input.name} is already in the catalogue under ${state.name}`, { slug });
  }
  const own = new Set([slug, base]);
  await repository.createCities([
    {
      slug,
      name: input.name.trim(),
      state: state.name,
      aliases: [...new Set((input.aliases ?? []).map(slugify).filter((a) => a && !own.has(a)))],
      isActive: false,
      stateId: state.id,
      districtId,
      latitude: input.lat,
      longitude: input.lng,
      population: input.population ?? null,
      kind: input.kind ?? 'TOWN',
      geonameId: null,
      source: 'MANUAL',
      stage: 'PLANNED',
      switches: { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false },
    },
  ]);
  return requireCity(slug);
}

/** `POST /geo/seed`: the same run as `npm run seed:geo`, over this module's repository. */
export async function seedCatalogue(dataset: GeoDataset, overrides?: GeoOverrides): Promise<GeoSeedSummary> {
  return runGeoSeed(dataset, repository, overrides);
}

/* ── the app's reads ───────────────────────────────────────────── */

export type PickerCity = {
  slug: string;
  name: string;
  state: string | null;
  stage: CityStageValue;
  latitude: number | null;
  longitude: number | null;
  distanceM: number | null;
  comingSoon: boolean;
};

const toPicker = (city: GeoCityRow, near: { latitude: number; longitude: number } | null): PickerCity => ({
  slug: city.slug,
  name: city.name,
  state: city.geoState?.name ?? city.state,
  stage: city.stage,
  latitude: city.latitude,
  longitude: city.longitude,
  distanceM:
    near && city.latitude !== null && city.longitude !== null ? Math.round(haversineMeters(near.latitude, near.longitude, city.latitude, city.longitude)) : null,
  comingSoon: city.stage !== 'LAUNCHED',
});

/**
 * The pickers. `items` are the cities at the stages asked for (LAUNCHED by
 * default); `comingSoon` — with `geo.comingSoonWaitlist` on — is the
 * SEEDING cities and the PLANNED state capitals, for the advertiser
 * waitlist. Nearest first when the phone sends its position, biggest
 * first otherwise.
 */
export async function pickerCities(input: { stages: readonly CityStageValue[]; q?: string | undefined; near: { latitude: number; longitude: number } | null; limit: number }) {
  const settings = (await getPlatformSettings()).geo;
  const [items, soon] = await Promise.all([
    repository.pickerCities({ stages: input.stages, plannedCapitals: false, q: input.q, limit: input.limit }),
    settings.comingSoonWaitlist ? repository.pickerCities({ stages: ['SEEDING'], plannedCapitals: true, q: input.q, limit: input.limit }) : Promise.resolve([]),
  ]);
  const wanted = new Set(input.stages);
  const byDistance = (a: PickerCity, b: PickerCity) => (a.distanceM ?? Number.MAX_SAFE_INTEGER) - (b.distanceM ?? Number.MAX_SAFE_INTEGER);
  const picked = items.map((city) => toPicker(city, input.near));
  const comingSoon = soon.filter((city) => !wanted.has(city.stage)).map((city) => toPicker(city, input.near));
  if (input.near) {
    picked.sort(byDistance);
    comingSoon.sort(byDistance);
  }
  return { items: picked, comingSoon };
}

/* ── Lot X-L: the city key backfill from the console ─────────────── */

/** The report `POST /geo/backfill-city-keys` answers: one row per keyed table. */
export type CityKeyBackfillReport = { tables: { table: CityKeyedTable; resolved: number; stillNull: number }[] };

export const CITY_KEY_BACKFILL_LOCK_KEY = 'geo:city-keys:backfill';
/** Long enough for eight `updateMany`s over a few thousand distinct strings; a process that dies mid-run frees it on its own. */
export const CITY_KEY_BACKFILL_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * The same run as `npm run backfill:city-keys` — `pricing.backfillCityKeys`
 * re-resolving every null key — from the console, one at a time. Two ops
 * clicking together would otherwise both fold the same strings (harmless,
 * but the second report would count nothing and read as a failure); the
 * second is answered 409 instead. The lock is advisory — a Redis `SET NX`
 * with a TTL — and Redis being down fails the run loudly rather than
 * letting it run unguarded.
 */
export async function backfillCityKeysLocked(): Promise<CityKeyBackfillReport> {
  const acquired = await redis.set(CITY_KEY_BACKFILL_LOCK_KEY, '1', 'PX', CITY_KEY_BACKFILL_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    throw new ApiError(409, 'CONFLICT', 'A city key backfill is already running. Wait for it to finish and reload.');
  }
  try {
    const result = await backfillCityKeys();
    return { tables: CITY_KEYED_TABLES.map((table) => ({ table, ...result[table] })) };
  } finally {
    await redis.del(CITY_KEY_BACKFILL_LOCK_KEY).catch((err: unknown) => logger.warn('City key backfill lock not released; it expires on its own', { err }));
  }
}
