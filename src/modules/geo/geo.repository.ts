import type { CityStageValue, CitySwitches } from '../pricing';

/**
 * The geography catalogue and the rollout — Lot V.
 *
 * `City` is still `pricing`'s table: the resolver lives there and every
 * gated module already imports it. This module is the catalogue's editor
 * and the stage machine's owner, so it reads and writes the same table
 * through its own repository — the rollout columns, the state and district
 * relations, the events — and reads, never writes, the party tables for
 * the per-city counts the console prints. Nothing here is imported by
 * `pricing`; `geo` sits above it (see the README).
 */

export const CITY_KINDS = ['NATIONAL_CAPITAL', 'STATE_CAPITAL', 'DISTRICT_HQ', 'SUBDISTRICT_HQ', 'TOWN'] as const;
export type CityKind = (typeof CITY_KINDS)[number];
export const CITY_SOURCES = ['SEED', 'GEONAMES', 'MANUAL'] as const;
export type CitySource = (typeof CITY_SOURCES)[number];

export type GeoStateRow = {
  id: string;
  /** GeoNames admin1 code — "19" is Karnataka. */
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geonameId: number | null;
};

export type GeoDistrictRow = {
  id: string;
  stateId: string;
  /** GeoNames admin2 code, unique within the state. */
  code: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geonameId: number | null;
};

export type NewGeoState = Omit<GeoStateRow, 'id'>;
export type NewGeoDistrict = Omit<GeoDistrictRow, 'id'>;

/** A city as the catalogue holds it: the resolver's columns, the place, the rollout. */
export type GeoCityRow = {
  id: string;
  slug: string;
  name: string;
  /** The free-text state the Lot A seed carried; the catalogue relation is `geoState`. */
  state: string | null;
  aliases: string[];
  isActive: boolean;
  stateId: string | null;
  districtId: string | null;
  latitude: number | null;
  longitude: number | null;
  population: number | null;
  kind: CityKind | null;
  geonameId: number | null;
  source: CitySource;
  stage: CityStageValue;
  switches: CitySwitches;
  launchedAt: Date | null;
  pausedAt: Date | null;
  withdrawnAt: Date | null;
  rolloutNote: string | null;
  geoState: { code: string; name: string } | null;
  geoDistrict: { code: string; name: string } | null;
};

/** The columns the seed matches and refreshes on — every city, one query. */
export type CityKey = Pick<
  GeoCityRow,
  'id' | 'slug' | 'name' | 'state' | 'aliases' | 'stateId' | 'districtId' | 'latitude' | 'longitude' | 'population' | 'kind' | 'geonameId' | 'source'
>;

export type NewGeoCity = {
  slug: string;
  name: string;
  state: string | null;
  aliases: string[];
  isActive: boolean;
  stateId: string | null;
  districtId: string | null;
  latitude: number | null;
  longitude: number | null;
  population: number | null;
  kind: CityKind | null;
  geonameId: number | null;
  source: CitySource;
  stage: CityStageValue;
  switches: CitySwitches;
};

export type GeoCityPatch = Partial<
  Omit<NewGeoCity, 'slug'> & {
    launchedAt: Date | null;
    pausedAt: Date | null;
    withdrawnAt: Date | null;
    rolloutNote: string | null;
  }
>;

export type RolloutEventRow = {
  id: string;
  cityId: string;
  fromStage: CityStageValue;
  toStage: CityStageValue;
  flags: unknown;
  byUserId: string;
  note: string | null;
  at: Date;
};

export type NewRolloutEvent = Omit<RolloutEventRow, 'id' | 'at'> & { flags: Record<string, unknown>; at?: Date | undefined };

export type StageCounts = Record<CityStageValue, number>;

export type CityListFilter = {
  stateId?: string | undefined;
  districtId?: string | undefined;
  stage?: readonly CityStageValue[] | undefined;
  q?: string | undefined;
  kind?: readonly CityKind[] | undefined;
  minPopulation?: number | undefined;
  sort: 'population' | 'name';
  page: number;
  pageSize: number;
};

export type MapBounds = { minLat: number; minLng: number; maxLat: number; maxLng: number };

export type MapPoint = Pick<GeoCityRow, 'id' | 'slug' | 'name' | 'stage' | 'latitude' | 'longitude' | 'population' | 'kind'>;

/** The per-city figures the console prints beside the stage. */
export type CityCounts = {
  publishers: number;
  listingsLive: number;
  listingsTotal: number;
  advertisers: number;
  agents: number;
  printPartners: number;
  openLeads: number;
};

/** A live listing the wind-down takes down, with the publisher to tell. */
export type LiveListingRef = { id: string; title: string; publisherUserId: string | null };

/** Y-B: a live listing's place, for the city audience profile — the spots whose snapshots are folded and the box the sample grid spans. */
export type ListingPoint = { id: string; latitude: number | null; longitude: number | null };

/**
 * Lot X-B: how a city is matched against the party tables — by the key
 * the rows carry (`cityId`, stamped on every write since Lot X-B), with
 * the city's spellings (name, slug, aliases, case-insensitively) as the
 * fallback for the rows whose key is null, so a typed town is still found.
 */
export type CityMatch = { cityId: string; spellings: string[] };

export interface GeoRepository {
  /* ── states and districts ─────────────────────────────────────── */
  listStates(): Promise<GeoStateRow[]>;
  findStateByCode(code: string): Promise<GeoStateRow | null>;
  /** `createMany` with `skipDuplicates` on `code`; answers how many were new. */
  createStates(rows: NewGeoState[]): Promise<number>;
  updateState(id: string, patch: Partial<NewGeoState>): Promise<void>;
  listDistricts(stateId?: string): Promise<GeoDistrictRow[]>;
  findDistrict(id: string): Promise<GeoDistrictRow | null>;
  /** `createMany` with `skipDuplicates` on `(stateId, code)`. */
  createDistricts(rows: NewGeoDistrict[]): Promise<number>;
  updateDistrict(id: string, patch: Partial<NewGeoDistrict>): Promise<void>;

  /* ── cities ───────────────────────────────────────────────────── */
  /** Every city's matching columns — the seed's one read of the table. */
  listCityKeys(): Promise<CityKey[]>;
  /** `createMany` with `skipDuplicates` on `slug` and `geonameId`, in the caller's chunks. */
  createCities(rows: NewGeoCity[]): Promise<number>;
  updateCity(id: string, patch: GeoCityPatch): Promise<GeoCityRow>;
  /** Many rows, each its own patch, in one transaction per call. */
  updateCities(updates: { id: string; patch: GeoCityPatch }[]): Promise<number>;
  findCityBySlug(slug: string): Promise<GeoCityRow | null>;
  findCitiesBySlugs(slugs: string[]): Promise<GeoCityRow[]>;
  findCitiesIn(scope: { stateId?: string; districtId?: string }): Promise<GeoCityRow[]>;
  listCities(filter: CityListFilter): Promise<{ items: GeoCityRow[]; total: number; counts: StageCounts }>;
  stageCounts(): Promise<StageCounts>;
  stageCountsByState(): Promise<{ stateId: string; stage: CityStageValue; count: number }[]>;
  stageCountsByDistrict(stateId: string): Promise<{ districtId: string; stage: CityStageValue; count: number }[]>;
  mapPoints(bounds: MapBounds | null, stages: readonly CityStageValue[] | null): Promise<MapPoint[]>;
  /** The app's pickers: cities at these stages (or PLANNED capitals), a name prefix, by population. */
  pickerCities(input: { stages: readonly CityStageValue[]; plannedCapitals: boolean; q?: string | undefined; limit: number }): Promise<GeoCityRow[]>;

  /* ── events ───────────────────────────────────────────────────── */
  createRolloutEvents(events: NewRolloutEvent[]): Promise<number>;
  listRolloutEvents(cityId: string, limit: number): Promise<RolloutEventRow[]>;
  /** WITHDRAWN cities, each with the instant of its last wind-down marker (or null). */
  withdrawnCities(): Promise<{ city: GeoCityRow; woundDownAt: Date | null }[]>;

  /* ── read-only aggregates over other modules' tables ──────────── */
  /** The seven counts, by key with the spellings as the fallback (Lot X-B). */
  cityCounts(city: CityMatch): Promise<CityCounts>;
  /** Live listings per city — two grouped queries for the map (by key, then by spelling for the null keys). Keyed by city id. */
  liveListingsByCity(cities: CityMatch[]): Promise<Map<string, number>>;
  /** A rate card ACTIVE and in force on `on` — the city's own, or a national one (`cityId` null). */
  rateCardInForce(cityId: string, on: Date): Promise<{ cardId: string; name: string; national: boolean } | null>;
  /** ACTIVE agents in the city, by side. */
  activeAgentsBySide(city: CityMatch): Promise<{ publisher: number; advertiser: number }>;
  activePrintPartners(city: CityMatch): Promise<number>;
  /** Whether the pricing vocabulary has any live media type at all. */
  vocabularyPresent(): Promise<boolean>;
  activeListings(city: CityMatch): Promise<LiveListingRef[]>;
  /** Y-B: the live listings in the city with their coordinates (null where the spot has none yet). */
  listingPoints(city: CityMatch): Promise<ListingPoint[]>;
  /** User ids of the ACTIVE agents in the city — by key, or typed under one of its spellings. */
  agentUserIds(city: CityMatch): Promise<string[]>;
}
