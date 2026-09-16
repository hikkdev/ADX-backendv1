import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GeoCityRow } from '../geo.repository';
import { cleanPlaceName, geoDatasetSchema, geoOverridesSchema, runGeoSeed, type GeoDataset } from '../seed.service';
import { InMemoryGeoRepository } from './in-memory-geo.repository';

/**
 * The country catalogue's seed — Lot V.
 *
 * Pinned on a fixture cut of the dataset: the 44 Lot A rows are matched by
 * name or alias (with the state breaking a tie) and keep their slug, stage
 * and switches; every other place lands PLANNED with the switches off and
 * a slug that survives India's many Rampurs; a second run writes nothing.
 * Then the real `data/geo/india-geo.json` through the same planner: its
 * shape, every slug unique, and the whole file under the one-minute
 * budget's worth of round trips.
 */

const ON = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
const OFF = { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false };

const FIXTURE: GeoDataset = geoDatasetSchema.parse({
  source: 'GeoNames (fixture)',
  generatedOn: '2026-09-15',
  states: [
    { code: '19', name: 'State of Karnataka', geonameId: 1267701, lat: 14.75, lng: 76 },
    { code: '37', name: 'State of Chhattīsgarh', geonameId: 1444365, lat: 22, lng: 82 },
    { code: '39', name: 'State of Uttarākhand', geonameId: 1444366, lat: 30, lng: 79.5 },
    { code: '16', name: 'State of Mahārāshtra', geonameId: 1264418, lat: 19.5, lng: 76 },
  ],
  districts: [
    { stateCode: '19', code: '583', name: 'Bengaluru Urban', geonameId: 1277332, lat: 13, lng: 77.6 },
    { stateCode: '19', code: '594', name: 'Mysuru', geonameId: 1262320, lat: 12.3, lng: 76.6 },
    { stateCode: '37', code: '716', name: 'Raipur', geonameId: 1258979, lat: 21.2, lng: 81.6 },
    { stateCode: '39', code: '773', name: 'Dehradun', geonameId: 1273312, lat: 30.3, lng: 78 },
  ],
  cities: [
    { geonameId: 1277333, name: 'Bengaluru', aliases: ['Bangalore', 'BLR'], stateCode: '19', districtCode: '583', lat: 12.97, lng: 77.59, population: 8_495_492, kind: 'STATE_CAPITAL' },
    { geonameId: 1262321, name: 'Mysuru', aliases: ['Mysore'], stateCode: '19', districtCode: '594', lat: 12.3, lng: 76.65, population: 920_550, kind: 'DISTRICT_HQ' },
    { geonameId: 1258980, name: 'Raipur', aliases: [], stateCode: '37', districtCode: '716', lat: 21.23, lng: 81.63, population: 1_027_264, kind: 'STATE_CAPITAL' },
    { geonameId: 1258981, name: 'Raipur', aliases: [], stateCode: '39', districtCode: '773', lat: 30.31, lng: 78.08, population: 27_702, kind: 'TOWN' },
    { geonameId: 1258982, name: 'Raipur', aliases: [], stateCode: '39', districtCode: null, lat: 30.5, lng: 78.2, population: 6_000, kind: 'TOWN' },
    { geonameId: 1258983, name: 'Raipur', aliases: [], stateCode: '39', districtCode: '773', lat: 30.6, lng: 78.3, population: 5_500, kind: 'TOWN' },
    { geonameId: 1275339, name: 'Mumbai', aliases: ['Bombay', 'BOM'], stateCode: '16', districtCode: null, lat: 19.07, lng: 72.88, population: 12_691_836, kind: 'STATE_CAPITAL' },
    { geonameId: 1264000, name: 'Ramanagara', aliases: [], stateCode: '19', districtCode: '583', lat: 12.72, lng: 77.28, population: 95_000, kind: 'TOWN' },
  ],
});

/** The Lot A rows as the backfill left them on Neon: LAUNCHED, all six on, no GeoNames id. */
function seedRow(repo: InMemoryGeoRepository, slug: string, name: string, state: string, aliases: string[]): void {
  repo.cities.push({
    id: `seed_${slug}`,
    slug,
    name,
    state,
    aliases,
    isActive: true,
    stateId: null,
    districtId: null,
    latitude: null,
    longitude: null,
    population: null,
    kind: null,
    geonameId: null,
    source: 'SEED',
    stage: 'LAUNCHED',
    switches: { ...ON },
    launchedAt: new Date('2026-09-15T00:00:00Z'),
    pausedAt: null,
    withdrawnAt: null,
    rolloutNote: null,
    geoState: null,
    geoDistrict: null,
  } satisfies GeoCityRow);
}

function seededRepo(): InMemoryGeoRepository {
  const repo = new InMemoryGeoRepository();
  seedRow(repo, 'bengaluru', 'Bengaluru', 'Karnataka', ['bangalore', 'bengaluru-urban']);
  seedRow(repo, 'mysuru', 'Mysuru', 'Karnataka', ['mysore']);
  seedRow(repo, 'raipur', 'Raipur', 'Chhattisgarh', []);
  seedRow(repo, 'navi-mumbai', 'Navi Mumbai', 'Maharashtra', ['new-bombay']);
  return repo;
}

describe('the seed over the fixture', () => {
  it('creates the states and districts with clean names, and every dataset place', async () => {
    const repo = seededRepo();
    const result = await runGeoSeed(FIXTURE, repo);

    expect(result.states).toEqual({ created: 4, updated: 0, total: 4 });
    expect(repo.states.map((s) => s.name).sort()).toEqual(['Chhattisgarh', 'Karnataka', 'Maharashtra', 'Uttarakhand']);
    expect(result.districts).toEqual({ created: 4, updated: 0, total: 4 });
    expect(result.cities).toMatchObject({ created: 5, matched: 3, updated: 0, unchanged: 0, unmatchedSeed: ['navi-mumbai'], total: 9 });
  });

  it('matches the Lot A rows by name, alias and state, attaching the place and keeping slug, stage and switches', async () => {
    const repo = seededRepo();
    await runGeoSeed(FIXTURE, repo);

    const bengaluru = (await repo.findCityBySlug('bengaluru'))!;
    expect(bengaluru).toMatchObject({
      geonameId: 1277333,
      source: 'SEED',
      stage: 'LAUNCHED',
      isActive: true,
      switches: ON,
      latitude: 12.97,
      longitude: 77.59,
      population: 8_495_492,
      kind: 'STATE_CAPITAL',
      state: 'Karnataka',
      geoState: { code: '19', name: 'Karnataka' },
      geoDistrict: { code: '583', name: 'Bengaluru Urban' },
    });
    // The dataset's aliases join the row's own; the name and slug never become aliases.
    expect(bengaluru.aliases.sort()).toEqual(['bangalore', 'bengaluru-urban', 'blr']);

    // Four Raipurs: the seed's Chhattisgarh row takes the Chhattisgarh place, the biggest.
    const raipur = (await repo.findCityBySlug('raipur'))!;
    expect(raipur).toMatchObject({ geonameId: 1258980, geoState: { name: 'Chhattisgarh' }, stage: 'LAUNCHED' });

    // The alias-only match (mysore -> Mysuru) resolves too.
    expect((await repo.findCityBySlug('mysuru'))!.geonameId).toBe(1262321);

    // Navi Mumbai is nowhere in the dataset: untouched, reported.
    expect(await repo.findCityBySlug('navi-mumbai')).toMatchObject({ geonameId: null, source: 'SEED', stage: 'LAUNCHED' });
    // Nothing was created under a seed row's name.
    expect(repo.cities.filter((c) => c.name === 'Bengaluru')).toHaveLength(1);
  });

  it('creates every other place PLANNED, GEONAMES, inactive, all six off, with slugs that survive the Rampurs', async () => {
    const repo = seededRepo();
    await runGeoSeed(FIXTURE, repo);

    const mumbai = (await repo.findCityBySlug('mumbai'))!;
    expect(mumbai).toMatchObject({ source: 'GEONAMES', stage: 'PLANNED', isActive: false, switches: OFF, state: 'Maharashtra', kind: 'STATE_CAPITAL' });
    expect(mumbai.aliases.sort()).toEqual(['bom', 'bombay']);

    const raipurs = repo.cities.filter((c) => c.name === 'Raipur').map((c) => c.slug).sort();
    // The seed row kept `raipur`; the Uttarakhand ones, biggest first, take the state, then (the district-less one) the id, then the district.
    expect(raipurs).toEqual(['raipur', 'raipur-1258982', 'raipur-uttarakhand', 'raipur-uttarakhand-dehradun']);
    expect((await repo.findCityBySlug('raipur-uttarakhand'))!.geonameId).toBe(1258981);
    expect(new Set(repo.cities.map((c) => c.slug)).size).toBe(repo.cities.length);
  });

  it('is idempotent: a second run creates, matches and updates nothing and makes no write', async () => {
    const repo = seededRepo();
    await runGeoSeed(FIXTURE, repo);
    const before = JSON.stringify(repo.cities);
    repo.writes = 0;

    const again = await runGeoSeed(FIXTURE, repo);
    expect(again.states).toEqual({ created: 0, updated: 0, total: 4 });
    expect(again.districts).toEqual({ created: 0, updated: 0, total: 4 });
    expect(again.cities).toMatchObject({ created: 0, matched: 0, updated: 0, unchanged: 8, unmatchedSeed: ['navi-mumbai'], total: 9 });
    expect(repo.writes).toBe(0);
    expect(JSON.stringify(repo.cities)).toBe(before);
  });

  it('refreshes a place whose dataset columns moved, and keeps an alias ops added by hand', async () => {
    const repo = seededRepo();
    await runGeoSeed(FIXTURE, repo);
    const mumbai = (await repo.findCityBySlug('mumbai'))!;
    await repo.updateCity(mumbai.id, { aliases: [...mumbai.aliases, 'greater-mumbai'] });

    const moved: GeoDataset = { ...FIXTURE, cities: FIXTURE.cities.map((c) => (c.geonameId === 1275339 ? { ...c, population: 12_700_000 } : c)) };
    const result = await runGeoSeed(moved, repo);
    expect(result.cities).toMatchObject({ created: 0, updated: 1, unchanged: 7 });
    expect(await repo.findCityBySlug('mumbai')).toMatchObject({ population: 12_700_000 });
    expect((await repo.findCityBySlug('mumbai'))!.aliases.sort()).toEqual(['bom', 'bombay', 'greater-mumbai']);
  });

  it('W-B: the overrides file places a seed row the dataset lacks — matched by slug, idempotent, reported as overridden', async () => {
    const overrides = geoOverridesSchema.parse({
      cities: [{ slug: 'navi-mumbai', name: 'Navi Mumbai', stateCode: '16', lat: 19.033, lng: 73.0297, population: 1_120_547, kind: 'TOWN', aliases: ['navi mumbai', 'new bombay'] }],
    });
    const repo = seededRepo();
    const result = await runGeoSeed(FIXTURE, repo, overrides);
    expect(result.cities).toMatchObject({ created: 5, matched: 3, updated: 0, unmatchedSeed: [], overridden: ['navi-mumbai'], total: 9 });
    const navi = (await repo.findCityBySlug('navi-mumbai'))!;
    expect(navi).toMatchObject({ source: 'SEED', stage: 'LAUNCHED', switches: ON, geonameId: null, latitude: 19.033, longitude: 73.0297, population: 1_120_547, kind: 'TOWN', state: 'Maharashtra', geoState: { code: '16', name: 'Maharashtra' } });
    expect(navi.aliases.sort()).toEqual(['new-bombay']);

    const before = JSON.stringify(repo.cities);
    repo.writes = 0;
    const again = await runGeoSeed(FIXTURE, repo, overrides);
    expect(again.cities).toMatchObject({ created: 0, matched: 0, updated: 0, unmatchedSeed: [], overridden: ['navi-mumbai'] });
    expect(repo.writes).toBe(0);
    expect(JSON.stringify(repo.cities)).toBe(before);
  });

  it('W-B: an override for a slug the table lacks creates the row PLANNED, source SEED; an unknown state or district is refused', async () => {
    const repo = new InMemoryGeoRepository();
    const overrides = geoOverridesSchema.parse({ cities: [{ slug: 'navi-mumbai', name: 'Navi Mumbai', stateCode: '16', districtCode: '999', lat: 19.033, lng: 73.0297 }] });
    await expect(runGeoSeed(FIXTURE, repo, overrides)).rejects.toThrow(/district/i);
    const ok = await runGeoSeed(FIXTURE, repo, geoOverridesSchema.parse({ cities: [{ slug: 'navi-mumbai', name: 'Navi Mumbai', stateCode: '16', lat: 19.033, lng: 73.0297 }] }));
    expect(ok.cities.overridden).toEqual(['navi-mumbai']);
    expect(await repo.findCityBySlug('navi-mumbai')).toMatchObject({ source: 'SEED', stage: 'PLANNED', isActive: false, geoState: { code: '16' }, latitude: 19.033 });
  });

  it('on an empty table creates every place, the seed rows included, as PLANNED', async () => {
    const repo = new InMemoryGeoRepository();
    const result = await runGeoSeed(FIXTURE, repo);
    expect(result.cities).toMatchObject({ created: 8, matched: 0, unmatchedSeed: [] });
    expect(repo.cities.every((c) => c.stage === 'PLANNED' && !c.isActive)).toBe(true);
  });
});

describe('cleanPlaceName', () => {
  it('drops the GeoNames prefixes and the diacritics', () => {
    expect(cleanPlaceName('State of Mahārāshtra')).toBe('Maharashtra');
    expect(cleanPlaceName('Union Territory of Chandigarh')).toBe('Chandigarh');
    expect(cleanPlaceName('National Capital Territory of Delhi')).toBe('Delhi');
    expect(cleanPlaceName('Guntūr')).toBe('Guntur');
    expect(cleanPlaceName('Uttar Pradesh')).toBe('Uttar Pradesh');
  });
});

describe('the real dataset', () => {
  const file = path.resolve(__dirname, '../../../../data/geo/india-geo.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;

  it('parses: 36 states, 763 districts, every city under a known state with a point and a kind', () => {
    const parsed = geoDatasetSchema.safeParse(raw);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.flatten())).toBe(true);
    const dataset = parsed.data!;
    expect(dataset.states).toHaveLength(36);
    expect(dataset.districts).toHaveLength(763);
    expect(dataset.cities.length).toBeGreaterThan(6000);
    const states = new Set(dataset.states.map((s) => s.code));
    const districts = new Set(dataset.districts.map((d) => `${d.stateCode}:${d.code}`));
    let orphanDistricts = 0;
    for (const city of dataset.cities) {
      expect(states.has(city.stateCode), city.name).toBe(true);
      if (city.districtCode && !districts.has(`${city.stateCode}:${city.districtCode}`)) orphanDistricts += 1;
    }
    // GeoNames files a few places under an admin2 code its admin2 list lacks (Mani Majra); the seed leaves those without a district.
    expect(orphanDistricts).toBeLessThan(dataset.cities.length / 100);
    expect(dataset.source).toMatch(/GeoNames/);
    expect(dataset.source).toMatch(/CC BY 4\.0/);
  });

  it('seeds whole over the 44 Lot A rows: 43 matched, Navi Mumbai reported, every slug unique, in a handful of round trips', async () => {
    const dataset = geoDatasetSchema.parse(raw);
    const repo = new InMemoryGeoRepository();
    const lotA: [string, string, string, string[]][] = [
      ['mumbai', 'Mumbai', 'Maharashtra', ['bombay', 'greater-mumbai']],
      ['delhi', 'Delhi', 'Delhi', ['new-delhi', 'ncr', 'delhi-ncr']],
      ['bengaluru', 'Bengaluru', 'Karnataka', ['bangalore', 'bengaluru-urban']],
      ['chennai', 'Chennai', 'Tamil Nadu', ['madras']],
      ['kolkata', 'Kolkata', 'West Bengal', ['calcutta']],
      ['hyderabad', 'Hyderabad', 'Telangana', ['secunderabad']],
      ['pune', 'Pune', 'Maharashtra', ['poona', 'pimpri-chinchwad']],
      ['ahmedabad', 'Ahmedabad', 'Gujarat', ['amdavad']],
      ['surat', 'Surat', 'Gujarat', []],
      ['jaipur', 'Jaipur', 'Rajasthan', []],
      ['lucknow', 'Lucknow', 'Uttar Pradesh', []],
      ['kanpur', 'Kanpur', 'Uttar Pradesh', ['cawnpore']],
      ['nagpur', 'Nagpur', 'Maharashtra', []],
      ['indore', 'Indore', 'Madhya Pradesh', []],
      ['bhopal', 'Bhopal', 'Madhya Pradesh', []],
      ['visakhapatnam', 'Visakhapatnam', 'Andhra Pradesh', ['vizag', 'vishakhapatnam']],
      ['patna', 'Patna', 'Bihar', []],
      ['vadodara', 'Vadodara', 'Gujarat', ['baroda']],
      ['ludhiana', 'Ludhiana', 'Punjab', []],
      ['agra', 'Agra', 'Uttar Pradesh', []],
      ['nashik', 'Nashik', 'Maharashtra', ['nasik']],
      ['faridabad', 'Faridabad', 'Haryana', []],
      ['gurugram', 'Gurugram', 'Haryana', ['gurgaon']],
      ['noida', 'Noida', 'Uttar Pradesh', ['gautam-buddha-nagar']],
      ['rajkot', 'Rajkot', 'Gujarat', []],
      ['varanasi', 'Varanasi', 'Uttar Pradesh', ['banaras', 'benares']],
      ['amritsar', 'Amritsar', 'Punjab', []],
      ['coimbatore', 'Coimbatore', 'Tamil Nadu', ['kovai']],
      ['kochi', 'Kochi', 'Kerala', ['cochin', 'ernakulam']],
      ['thiruvananthapuram', 'Thiruvananthapuram', 'Kerala', ['trivandrum']],
      ['chandigarh', 'Chandigarh', 'Chandigarh', []],
      ['guwahati', 'Guwahati', 'Assam', ['gauhati']],
      ['bhubaneswar', 'Bhubaneswar', 'Odisha', []],
      ['raipur', 'Raipur', 'Chhattisgarh', []],
      ['ranchi', 'Ranchi', 'Jharkhand', []],
      ['dehradun', 'Dehradun', 'Uttarakhand', ['dehra-dun']],
      ['mysuru', 'Mysuru', 'Karnataka', ['mysore']],
      ['madurai', 'Madurai', 'Tamil Nadu', []],
      ['jodhpur', 'Jodhpur', 'Rajasthan', []],
      ['thane', 'Thane', 'Maharashtra', []],
      ['navi-mumbai', 'Navi Mumbai', 'Maharashtra', ['new-bombay']],
      ['ghaziabad', 'Ghaziabad', 'Uttar Pradesh', []],
      ['prayagraj', 'Prayagraj', 'Uttar Pradesh', ['allahabad']],
      ['puducherry', 'Puducherry', 'Puducherry', ['pondicherry']],
    ];
    for (const [slug, name, state, aliases] of lotA) seedRow(repo, slug, name, state, aliases);

    const result = await runGeoSeed(dataset, repo);
    expect(result.cities.matched).toBe(43);
    expect(result.cities.unmatchedSeed).toEqual(['navi-mumbai']);
    expect(result.cities.created).toBe(dataset.cities.length - 43);
    expect(new Set(repo.cities.map((c) => c.slug)).size).toBe(repo.cities.length);
    expect(new Set(repo.cities.map((c) => c.geonameId).filter((id) => id !== null)).size).toBe(dataset.cities.length);
    // Every Lot A row is still launched with its switches, and now placed.
    for (const [slug] of lotA) {
      const row = (await repo.findCityBySlug(slug))!;
      expect(row).toMatchObject({ stage: 'LAUNCHED', isActive: true, switches: ON, source: 'SEED' });
      if (slug !== 'navi-mumbai') expect(row.geoState?.name, slug).toBeTruthy();
    }
    expect((await repo.findCityBySlug('raipur'))!.geoState?.name).toBe('Chhattisgarh');
    expect((await repo.findCityBySlug('jodhpur'))!.geoState?.name).toBe('Rajasthan');
    expect((await repo.findCityBySlug('chandigarh'))!.geoState?.name).toBe('Chandigarh');
    expect((await repo.findCityBySlug('visakhapatnam'))!.geonameId).toBe(1253102);
    // Chunked: states + districts + 13 city chunks + one update transaction, not thousands of writes.
    expect(repo.writes).toBeLessThan(25);

    const again = await runGeoSeed(dataset, repo);
    expect(again.cities).toMatchObject({ created: 0, matched: 0, updated: 0 });

    // W-B: the vendored overrides file places Navi Mumbai — Maharashtra, Thane district, the point — on the next run.
    const overrides = geoOverridesSchema.parse(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../data/geo/seed-overrides.json'), 'utf8')));
    const placed = await runGeoSeed(dataset, repo, overrides);
    expect(placed.cities).toMatchObject({ created: 0, matched: 0, updated: 0, unmatchedSeed: [], overridden: ['navi-mumbai'] });
    expect(await repo.findCityBySlug('navi-mumbai')).toMatchObject({ stage: 'LAUNCHED', source: 'SEED', geoState: { name: 'Maharashtra' }, geoDistrict: { name: 'Thane' }, latitude: 19.033, longitude: 73.0297, population: 1_120_547 });
    repo.writes = 0;
    expect((await runGeoSeed(dataset, repo, overrides)).cities).toMatchObject({ updated: 0, overridden: ['navi-mumbai'] });
    expect(repo.writes).toBe(0);
  });
});
