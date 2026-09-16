import { z } from 'zod';
import { slugify } from '../pricing';
import type { CityKey, GeoCityPatch, GeoRepository, NewGeoCity, NewGeoDistrict, NewGeoState } from './geo.repository';
import { CITY_KINDS } from './geo.repository';
import { DEFAULT_SWITCHES, mirrorOf } from './rollout.rules';

/**
 * The country catalogue — Lot V (the owner, 15 Sep 2026).
 *
 * `data/geo/india-geo.json` is GeoNames' India dump (CC BY 4.0) cut to the
 * populated places of 5,000 people or more, under their admin2 district and
 * admin1 state: 36 states, 763 districts, ~6,500 towns. This turns it into
 * rows — idempotently, in chunks, never one round trip per row — and the
 * console's rollout does the rest.
 *
 * Three rules the seed keeps:
 *
 *  1. **The 44 Lot A cities are matched, not duplicated.** A `City` with no
 *     `geonameId` is matched by normalised name or alias against the
 *     dataset (the state breaks a tie — India has four Raipurs) and gains
 *     the GeoNames id, the state and district, the point, the population and
 *     the kind. Its slug, stage, switches and `source` (`SEED`) stay as they
 *     are, so the launched cities stay launched. A seed city the dataset
 *     lacks (Navi Mumbai) is reported and left alone.
 *  2. **Every other place is created PLANNED**, `source` `GEONAMES`,
 *     `isActive` false, all six switches off — in the catalogue, nothing
 *     on. The slug is the name, then `name-state`, then `name-state-district`,
 *     then `name-<geonameId>` when India has that many; the biggest place
 *     takes the bare slug.
 *  3. **A second run changes nothing.** Rows are matched by `geonameId`
 *     first; a row whose dataset columns already agree is not written.
 *     Aliases are the union of what the row has and what the dataset says,
 *     so an alias ops added by hand survives a refresh.
 *  4. **W-B: the overrides file places what the dataset lacks.**
 *     `data/geo/seed-overrides.json`, read after the dataset and matched by
 *     slug — Navi Mumbai's state, district and point come from there.
 */

const point = z.number().min(-180).max(180);

export const datasetStateSchema = z.object({
  code: z.string().trim().min(1).max(8),
  name: z.string().trim().min(1).max(120),
  geonameId: z.number().int().positive().nullable().optional(),
  lat: point.nullable().optional(),
  lng: point.nullable().optional(),
});

export const datasetDistrictSchema = z.object({
  stateCode: z.string().trim().min(1).max(8),
  code: z.string().trim().min(1).max(16),
  name: z.string().trim().min(1).max(120),
  geonameId: z.number().int().positive().nullable().optional(),
  lat: point.nullable().optional(),
  lng: point.nullable().optional(),
});

export const datasetCitySchema = z.object({
  geonameId: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  stateCode: z.string().trim().min(1).max(8),
  districtCode: z.string().trim().min(1).max(16).nullable().optional(),
  lat: point,
  lng: point,
  population: z.number().int().min(0).nullable().optional(),
  kind: z.enum(CITY_KINDS),
});

export const geoDatasetSchema = z.object({
  source: z.string().min(1),
  generatedOn: z.string().min(1),
  states: z.array(datasetStateSchema).min(1),
  districts: z.array(datasetDistrictSchema),
  cities: z.array(datasetCitySchema).min(1),
});

export type GeoDataset = z.infer<typeof geoDatasetSchema>;
export type DatasetCity = z.infer<typeof datasetCitySchema>;

/**
 * W-B: `data/geo/seed-overrides.json` — the places the dataset lacks but the
 * catalogue must place (Navi Mumbai: GeoNames files it under Mumbai). Read
 * after the dataset; each row is matched **by slug** to an existing city and
 * gives it its state, district, point, population, kind and aliases — never
 * its slug, stage, switches or `source`. A slug the table lacks is created
 * PLANNED, `source` SEED. Idempotent like the rest: a row whose columns
 * already agree is not written.
 */
export const overrideCitySchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a slug is lower-case, hyphenated'),
  name: z.string().trim().min(1).max(120),
  stateCode: z.string().trim().min(1).max(8),
  districtCode: z.string().trim().min(1).max(16).nullable().optional(),
  lat: point,
  lng: point,
  population: z.number().int().min(0).nullable().optional(),
  kind: z.enum(CITY_KINDS).optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
});
export const geoOverridesSchema = z.object({ cities: z.array(overrideCitySchema).max(500).default([]) });
export type GeoOverrides = z.infer<typeof geoOverridesSchema>;
export const EMPTY_OVERRIDES: GeoOverrides = { cities: [] };

export type GeoSeedSummary = {
  states: { created: number; updated: number; total: number };
  districts: { created: number; updated: number; total: number };
  cities: {
    created: number;
    /** Existing rows without a GeoNames id that this run attached one to. */
    matched: number;
    /** Rows already carrying a GeoNames id whose dataset columns moved. */
    updated: number;
    unchanged: number;
    /** Seed rows neither the dataset nor the overrides file has a place for — left as they are. */
    unmatchedSeed: string[];
    /** W-B: the slugs the overrides file placed (written this run or already agreeing). */
    overridden: string[];
    total: number;
  };
  source: string;
  generatedOn: string;
};

/**
 * GeoNames writes "State of Mahārāshtra" and "Union Territory of Chandigarh";
 * a screen wants "Maharashtra". The diacritics go too, for the slug and for
 * the console — GeoNames' city names are already plain ASCII, the admin
 * names are not.
 */
export function cleanPlaceName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(?:State of|Union Territory of|National Capital Territory of)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CHUNK = 500;

function chunks<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The aliases a row keeps: what it has, plus the dataset's, slugified, never its own slug or name. */
function mergedAliases(existing: readonly string[], dataset: readonly string[], slug: string, name: string): string[] {
  const own = new Set([slug, slugify(name)]);
  const out = new Set<string>();
  for (const alias of [...existing, ...dataset]) {
    const key = slugify(alias);
    if (key && !own.has(key)) out.add(key);
  }
  return [...out];
}

type Candidate = { city: DatasetCity; stateName: string };

/**
 * The dataset place a seed row means. Exact name first, then a name the
 * seed lists as an alias, then a dataset alias; within a rank the seed's
 * own state wins, then the bigger place. Null when nothing shares a
 * spelling — the seed row is reported, never guessed.
 */
export function matchSeedRow(row: CityKey, bySpelling: Map<string, Candidate[]>, taken: Set<number>): DatasetCity | null {
  const own = new Set([row.slug, slugify(row.name), ...row.aliases.map(slugify)].filter(Boolean));
  const seedState = row.state ? slugify(cleanPlaceName(row.state)) : null;
  const seen = new Set<number>();
  const scored: { city: DatasetCity; score: number }[] = [];
  for (const spelling of own) {
    for (const candidate of bySpelling.get(spelling) ?? []) {
      if (seen.has(candidate.city.geonameId) || taken.has(candidate.city.geonameId)) continue;
      seen.add(candidate.city.geonameId);
      const nameKey = slugify(candidate.city.name);
      const rank = nameKey === row.slug || nameKey === slugify(row.name) ? 300 : own.has(nameKey) ? 200 : 100;
      const stateBonus = seedState && slugify(candidate.stateName) === seedState ? 50 : 0;
      scored.push({ city: candidate.city, score: rank + stateBonus });
    }
  }
  scored.sort((a, b) => b.score - a.score || (b.city.population ?? 0) - (a.city.population ?? 0));
  return scored[0]?.city ?? null;
}

/**
 * Runs the whole seed against a repository. Pure over the repository
 * interface so the in-memory one pins idempotence and the match without a
 * database; the script and `POST /geo/seed` hand it the Prisma one.
 */
export async function runGeoSeed(dataset: GeoDataset, repo: GeoRepository, overrides: GeoOverrides = EMPTY_OVERRIDES): Promise<GeoSeedSummary> {
  /* ── states ─────────────────────────────────────────────────── */
  const stateRows: NewGeoState[] = dataset.states.map((s) => ({
    code: s.code,
    name: cleanPlaceName(s.name),
    latitude: s.lat ?? null,
    longitude: s.lng ?? null,
    geonameId: s.geonameId ?? null,
  }));
  const existingStates = new Map((await repo.listStates()).map((s) => [s.code, s]));
  const statesCreated = await repo.createStates(stateRows.filter((s) => !existingStates.has(s.code)));
  let statesUpdated = 0;
  for (const row of stateRows) {
    const current = existingStates.get(row.code);
    if (!current) continue;
    const patch: Partial<NewGeoState> = {};
    for (const key of ['name', 'latitude', 'longitude', 'geonameId'] as const) {
      if (!same(current[key], row[key])) (patch as Record<string, unknown>)[key] = row[key];
    }
    if (Object.keys(patch).length > 0) {
      await repo.updateState(current.id, patch);
      statesUpdated += 1;
    }
  }
  const stateIdByCode = new Map((await repo.listStates()).map((s) => [s.code, s.id]));
  const stateNameByCode = new Map(stateRows.map((s) => [s.code, s.name]));

  /* ── districts ──────────────────────────────────────────────── */
  const districtRows: (NewGeoDistrict & { stateCode: string })[] = [];
  for (const d of dataset.districts) {
    const stateId = stateIdByCode.get(d.stateCode);
    if (!stateId) continue;
    districtRows.push({
      stateCode: d.stateCode,
      stateId,
      code: d.code,
      name: cleanPlaceName(d.name),
      latitude: d.lat ?? null,
      longitude: d.lng ?? null,
      geonameId: d.geonameId ?? null,
    });
  }
  const districtKey = (stateId: string, code: string) => `${stateId}:${code}`;
  const existingDistricts = new Map((await repo.listDistricts()).map((d) => [districtKey(d.stateId, d.code), d]));
  let districtsCreated = 0;
  for (const chunk of chunks(districtRows.filter((d) => !existingDistricts.has(districtKey(d.stateId, d.code))))) {
    districtsCreated += await repo.createDistricts(chunk.map(({ stateCode: _s, ...row }) => row));
  }
  let districtsUpdated = 0;
  for (const row of districtRows) {
    const current = existingDistricts.get(districtKey(row.stateId, row.code));
    if (!current) continue;
    const patch: Partial<NewGeoDistrict> = {};
    for (const key of ['name', 'latitude', 'longitude', 'geonameId'] as const) {
      if (!same(current[key], row[key])) (patch as Record<string, unknown>)[key] = row[key];
    }
    if (Object.keys(patch).length > 0) {
      await repo.updateDistrict(current.id, patch);
      districtsUpdated += 1;
    }
  }
  const districtIdByKey = new Map((await repo.listDistricts()).map((d) => [districtKey(d.stateId, d.code), d.id]));

  /* ── cities ─────────────────────────────────────────────────── */
  const keys = await repo.listCityKeys();
  const byGeoname = new Map<number, CityKey>();
  const takenSlugs = new Set<string>();
  for (const row of keys) {
    takenSlugs.add(row.slug);
    if (row.geonameId !== null) byGeoname.set(row.geonameId, row);
  }

  // The spelling index over the dataset, for the seed rows without an id.
  const bySpelling = new Map<string, Candidate[]>();
  for (const city of dataset.cities) {
    const stateName = stateNameByCode.get(city.stateCode) ?? '';
    for (const spelling of new Set([slugify(city.name), ...city.aliases.map(slugify)])) {
      if (!spelling) continue;
      const list = bySpelling.get(spelling) ?? [];
      list.push({ city, stateName });
      bySpelling.set(spelling, list);
    }
  }

  const placeOf = (city: DatasetCity) => {
    const stateId = stateIdByCode.get(city.stateCode) ?? null;
    const districtId = stateId && city.districtCode ? (districtIdByKey.get(districtKey(stateId, city.districtCode)) ?? null) : null;
    return {
      stateId,
      districtId,
      latitude: city.lat,
      longitude: city.lng,
      population: city.population ?? null,
      kind: city.kind,
      state: stateNameByCode.get(city.stateCode) ?? null,
    };
  };

  const districtNameByCode = new Map(dataset.districts.map((d) => [`${d.stateCode}:${d.code}`, cleanPlaceName(d.name)]));

  const updates: { id: string; patch: GeoCityPatch }[] = [];
  let matched = 0;
  let updated = 0;
  let unchanged = 0;

  // Pass 1: the seed rows without an id, matched by spelling.
  const attached = new Set<number>(byGeoname.keys());
  const unmatchedSeed: string[] = [];
  for (const row of keys) {
    if (row.geonameId !== null || row.source !== 'SEED') continue;
    const hit = matchSeedRow(row, bySpelling, attached);
    if (!hit) {
      unmatchedSeed.push(row.slug);
      continue;
    }
    attached.add(hit.geonameId);
    byGeoname.set(hit.geonameId, row);
    const place = placeOf(hit);
    updates.push({
      id: row.id,
      patch: {
        geonameId: hit.geonameId,
        stateId: place.stateId,
        districtId: place.districtId,
        latitude: place.latitude,
        longitude: place.longitude,
        population: place.population,
        kind: place.kind,
        // The Lot A seed's free-text state stays where it was typed; only a blank is filled.
        ...(row.state ? {} : { state: place.state }),
        aliases: mergedAliases(row.aliases, hit.aliases, row.slug, row.name),
      },
    });
    matched += 1;
  }

  // W-B: the overrides — a seed row the dataset lacks, placed by slug.
  const creates: NewGeoCity[] = [];
  const bySlug = new Map(keys.map((row) => [row.slug, row]));
  const overridden: string[] = [];
  for (const over of overrides.cities) {
    const stateId = stateIdByCode.get(over.stateCode);
    if (!stateId) throw new Error(`seed-overrides: ${over.slug} names state ${over.stateCode}, which the dataset lacks`);
    const districtId = over.districtCode ? (districtIdByKey.get(districtKey(stateId, over.districtCode)) ?? null) : null;
    if (over.districtCode && !districtId) throw new Error(`seed-overrides: ${over.slug} names district ${over.districtCode} in state ${over.stateCode}, which the dataset lacks`);
    const place = {
      stateId,
      districtId,
      latitude: over.lat,
      longitude: over.lng,
      population: over.population ?? null,
      kind: over.kind ?? 'TOWN',
      state: stateNameByCode.get(over.stateCode) ?? null,
    } as const;
    const current = bySlug.get(over.slug);
    overridden.push(over.slug);
    if (current) {
      const aliases = mergedAliases(current.aliases, over.aliases, current.slug, current.name);
      const patch: GeoCityPatch = {};
      if (!same(current.stateId, place.stateId)) patch.stateId = place.stateId;
      if (!same(current.districtId, place.districtId)) patch.districtId = place.districtId;
      if (!same(current.latitude, place.latitude)) patch.latitude = place.latitude;
      if (!same(current.longitude, place.longitude)) patch.longitude = place.longitude;
      if (!same(current.population, place.population)) patch.population = place.population;
      if (!same(current.kind, place.kind)) patch.kind = place.kind;
      if (!current.state && place.state) patch.state = place.state;
      if (!same([...current.aliases].sort(), [...aliases].sort())) patch.aliases = aliases;
      if (Object.keys(patch).length > 0) updates.push({ id: current.id, patch });
      continue;
    }
    takenSlugs.add(over.slug);
    creates.push({
      slug: over.slug,
      name: over.name,
      state: place.state,
      aliases: mergedAliases([], over.aliases, over.slug, over.name),
      isActive: mirrorOf('PLANNED'),
      stateId: place.stateId,
      districtId: place.districtId,
      latitude: place.latitude,
      longitude: place.longitude,
      population: place.population,
      kind: place.kind,
      geonameId: null,
      source: 'SEED',
      stage: 'PLANNED',
      switches: { ...DEFAULT_SWITCHES.PLANNED },
    });
  }
  const placed = new Set(overridden);
  const unmatched = unmatchedSeed.filter((slug) => !placed.has(slug));

  // Pass 2: every dataset place — refreshed where it exists, created where it does not.
  const ordered = [...dataset.cities].sort((a, b) => (b.population ?? 0) - (a.population ?? 0) || a.geonameId - b.geonameId);
  for (const city of ordered) {
    const current = byGeoname.get(city.geonameId);
    const place = placeOf(city);
    if (current) {
      if (current.source === 'SEED' && current.geonameId === null) continue; // patched in pass 1
      const aliases = mergedAliases(current.aliases, city.aliases, current.slug, current.name);
      const patch: GeoCityPatch = {};
      if (!same(current.stateId, place.stateId)) patch.stateId = place.stateId;
      if (!same(current.districtId, place.districtId)) patch.districtId = place.districtId;
      if (!same(current.latitude, place.latitude)) patch.latitude = place.latitude;
      if (!same(current.longitude, place.longitude)) patch.longitude = place.longitude;
      if (!same(current.population, place.population)) patch.population = place.population;
      if (!same(current.kind, place.kind)) patch.kind = place.kind;
      if (!current.state && place.state) patch.state = place.state;
      if (!same([...current.aliases].sort(), [...aliases].sort())) patch.aliases = aliases;
      if (Object.keys(patch).length > 0) {
        updates.push({ id: current.id, patch });
        updated += 1;
      } else {
        unchanged += 1;
      }
      continue;
    }
    const base = slugify(city.name) || `place-${city.geonameId}`;
    const stateSlug = slugify(place.state ?? '');
    const districtName = city.districtCode ? districtNameByCode.get(`${city.stateCode}:${city.districtCode}`) : undefined;
    const districtSlug = districtName ? slugify(districtName) : '';
    const options = [base, stateSlug && `${base}-${stateSlug}`, stateSlug && districtSlug && `${base}-${stateSlug}-${districtSlug}`, `${base}-${city.geonameId}`].filter(
      (s): s is string => Boolean(s),
    );
    const slug = options.find((s) => !takenSlugs.has(s)) ?? `${base}-${city.geonameId}`;
    takenSlugs.add(slug);
    creates.push({
      slug,
      name: city.name,
      state: place.state,
      aliases: mergedAliases([], city.aliases, slug, city.name),
      isActive: mirrorOf('PLANNED'),
      stateId: place.stateId,
      districtId: place.districtId,
      latitude: place.latitude,
      longitude: place.longitude,
      population: place.population,
      kind: place.kind,
      geonameId: city.geonameId,
      source: 'GEONAMES',
      stage: 'PLANNED',
      switches: { ...DEFAULT_SWITCHES.PLANNED },
    });
  }

  let created = 0;
  for (const chunk of chunks(creates)) created += await repo.createCities(chunk);
  for (const chunk of chunks(updates, 200)) await repo.updateCities(chunk);

  return {
    states: { created: statesCreated, updated: statesUpdated, total: stateIdByCode.size },
    districts: { created: districtsCreated, updated: districtsUpdated, total: districtIdByKey.size },
    cities: { created, matched, updated, unchanged, unmatchedSeed: unmatched, overridden, total: keys.length + created },
    source: dataset.source,
    generatedOn: dataset.generatedOn,
  };
}
