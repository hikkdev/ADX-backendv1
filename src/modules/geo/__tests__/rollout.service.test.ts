import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rollout service over the in-memory repository — Lot V.
 *
 * One city moving through the stages (the row, the mirror, the stamps, one
 * event per change, a no-op writing nothing); a state moved at once with
 * the refusals named rather than the batch failed; a town added by hand;
 * the readiness read against the platform settings; the map's counts; the
 * app's pickers and the "coming soon" list.
 */

const { settings, listings } = vi.hoisted(() => ({
  settings: { geo: { launchMinListings: 2, launchNeedsPrintPartner: false, comingSoonWaitlist: true }, audience: { cityProfileSamplePoints: 0 } },
  listings: { storedAudienceForListings: vi.fn(async () => null), audienceForSpots: vi.fn(async () => null), currentPeriod: () => '2026-09' },
}));
vi.mock('../../app-config', () => ({ getPlatformSettings: async () => settings }));
// Y-B: the readiness read folds the city audience profile — the listings side is stubbed (no vendor, no rows) and the minute cache bypassed.
vi.mock('../../listings', () => listings);
vi.mock('../../../shared/cache', () => ({ readThrough: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load() }));
// W-B: the users label export behind each event's `byUser`.
vi.mock('../../users', () => ({
  findUserLabels: async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: id === 'admin-1' ? 'Asha Ops' : null }])),
}));

import { DEFAULT_SWITCHES } from '../rollout.rules';
import {
  addCity,
  bulkRollout,
  changeRollout,
  cityReadiness,
  getCity,
  listCities,
  listDistricts,
  listStates,
  mapPoints,
  pickerCities,
  setGeoRepository,
  summary,
} from '../rollout.service';
import { runGeoSeed, geoDatasetSchema } from '../seed.service';
import { InMemoryGeoRepository } from './in-memory-geo.repository';

const ON = DEFAULT_SWITCHES.LAUNCHED;
const OFF = DEFAULT_SWITCHES.PLANNED;
const NOW = new Date('2026-09-15T10:00:00Z');

const DATASET = geoDatasetSchema.parse({
  source: 'fixture',
  generatedOn: '2026-09-15',
  states: [
    { code: '19', name: 'State of Karnataka', geonameId: 1, lat: 14.75, lng: 76 },
    { code: '16', name: 'State of Mahārāshtra', geonameId: 2, lat: 19.5, lng: 76 },
  ],
  districts: [
    { stateCode: '19', code: '583', name: 'Bengaluru Urban', geonameId: 11, lat: 13, lng: 77.6 },
    { stateCode: '19', code: '594', name: 'Mysuru', geonameId: 12, lat: 12.3, lng: 76.6 },
  ],
  cities: [
    { geonameId: 101, name: 'Bengaluru', aliases: ['Bangalore'], stateCode: '19', districtCode: '583', lat: 12.97, lng: 77.59, population: 8_495_492, kind: 'STATE_CAPITAL' },
    { geonameId: 102, name: 'Mysuru', aliases: ['Mysore'], stateCode: '19', districtCode: '594', lat: 12.3, lng: 76.65, population: 920_550, kind: 'DISTRICT_HQ' },
    { geonameId: 103, name: 'Ramanagara', aliases: [], stateCode: '19', districtCode: '583', lat: 12.72, lng: 77.28, population: 95_000, kind: 'TOWN' },
    { geonameId: 104, name: 'Mumbai', aliases: ['Bombay'], stateCode: '16', districtCode: null, lat: 19.07, lng: 72.88, population: 12_691_836, kind: 'STATE_CAPITAL' },
    { geonameId: 105, name: 'Pune', aliases: [], stateCode: '16', districtCode: null, lat: 18.52, lng: 73.85, population: 3_124_458, kind: 'TOWN' },
  ],
});

let repo: InMemoryGeoRepository;

beforeEach(async () => {
  repo = new InMemoryGeoRepository();
  await runGeoSeed(DATASET, repo);
  setGeoRepository(repo);
  settings.geo = { launchMinListings: 2, launchNeedsPrintPartner: false, comingSoonWaitlist: true };
});

afterEach(() => setGeoRepository(null));

describe('one city through the stages', () => {
  it('PLANNED -> SEEDING writes the defaults, the mirror, one event, and answers both sides', async () => {
    const outcome = await changeRollout('mysuru', { stage: 'SEEDING', note: 'Agents hired' }, 'admin-1', NOW);
    expect(outcome.after).toMatchObject({ stage: 'SEEDING', isActive: true, switches: DEFAULT_SWITCHES.SEEDING, rolloutNote: 'Agents hired' });
    expect(outcome.beforeFlat).toMatchObject({ stage: 'PLANNED', isActive: false, supplyIntake: false });
    expect(outcome.afterFlat).toMatchObject({ stage: 'SEEDING', isActive: true, supplyIntake: true, publishing: false });
    expect(repo.events).toHaveLength(1);
    expect(repo.events[0]).toMatchObject({ fromStage: 'PLANNED', toStage: 'SEEDING', byUserId: 'admin-1', note: 'Agents hired', flags: { switches: DEFAULT_SWITCHES.SEEDING } });
  });

  it('SEEDING -> LAUNCHED stamps launchedAt and opens everything; PAUSED closes it and stamps pausedAt; LAUNCHED again clears pausedAt', async () => {
    await changeRollout('mysuru', { stage: 'SEEDING' }, 'admin-1', NOW);
    const launched = await changeRollout('mysuru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    expect(launched.after).toMatchObject({ stage: 'LAUNCHED', switches: ON, isActive: true, launchedAt: NOW, pausedAt: null });

    const later = new Date('2026-10-01T00:00:00Z');
    const paused = await changeRollout('mysuru', { stage: 'PAUSED' }, 'admin-1', later);
    expect(paused.after).toMatchObject({ stage: 'PAUSED', switches: OFF, isActive: true, launchedAt: NOW, pausedAt: later });

    const back = await changeRollout('mysuru', { stage: 'LAUNCHED' }, 'admin-1', new Date('2026-11-01T00:00:00Z'));
    expect(back.after).toMatchObject({ stage: 'LAUNCHED', switches: ON, pausedAt: null, launchedAt: new Date('2026-11-01T00:00:00Z') });
    expect(repo.events.map((e) => `${e.fromStage}>${e.toStage}`)).toEqual(['PLANNED>SEEDING', 'SEEDING>LAUNCHED', 'LAUNCHED>PAUSED', 'PAUSED>LAUNCHED']);
  });

  it('WITHDRAWN stamps withdrawnAt and mirrors false; re-entry to SEEDING clears it and republishes nothing here', async () => {
    await changeRollout('mysuru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    const out = await changeRollout('mysuru', { stage: 'WITHDRAWN', note: 'No supply' }, 'admin-1', NOW);
    expect(out.after).toMatchObject({ stage: 'WITHDRAWN', isActive: false, switches: OFF, withdrawnAt: NOW });
    const back = await changeRollout('mysuru', { stage: 'SEEDING' }, 'admin-1', NOW);
    expect(back.after).toMatchObject({ stage: 'SEEDING', isActive: true, withdrawnAt: null, switches: DEFAULT_SWITCHES.SEEDING });
  });

  it('refuses a move the table does not allow, writing nothing', async () => {
    await expect(changeRollout('mysuru', { stage: 'PAUSED' }, 'admin-1', NOW)).rejects.toMatchObject({ statusCode: 409, details: { from: 'PLANNED', to: 'PAUSED' } });
    expect(repo.events).toHaveLength(0);
    expect((await repo.findCityBySlug('mysuru'))!.stage).toBe('PLANNED');
  });

  it('a switch override rides the stage change, and a switch-only patch keeps the stage', async () => {
    const out = await changeRollout('mysuru', { stage: 'SEEDING', switches: { leadFeeds: false } }, 'admin-1', NOW);
    expect(out.after.switches).toEqual({ ...DEFAULT_SWITCHES.SEEDING, leadFeeds: false });
    const only = await changeRollout('mysuru', { switches: { publishing: true } }, 'admin-1', NOW);
    expect(only.after).toMatchObject({ stage: 'SEEDING', switches: { ...DEFAULT_SWITCHES.SEEDING, leadFeeds: false, publishing: true } });
    expect(only.plan.flipped).toEqual(['publishing']);
    expect(repo.events).toHaveLength(2);
  });

  it('a patch that changes nothing writes no row and no event', async () => {
    const writes = repo.writes;
    const out = await changeRollout('mysuru', { switches: { demand: false } }, 'admin-1', NOW);
    expect(out.plan.changed).toBe(false);
    expect(repo.writes).toBe(writes);
    expect(repo.events).toHaveLength(0);
  });

  it('a note alone is kept without an event', async () => {
    await changeRollout('mysuru', { note: 'Watching' }, 'admin-1', NOW);
    expect((await repo.findCityBySlug('mysuru'))!.rolloutNote).toBe('Watching');
    expect(repo.events).toHaveLength(0);
  });

  it('is a 404 on a slug the catalogue lacks', async () => {
    await expect(changeRollout('atlantis', { stage: 'SEEDING' }, 'admin-1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the bulk rollout', () => {
  it('moves a whole state, one event per city, naming the ones the table refused', async () => {
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    const out = await bulkRollout({ stateCode: '19' }, { stage: 'SEEDING', note: 'Karnataka push' }, 'admin-1', NOW);
    expect(out.changed.map((c) => c.slug).sort()).toEqual(['mysuru', 'ramanagara']);
    expect(out.skipped).toEqual([{ slug: 'bengaluru', reason: expect.stringContaining('launched city cannot go seeding') }]);
    expect(out.unchanged).toEqual([]);
    expect(repo.events.filter((e) => e.toStage === 'SEEDING')).toHaveLength(2);
    expect((await repo.findCityBySlug('ramanagara'))!).toMatchObject({ stage: 'SEEDING', isActive: true, rolloutNote: 'Karnataka push' });
    expect((await repo.findCityBySlug('mumbai'))!.stage).toBe('PLANNED');
  });

  it('moves a district, and a list of slugs, and reports the already-there ones as unchanged', async () => {
    const district = (await repo.listDistricts()).find((d) => d.code === '583')!;
    const out = await bulkRollout({ districtId: district.id }, { stage: 'SEEDING' }, 'admin-1', NOW);
    expect(out.changed.map((c) => c.slug).sort()).toEqual(['bengaluru', 'ramanagara']);

    const again = await bulkRollout({ citySlugs: ['bengaluru', 'mumbai'] }, { stage: 'SEEDING' }, 'admin-1', NOW);
    expect(again.unchanged).toEqual(['bengaluru']);
    expect(again.changed).toEqual([{ slug: 'mumbai', from: 'PLANNED', to: 'SEEDING' }]);
  });

  it('is a 404 on an unknown slug, state or district', async () => {
    await expect(bulkRollout({ citySlugs: ['bengaluru', 'atlantis'] }, { stage: 'SEEDING' }, 'admin-1')).rejects.toMatchObject({ statusCode: 404, details: { missing: ['atlantis'] } });
    await expect(bulkRollout({ stateCode: '99' }, { stage: 'SEEDING' }, 'admin-1')).rejects.toMatchObject({ statusCode: 404 });
    await expect(bulkRollout({ districtId: 'nope' }, { stage: 'SEEDING' }, 'admin-1')).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('a town added by hand', () => {
  it('lands PLANNED, MANUAL, under its state and district, with a slug that dodges a collision', async () => {
    const city = await addCity({ name: 'Navi Mumbai', stateCode: '16', lat: 19.03, lng: 73.03, aliases: ['New Bombay', 'navi-mumbai'] });
    expect(city).toMatchObject({ slug: 'navi-mumbai', source: 'MANUAL', stage: 'PLANNED', isActive: false, switches: OFF, state: 'Maharashtra', kind: 'TOWN', aliases: ['new-bombay'] });

    const twin = await addCity({ name: 'Mysuru', stateCode: '16', lat: 1, lng: 1 });
    expect(twin.slug).toBe('mysuru-maharashtra');
    await expect(addCity({ name: 'Mysuru', stateCode: '16', lat: 1, lng: 1 })).rejects.toMatchObject({ statusCode: 409 });
    await expect(addCity({ name: 'Somewhere', stateCode: '99', lat: 1, lng: 1 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(addCity({ name: 'Somewhere', stateCode: '19', districtCode: '999', lat: 1, lng: 1 })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the reads', () => {
  it('lists states and districts with counts per stage', async () => {
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    const states = await listStates();
    expect(states.find((s) => s.code === '19')).toMatchObject({ name: 'Karnataka', cities: 3, counts: { PLANNED: 2, LAUNCHED: 1, SEEDING: 0 } });
    const districts = await listDistricts('19');
    expect(districts.items.find((d) => d.code === '583')).toMatchObject({ cities: 2, counts: { LAUNCHED: 1, PLANNED: 1 } });
    await expect(listDistricts('99')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists cities by the list contract, with the stage facet removed from the counts', async () => {
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    const page = await listCities({ state: '19', stage: ['LAUNCHED'], sort: 'population', page: 1, pageSize: 10 });
    expect(page.items.map((c) => c.slug)).toEqual(['bengaluru']);
    expect(page.total).toBe(1);
    expect(page.counts).toMatchObject({ LAUNCHED: 1, PLANNED: 2 });
    const search = await listCities({ q: 'mys', sort: 'name', page: 1, pageSize: 10 });
    expect(search.items.map((c) => c.slug)).toEqual(['mysuru']);
    expect((await listCities({ state: '99', sort: 'name', page: 1, pageSize: 10 })).total).toBe(0);
  });

  it('answers a city with its counts and its events', async () => {
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    repo.parties.publishers.set('bengaluru', 3);
    repo.parties.publishers.set('bangalore', 1);
    repo.parties.listingsLive.set('bengaluru', [{ id: 'l1', title: 'A', publisherUserId: 'u1' }]);
    repo.parties.openLeads.set('bengaluru', 4);
    const city = await getCity('bengaluru');
    expect(city.counts).toMatchObject({ publishers: 4, listingsLive: 1, openLeads: 4 });
    expect(city.events).toHaveLength(1);
    // W-B: each event names who moved the city — one label lookup for the page.
    expect(city.events[0]).toMatchObject({ byUserId: 'admin-1', byUser: { id: 'admin-1', name: 'Asha Ops' } });
  });

  it('summarises the stages and the states with any activity', async () => {
    await changeRollout('bengaluru', { stage: 'SEEDING' }, 'admin-1', NOW);
    const out = await summary();
    expect(out).toMatchObject({ cities: 5, stages: { PLANNED: 4, SEEDING: 1 }, statesWithActivity: 1 });
    expect(out.states.map((s) => s.code)).toEqual(['19']);
  });
});

describe('readiness', () => {
  it('checks the rate card, the agents of each side, the live listings against the setting, the partner rule and the vocabulary', async () => {
    const before = await cityReadiness('bengaluru', NOW);
    expect(before.ready).toBe(false);
    expect(before.checks.map((c) => [c.key, c.ok])).toEqual([
      ['rateCard', false],
      ['agents', false],
      ['listings', false],
      ['printPartner', true],
      ['vocabulary', true],
      ['audience', false],
    ]);
    // Y-B: the audience check is soft — printed, never counted.
    expect(before.checks.find((c) => c.key === 'audience')).toMatchObject({ soft: true, detail: expect.stringContaining('never blocks a launch') });

    const city = (await repo.findCityBySlug('bengaluru'))!;
    repo.rateCards.push({ cityId: city.id, name: 'Bengaluru card v1' });
    repo.parties.agents.set('bengaluru', [
      { userId: 'a1', side: 'publisher' },
      { userId: 'a2', side: 'advertiser' },
    ]);
    repo.parties.listingsLive.set('bengaluru', [
      { id: 'l1', title: 'A', publisherUserId: 'u1' },
      { id: 'l2', title: 'B', publisherUserId: 'u1' },
    ]);
    const after = await cityReadiness('bengaluru', NOW);
    expect(after.ready).toBe(true);
    expect(after.checks[0]!.detail).toContain('Bengaluru card v1');

    settings.geo.launchNeedsPrintPartner = true;
    const partnerless = await cityReadiness('bengaluru', NOW);
    expect(partnerless.checks.find((c) => c.key === 'printPartner')).toMatchObject({ ok: false });
    repo.parties.printPartners.set('bengaluru', 1);
    expect((await cityReadiness('bengaluru', NOW)).ready).toBe(true);

    settings.geo.launchMinListings = 10;
    expect((await cityReadiness('bengaluru', NOW)).checks.find((c) => c.key === 'listings')).toMatchObject({ ok: false, detail: expect.stringContaining('2 live listing(s) of 10') });

    repo.rateCards.length = 0;
    repo.rateCards.push({ cityId: null, name: 'India card' });
    expect((await cityReadiness('bengaluru', NOW)).checks[0]!.detail).toContain('(national)');
  });
});

describe('the map and the pickers', () => {
  it('answers pins inside the box with the stage and live counts on the open ones', async () => {
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    repo.parties.listingsLive.set('bengaluru', [{ id: 'l1', title: 'A', publisherUserId: null }]);
    repo.parties.listingsLive.set('mysuru', [{ id: 'l2', title: 'B', publisherUserId: null }]);
    const points = await mapPoints({ minLat: 11, maxLat: 14, minLng: 75, maxLng: 78.5 }, null);
    expect(points.map((p) => p.slug).sort()).toEqual(['bengaluru', 'mysuru', 'ramanagara']);
    expect(points.find((p) => p.slug === 'bengaluru')).toMatchObject({ stage: 'LAUNCHED', listingsLive: 1 });
    // A PLANNED pin never counts, whatever the free-text column says.
    expect(points.find((p) => p.slug === 'mysuru')).toMatchObject({ stage: 'PLANNED', listingsLive: 0 });
    expect((await mapPoints(null, ['LAUNCHED'])).map((p) => p.slug)).toEqual(['bengaluru']);
  });

  it('the pickers answer launched cities, and the coming-soon list is the seeding cities plus the planned capitals', async () => {
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    await changeRollout('pune', { stage: 'SEEDING' }, 'admin-1', NOW);
    const out = await pickerCities({ stages: ['LAUNCHED'], near: null, limit: 50 });
    expect(out.items.map((c) => c.slug)).toEqual(['bengaluru']);
    expect(out.items[0]).toMatchObject({ comingSoon: false, state: 'Karnataka', distanceM: null });
    // Mumbai is a PLANNED state capital; Pune is SEEDING; Mysuru is a PLANNED district HQ and is not listed.
    expect(out.comingSoon.map((c) => c.slug)).toEqual(['mumbai', 'pune']);
    expect(out.comingSoon[0]).toMatchObject({ comingSoon: true, stage: 'PLANNED' });
  });

  it('sorts nearest first when the phone sends its position, and filters by a name prefix', async () => {
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    await changeRollout('mumbai', { stage: 'LAUNCHED' }, 'admin-1', NOW);
    const out = await pickerCities({ stages: ['LAUNCHED'], near: { latitude: 18.5, longitude: 73.8 }, limit: 50 });
    expect(out.items.map((c) => c.slug)).toEqual(['mumbai', 'bengaluru']);
    expect(out.items[0]!.distanceM).toBeGreaterThan(100_000);
    const typed = await pickerCities({ stages: ['LAUNCHED'], q: 'beng', near: null, limit: 50 });
    expect(typed.items.map((c) => c.slug)).toEqual(['bengaluru']);
  });

  it('the coming-soon list is empty when the waitlist is switched off', async () => {
    settings.geo.comingSoonWaitlist = false;
    const out = await pickerCities({ stages: ['LAUNCHED'], near: null, limit: 50 });
    expect(out.comingSoon).toEqual([]);
  });
});
