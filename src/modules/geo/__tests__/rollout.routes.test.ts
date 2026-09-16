import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rollout routes — Lot V.
 *
 * The console's reads and the two writes behind ADMIN + `settings.edit`,
 * the seed behind `system.roles`, and the app's two reads behind any
 * session — over the in-memory repository, with the audit rows pinned:
 * CITY_ROLLOUT_CHANGED with the diff, CITY_ROLLOUT_BULK with the summary,
 * CITY_ADDED, GEO_SEEDED.
 */

const { audit, settings, leads, publishers, advertisers, users, cache, pricing, listings } = vi.hoisted(() => ({
  audit: { logActivity: vi.fn() },
  // Y-B: the city audience profile's read of the listings side — no vendor in force unless a test says so.
  listings: { storedAudienceForListings: vi.fn(async () => null), audienceForSpots: vi.fn(async () => null), currentPeriod: () => '2026-09' },
  // Lot X-L: the backfill's lock (SET NX) and the run itself, pinned per test.
  cache: { redis: { set: vi.fn(async (): Promise<string | null> => 'OK'), del: vi.fn(async () => 1) } },
  pricing: { backfillCityKeys: vi.fn() },
  settings: { geo: { launchMinListings: 10, launchNeedsPrintPartner: false, comingSoonWaitlist: true }, audience: { cityProfileSamplePoints: 0 } },
  leads: { registerWaitlistLead: vi.fn(), WAITLIST_SOURCE: 'WAITLIST' },
  publishers: { findPublisherForUser: vi.fn() },
  advertisers: { getAdvertiserForUser: vi.fn() },
  users: { findUserLabels: vi.fn(), findUserSummaries: vi.fn() },
}));
// W-B: the waitlist's neighbours — the lead is leads', the caller's profile is publishers'/advertisers', the label is users'.
vi.mock('../../leads', () => leads);
vi.mock('../../publishers', () => publishers);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../users', () => users);
vi.mock('../../listings', () => listings);
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../../app-config', () => ({ getPlatformSettings: async () => settings }));
vi.mock('../../../shared/cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/cache')>();
  // Y-B: the profile's minute cache bypassed, so each read folds afresh.
  return { ...actual, redis: cache.redis, readThrough: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load() };
});
// The typed-name lookup is pricing's; the rest of pricing (slugify, the stage list) is real.
vi.mock('../../pricing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../pricing')>();
  const OFF = { supplyIntake: false, publishing: false, demand: false, agentOnboarding: false, printPartners: false, leadFeeds: false };
  return {
    ...actual,
    // Lot X-L: the re-resolve `POST /geo/backfill-city-keys` runs, pinned per test.
    backfillCityKeys: pricing.backfillCityKeys,
    // Lot X-B: what GET /geo/unresolved answers — pricing's read over the party tables, pinned here.
    listUnresolvedCities: async () => [
      { city: 'Blore', total: 8, tables: { publishers: 2, listings: 5, campaigns: 1 } },
      { city: 'Rameswaram', total: 1, tables: { leads: 1 } },
    ],
    citySupport: async (name: string) =>
      name.toLowerCase() === 'mysore'
        ? { support: 'INACTIVE', resolved: true, stage: 'SEEDING', switches: { ...OFF, supplyIntake: true }, city: { slug: 'mysuru', name: 'Mysuru', state: 'Karnataka' } }
        : { support: 'UNKNOWN', resolved: false, stage: null, switches: { ...OFF, supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true }, city: null },
  };
});
vi.mock('../../../shared/maps', () => ({ DIRECTIONS_MODES: ['driving', 'two_wheeler'], geocodeAddress: vi.fn(), reverseGeocode: vi.fn(), autocompletePlaces: vi.fn(), placeDetails: vi.fn(), routeDirections: vi.fn() }));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { appGeoRouter, geoRouter } from '../geo.routes';
import * as controller from '../rollout.controller';
import { setGeoRepository } from '../rollout.service';
import { geoDatasetSchema, runGeoSeed } from '../seed.service';
import { InMemoryGeoRepository } from './in-memory-geo.repository';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/geo', geoRouter);
  api.use('/app/geo', appGeoRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'usr_admin');
const publisher = tokenFor(['PUBLISHER'], 'usr_pub');

const DATASET = geoDatasetSchema.parse({
  source: 'fixture',
  generatedOn: '2026-09-15',
  states: [{ code: '19', name: 'State of Karnataka', geonameId: 1, lat: 14.75, lng: 76 }],
  districts: [{ stateCode: '19', code: '583', name: 'Bengaluru Urban', geonameId: 11, lat: 13, lng: 77.6 }],
  cities: [
    { geonameId: 101, name: 'Bengaluru', aliases: ['Bangalore'], stateCode: '19', districtCode: '583', lat: 12.97, lng: 77.59, population: 8_495_492, kind: 'STATE_CAPITAL' },
    { geonameId: 102, name: 'Mysuru', aliases: ['Mysore'], stateCode: '19', districtCode: null, lat: 12.3, lng: 76.65, population: 920_550, kind: 'DISTRICT_HQ' },
  ],
});

let repo: InMemoryGeoRepository;

beforeEach(async () => {
  vi.clearAllMocks();
  cache.redis.set.mockResolvedValue('OK');
  cache.redis.del.mockResolvedValue(1);
  settings.geo.comingSoonWaitlist = true;
  users.findUserLabels.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: id === 'usr_admin' ? 'Asha Ops' : null }])));
  users.findUserSummaries.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: 'Ravi', mobile: '+919000000009', email: null }])));
  publishers.findPublisherForUser.mockResolvedValue(null);
  advertisers.getAdvertiserForUser.mockResolvedValue(null);
  leads.registerWaitlistLead.mockImplementation(async (input: { businessName: string; city: string }) => ({ created: true, lead: { id: 'led_1', displayId: 'LED-0001', businessName: input.businessName, city: input.city } }));
  repo = new InMemoryGeoRepository();
  await runGeoSeed(DATASET, repo);
  setGeoRepository(repo);
});

afterEach(() => setGeoRepository(null));

describe('guards', () => {
  it('needs a session everywhere, and ADMIN on the console reads', async () => {
    expect((await request(app()).get('/api/v1/geo/summary')).status).toBe(401);
    expect((await request(app()).get('/api/v1/geo/summary').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect((await request(app()).get('/api/v1/app/geo/cities')).status).toBe(401);
    expect((await request(app()).get('/api/v1/app/geo/cities').set('Authorization', `Bearer ${publisher}`)).status).toBe(200);
  });
});

describe('the console reads', () => {
  /* Lot X-B */
  it('lists the typed city strings with no key, with their row counts, for ADMIN only', async () => {
    expect((await request(app()).get('/api/v1/geo/unresolved').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    const res = await request(app()).get('/api/v1/geo/unresolved').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      items: [
        { city: 'Blore', total: 8, tables: { publishers: 2, listings: 5, campaigns: 1 } },
        { city: 'Rameswaram', total: 1, tables: { leads: 1 } },
      ],
      total: 2,
      rows: 9,
    });
  });

  it('answers the summary, the states, the districts, the list, one city, its readiness and the map', async () => {
    const auth = (req: request.Test) => req.set('Authorization', `Bearer ${admin}`);
    expect((await auth(request(app()).get('/api/v1/geo/summary'))).body.data).toMatchObject({ cities: 2, stages: { PLANNED: 2 } });
    expect((await auth(request(app()).get('/api/v1/geo/states'))).body.data[0]).toMatchObject({ code: '19', name: 'Karnataka', cities: 2 });
    expect((await auth(request(app()).get('/api/v1/geo/states/19/districts'))).body.data.items[0]).toMatchObject({ code: '583', cities: 1 });
    const list = await auth(request(app()).get('/api/v1/geo/cities?state=19&sort=name&stage=PLANNED&kind=STATE_CAPITAL,DISTRICT_HQ&minPopulation=1000'));
    expect(list.status).toBe(200);
    expect(list.body.data).toMatchObject({ total: 2, page: 1, pageSize: 20, counts: { PLANNED: 2 } });
    expect((await auth(request(app()).get('/api/v1/geo/cities/bengaluru'))).body.data).toMatchObject({ slug: 'bengaluru', stage: 'PLANNED', counts: { publishers: 0 }, events: [] });
    expect((await auth(request(app()).get('/api/v1/geo/cities/bengaluru/readiness'))).body.data).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ key: 'listings', ok: false })]) });
    // Y-B: the city audience profile — ADMIN, the period validated, nothing enabled a null profile with the reason.
    const profile = await auth(request(app()).get('/api/v1/geo/cities/bengaluru/audience?period=2026-09'));
    expect(profile.status).toBe(200);
    expect(profile.body.data).toMatchObject({ city: 'bengaluru', period: '2026-09', provider: 'NONE', vendors: [], coverage: { spots: 0, withSnapshot: 0, ratio: null }, samplePoints: null, footfall: { daily: null } });
    expect(listings.storedAudienceForListings).toHaveBeenCalledWith([], '2026-09');
    expect(listings.audienceForSpots).not.toHaveBeenCalled();
    expect((await auth(request(app()).get('/api/v1/geo/cities/bengaluru/audience?period=2026-9'))).status).toBe(400);
    expect((await auth(request(app()).get('/api/v1/geo/cities/nowhere/audience'))).status).toBe(404);
    expect((await request(app()).get('/api/v1/geo/cities/bengaluru/audience').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'pub_1')}`)).status).toBe(403);
    const map = await auth(request(app()).get('/api/v1/geo/map?bbox=76,12,78,13.5'));
    expect(map.body.data.map((p: { slug: string }) => p.slug).sort()).toEqual(['bengaluru', 'mysuru']);
    expect((await auth(request(app()).get('/api/v1/geo/map?bbox=1,2,3'))).status).toBe(400);
    expect((await auth(request(app()).get('/api/v1/geo/cities?stage=NOPE'))).status).toBe(400);
    expect((await auth(request(app()).get('/api/v1/geo/cities/atlantis'))).status).toBe(404);
  });
});

describe('the writes', () => {
  it('PATCH /geo/cities/:slug/rollout moves the city and audits CITY_ROLLOUT_CHANGED with the diff', async () => {
    const res = await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'SEEDING', leadFeeds: false, note: 'Go' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stage: 'SEEDING', isActive: true, switches: { supplyIntake: true, agentOnboarding: true, leadFeeds: false, publishing: false } });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'CITY_ROLLOUT_CHANGED',
      expect.objectContaining({
        module: 'geo',
        targetType: 'City',
        targetId: 'bengaluru',
        diff: expect.objectContaining({ stage: { before: 'PLANNED', after: 'SEEDING' }, isActive: { before: false, after: true }, supplyIntake: { before: false, after: true } }),
        metadata: expect.objectContaining({ from: 'PLANNED', to: 'SEEDING', note: 'Go' }),
      }),
    );
  });

  it('refuses a bad move with 409, an empty body and an unknown switch with 400, and a non-admin with 403', async () => {
    expect((await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'PAUSED' })).status).toBe(409);
    expect((await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${admin}`).send({})).status).toBe(400);
    expect((await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'SEEDING', nope: true })).status).toBe(400);
    expect((await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${publisher}`).send({ stage: 'SEEDING' })).status).toBe(403);
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('POST /geo/rollout moves a state and audits one CITY_ROLLOUT_BULK summary', async () => {
    const res = await request(app()).post('/api/v1/geo/rollout').set('Authorization', `Bearer ${admin}`).send({ stateCode: '19', stage: 'SEEDING', switches: { leadFeeds: false } });
    expect(res.status).toBe(200);
    expect(res.body.data.changed.map((c: { slug: string }) => c.slug).sort()).toEqual(['bengaluru', 'mysuru']);
    expect(audit.logActivity).toHaveBeenCalledTimes(1);
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CITY_ROLLOUT_BULK', expect.objectContaining({ targetType: 'GeoState', targetId: '19', metadata: expect.objectContaining({ stage: 'SEEDING', changed: 2, skipped: 0 }) }));
    expect((await request(app()).post('/api/v1/geo/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'SEEDING' })).status).toBe(400);
    expect((await request(app()).post('/api/v1/geo/rollout').set('Authorization', `Bearer ${admin}`).send({ stateCode: '19', citySlugs: ['x'], stage: 'SEEDING' })).status).toBe(400);
  });

  it('POST /geo/cities adds a town by hand and audits CITY_ADDED', async () => {
    const res = await request(app()).post('/api/v1/geo/cities').set('Authorization', `Bearer ${admin}`).send({ name: 'Ramanagara', stateCode: '19', districtCode: '583', lat: 12.72, lng: 77.28 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ slug: 'ramanagara', source: 'MANUAL', stage: 'PLANNED', geoDistrict: { code: '583' } });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'CITY_ADDED', expect.objectContaining({ targetId: 'ramanagara' }));
  });

  it('POST /geo/seed runs the real dataset through the seed behind system.roles and audits GEO_SEEDED with the counts', async () => {
    expect((await request(app()).post('/api/v1/geo/seed').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    const res = await request(app()).post('/api/v1/geo/seed').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ states: { total: 36 }, districts: { total: 763 } });
    expect(res.body.data.cities.created).toBeGreaterThan(6000);
    // The fixture's two GEONAMES rows carry ids the real dataset lacks: untouched, and the real Bengaluru takes the next slug.
    expect(res.body.data.cities.total).toBe(res.body.data.cities.created + 2);
    expect(await repo.findCityBySlug('bengaluru-karnataka')).toMatchObject({ source: 'GEONAMES', stage: 'PLANNED' });
    expect(audit.logActivity).toHaveBeenCalledWith('usr_admin', 'GEO_SEEDED', expect.objectContaining({ module: 'geo', metadata: expect.objectContaining({ states: expect.objectContaining({ total: 36 }) }) }));
    expect(controller.GEO_DATASET_PATH.split(/[/\\]/).slice(-3).join('/')).toBe('data/geo/india-geo.json');
  });

  /* Lot X-L */
  it('POST /geo/backfill-city-keys re-resolves every null key behind ADMIN + settings.edit, one run at a time, and audits GEO_CITY_KEYS_BACKFILLED', async () => {
    const empty = { resolved: 0, stillNull: 0 };
    pricing.backfillCityKeys.mockResolvedValue({
      publishers: { resolved: 2, stillNull: 1 },
      advertisers: empty,
      agents: empty,
      printPartners: empty,
      listings: { resolved: 5, stillNull: 0 },
      leads: empty,
      fieldVisits: empty,
      campaigns: { resolved: 1, stillNull: 0 },
    });

    // The guard: a session, and ADMIN with settings.edit.
    expect((await request(app()).post('/api/v1/geo/backfill-city-keys')).status).toBe(401);
    expect((await request(app()).post('/api/v1/geo/backfill-city-keys').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect(pricing.backfillCityKeys).not.toHaveBeenCalled();

    // The run: the report per table, the lock taken and released, the audit row with the totals.
    const res = await request(app()).post('/api/v1/geo/backfill-city-keys').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      tables: [
        { table: 'publishers', resolved: 2, stillNull: 1 },
        { table: 'advertisers', resolved: 0, stillNull: 0 },
        { table: 'agents', resolved: 0, stillNull: 0 },
        { table: 'printPartners', resolved: 0, stillNull: 0 },
        { table: 'listings', resolved: 5, stillNull: 0 },
        { table: 'leads', resolved: 0, stillNull: 0 },
        { table: 'fieldVisits', resolved: 0, stillNull: 0 },
        { table: 'campaigns', resolved: 1, stillNull: 0 },
      ],
    });
    expect(pricing.backfillCityKeys).toHaveBeenCalledTimes(1);
    expect(cache.redis.set).toHaveBeenCalledWith('geo:city-keys:backfill', '1', 'PX', expect.any(Number), 'NX');
    expect(cache.redis.del).toHaveBeenCalledWith('geo:city-keys:backfill');
    expect(audit.logActivity).toHaveBeenCalledWith(
      'usr_admin',
      'GEO_CITY_KEYS_BACKFILLED',
      expect.objectContaining({ module: 'geo', targetType: 'City', metadata: expect.objectContaining({ resolved: 8, stillNull: 1 }) }),
    );

    // The lock: a second click while one runs is 409, runs nothing, audits nothing, and does not release the other's lock.
    audit.logActivity.mockClear();
    cache.redis.del.mockClear();
    cache.redis.set.mockResolvedValueOnce(null);
    const busy = await request(app()).post('/api/v1/geo/backfill-city-keys').set('Authorization', `Bearer ${admin}`);
    expect(busy.status).toBe(409);
    expect(pricing.backfillCityKeys).toHaveBeenCalledTimes(1);
    expect(audit.logActivity).not.toHaveBeenCalled();
    expect(cache.redis.del).not.toHaveBeenCalled();
  });
});

describe('the city page names who moved it (W-B)', () => {
  it('GET /geo/cities/:slug carries byUser { id, name } on each rollout event, from one users label lookup', async () => {
    await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'SEEDING' });
    await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'LAUNCHED' });
    const res = await request(app()).get('/api/v1/geo/cities/bengaluru').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.events).toHaveLength(2);
    expect(res.body.data.events.every((e: { byUser: unknown }) => JSON.stringify(e.byUser) === JSON.stringify({ id: 'usr_admin', name: 'Asha Ops' }))).toBe(true);
    expect(users.findUserLabels).toHaveBeenCalledTimes(1);
    expect(users.findUserLabels).toHaveBeenCalledWith(['usr_admin']);
  });
});

describe('the waitlist (W-B)', () => {
  const tap = (token: string, body: Record<string, unknown>) => request(app()).post('/api/v1/app/geo/waitlist').set('Authorization', `Bearer ${token}`).send(body);

  it('creates the lead through leads from the caller\'s publisher profile and the catalogue row, 201 { leadId, city, stage }', async () => {
    await request(app()).patch('/api/v1/geo/cities/mysuru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'SEEDING' });
    publishers.findPublisherForUser.mockResolvedValue({ id: 'pub_1', userId: 'usr_pub', name: 'Suraj Kumar Prints', contactName: 'Suraj', mobile: '+919000000001', city: 'Bengaluru' });
    audit.logActivity.mockClear(); // the set-up move above is audited; the tap must not be
    const res = await tap(publisher, { citySlug: 'mysuru', side: 'PUBLISHER', note: 'Two hoardings' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ leadId: 'led_1', city: 'Mysuru', stage: 'SEEDING' });
    expect(leads.registerWaitlistLead).toHaveBeenCalledWith(
      {
        side: 'PUBLISHER',
        businessName: 'Suraj Kumar Prints',
        contactName: 'Suraj',
        phone: '+919000000001',
        city: 'Mysuru',
        latitude: 12.3,
        longitude: 76.65,
        interest: 'Notify me when Mysuru launches',
        note: 'Two hoardings',
      },
      'usr_pub',
    );
    // The requester's own act: nothing audited.
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('falls back to the advertiser profile, then the user\'s own name and mobile', async () => {
    advertisers.getAdvertiserForUser.mockResolvedValue({ id: 'adv_1', userId: 'usr_pub', name: 'Asha', companyName: 'Nandini Dairy', mobile: '+919000000002' });
    await tap(publisher, { citySlug: 'mysuru', side: 'ADVERTISER' });
    expect(leads.registerWaitlistLead).toHaveBeenLastCalledWith(expect.objectContaining({ side: 'ADVERTISER', businessName: 'Nandini Dairy', contactName: 'Asha', phone: '+919000000002' }), 'usr_pub');
    advertisers.getAdvertiserForUser.mockResolvedValue(null);
    await tap(publisher, { citySlug: 'mysuru', side: 'ADVERTISER' });
    expect(leads.registerWaitlistLead).toHaveBeenLastCalledWith(expect.objectContaining({ businessName: 'Ravi', contactName: 'Ravi', phone: '+919000000009' }), 'usr_pub');
  });

  it('a second tap answers the same lead with 200', async () => {
    leads.registerWaitlistLead.mockResolvedValue({ created: false, lead: { id: 'led_1' } });
    const res = await tap(publisher, { citySlug: 'mysuru', side: 'ADVERTISER' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ leadId: 'led_1', city: 'Mysuru', stage: 'PLANNED' });
  });

  it('refuses a LAUNCHED city (409 ALREADY_LIVE), an unknown one (404), a bad body (400), and the setting off (503 FEATURE_OFF)', async () => {
    await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'LAUNCHED' });
    const live = await tap(publisher, { citySlug: 'bengaluru', side: 'ADVERTISER' });
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe('ALREADY_LIVE');
    expect((await tap(publisher, { citySlug: 'atlantis', side: 'ADVERTISER' })).status).toBe(404);
    expect((await tap(publisher, { citySlug: 'mysuru', side: 'AGENT' })).status).toBe(400);
    expect((await tap(publisher, { citySlug: 'mysuru' })).status).toBe(400);
    expect((await request(app()).post('/api/v1/app/geo/waitlist').send({ citySlug: 'mysuru', side: 'ADVERTISER' })).status).toBe(401);
    settings.geo.comingSoonWaitlist = false;
    const off = await tap(publisher, { citySlug: 'mysuru', side: 'ADVERTISER' });
    expect(off.status).toBe(503);
    expect(off.body.error).toMatchObject({ code: 'FEATURE_OFF', details: { key: 'geo.comingSoonWaitlist' } });
    expect(leads.registerWaitlistLead).not.toHaveBeenCalled();
  });
});

describe('the app reads', () => {
  it('GET /app/geo/cities answers the pickers with the coming-soon list, nearest first with a position', async () => {
    await request(app()).patch('/api/v1/geo/cities/bengaluru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'LAUNCHED' });
    const res = await request(app()).get('/api/v1/app/geo/cities?lat=12.3&lng=76.6').set('Authorization', `Bearer ${publisher}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([expect.objectContaining({ slug: 'bengaluru', stage: 'LAUNCHED', comingSoon: false, distanceM: expect.any(Number) })]);
    // Mysuru is a PLANNED district HQ — not a capital, not seeding — so nothing is coming soon yet.
    expect(res.body.data.comingSoon).toEqual([]);
    await request(app()).patch('/api/v1/geo/cities/mysuru/rollout').set('Authorization', `Bearer ${admin}`).send({ stage: 'SEEDING' });
    const soon = await request(app()).get('/api/v1/app/geo/cities?stage=LAUNCHED').set('Authorization', `Bearer ${publisher}`);
    expect(soon.body.data.comingSoon).toEqual([expect.objectContaining({ slug: 'mysuru', stage: 'SEEDING', comingSoon: true })]);
    expect((await request(app()).get('/api/v1/app/geo/cities?lat=12').set('Authorization', `Bearer ${publisher}`)).status).toBe(400);
  });

  it('GET /app/geo/resolve answers the stage and switches behind a typed name, and allows an unknown one', async () => {
    const known = await request(app()).get('/api/v1/app/geo/resolve?name=Mysore').set('Authorization', `Bearer ${publisher}`);
    expect(known.status).toBe(200);
    expect(known.body.data).toMatchObject({ name: 'Mysore', resolved: true, slug: 'mysuru', city: 'Mysuru', stage: 'SEEDING', comingSoon: true, switches: { supplyIntake: true, demand: false } });
    const unknown = await request(app()).get('/api/v1/app/geo/resolve?name=Rameswaram').set('Authorization', `Bearer ${publisher}`);
    expect(unknown.body.data).toMatchObject({ resolved: false, slug: null, stage: null, comingSoon: false, switches: { demand: true } });
    expect((await request(app()).get('/api/v1/app/geo/resolve').set('Authorization', `Bearer ${publisher}`)).status).toBe(400);
  });
});
