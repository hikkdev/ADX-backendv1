import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The city audience profile — Y-B.
 *
 * Pinned: the profile is the blend over the city's spots' STORED rows —
 * mean daily footfall per catchment, the mixes weighted by footfall,
 * coverage as spots with a panel over live spots, the vendors in force and
 * their agreement — and calls NO vendor by default; the sample-point path
 * is off unless `settings.audience.cityProfileSamplePoints` is above 0, and
 * then asks a deterministic grid across the listings' box (a 3 km circle
 * around the city point with no placed listing) under synthetic
 * `city:<slug>:<n>` keys through the one-call-per-month snapshot read; the
 * fold is cached a minute per (city, period); readiness gains the soft
 * `audience` check that never counts.
 */

const { settings, listings, cache } = vi.hoisted(() => ({
  settings: { geo: { launchMinListings: 2, launchNeedsPrintPartner: false, comingSoonWaitlist: true }, audience: { cityProfileSamplePoints: 0 } },
  listings: { storedAudienceForListings: vi.fn(), audienceForSpots: vi.fn(), currentPeriod: () => '2026-09' },
  cache: { readThrough: vi.fn(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load()) },
}));
vi.mock('../../app-config', () => ({ getPlatformSettings: async () => settings }));
vi.mock('../../listings', () => listings);
vi.mock('../../../shared/cache', () => cache);
vi.mock('../../users', () => ({ findUserLabels: async () => new Map() }));

import { DEFAULT_AUDIENCE_POLICY } from '../../../shared/integrations';
import { cityAudienceCacheKey, CITY_AUDIENCE_CACHE_TTL_S, foldCityAudience, sampleBox, sampleGrid, sampleKey } from '../audience-profile.service';
import { cityAudienceProfile, cityReadiness, setGeoRepository } from '../rollout.service';
import { geoDatasetSchema, runGeoSeed } from '../seed.service';
import { InMemoryGeoRepository } from './in-memory-geo.repository';

const NOW = new Date('2026-09-15T10:00:00Z');

const DATASET = geoDatasetSchema.parse({
  source: 'fixture',
  generatedOn: '2026-09-15',
  states: [{ code: '19', name: 'State of Karnataka', geonameId: 1, lat: 14.75, lng: 76 }],
  districts: [{ stateCode: '19', code: '583', name: 'Bengaluru Urban', geonameId: 11, lat: 13, lng: 77.6 }],
  cities: [
    { geonameId: 101, name: 'Bengaluru', aliases: ['Bangalore'], stateCode: '19', districtCode: '583', lat: 12.97, lng: 77.59, population: 8_495_492, kind: 'STATE_CAPITAL' },
    { geonameId: 102, name: 'Mysuru', aliases: ['Mysore'], stateCode: '19', districtCode: '583', lat: 12.3, lng: 76.65, population: 920_550, kind: 'DISTRICT_HQ' },
  ],
});

const blended = (over: Record<string, unknown> = {}) => ({
  footfall: { daily: 10000, byHour: null, byWeekday: [10, 10, 10, 10, 20, 20, 20] },
  demographics: {
    ageBands: [{ label: '18_24', share: 20 }, { label: '25_34', share: 80 }],
    gender: [{ label: 'male', share: 60 }, { label: 'female', share: 40 }],
    incomeBands: null,
    affinities: null,
  },
  provenance: 'PANEL',
  provenanceByField: { footfall: 'BLENDED', demographics: 'GEOIQ', affinities: null },
  vendor: 'AZIRA',
  vendors: ['GEOIQ', 'AZIRA'],
  agreement: { footfall: 0.9 },
  rawByVendor: {},
  period: '2026-09',
  radiusM: 500,
  fetchedAt: '2026-09-10T00:00:00.000Z',
  ...over,
});

const stored = (spots: { listingId: string; audience: unknown }[]) => ({ vendor: 'AZIRA', vendors: ['GEOIQ', 'AZIRA'], policy: DEFAULT_AUDIENCE_POLICY, spots });

let repo: InMemoryGeoRepository;

beforeEach(async () => {
  vi.clearAllMocks();
  settings.audience = { cityProfileSamplePoints: 0 };
  repo = new InMemoryGeoRepository();
  await runGeoSeed(DATASET, repo);
  setGeoRepository(repo);
  repo.parties.listingsLive.set('bengaluru', [
    { id: 'l1', title: 'A', publisherUserId: 'u1' },
    { id: 'l2', title: 'B', publisherUserId: 'u1' },
    { id: 'l3', title: 'C', publisherUserId: 'u2' },
  ]);
  repo.parties.listingPoints.set('bengaluru', [
    { id: 'l1', latitude: 12.97, longitude: 77.59 },
    { id: 'l2', latitude: 12.99, longitude: 77.61 },
  ]);
  listings.storedAudienceForListings.mockResolvedValue(
    stored([
      { listingId: 'l1', audience: blended() },
      { listingId: 'l2', audience: blended({ footfall: { daily: 30000, byHour: null, byWeekday: null }, demographics: { ageBands: [{ label: '18_24', share: 100 }], gender: null, incomeBands: null, affinities: null }, provenanceByField: { footfall: 'AZIRA', demographics: 'AZIRA', affinities: null }, vendors: ['AZIRA'], agreement: { footfall: null } }) },
      { listingId: 'l3', audience: null },
    ]),
  );
  listings.audienceForSpots.mockResolvedValue(null);
});

afterEach(() => setGeoRepository(null));

describe('the fold', () => {
  it('means the footfall, weights the mixes by footfall, folds the provenance and the agreement', () => {
    const fold = foldCityAudience([
      blended() as never,
      blended({ footfall: { daily: 30000, byHour: null, byWeekday: null }, demographics: { ageBands: [{ label: '18_24', share: 100 }], gender: null, incomeBands: null, affinities: null }, provenanceByField: { footfall: 'AZIRA', demographics: 'AZIRA', affinities: null }, agreement: { footfall: null } }) as never,
    ]);
    expect(fold.footfall.daily).toBe(20000);
    // weekday: only the first carries one — its own profile, whatever its weight.
    expect(fold.footfall.byWeekday).toEqual([10, 10, 10, 10, 20, 20, 20]);
    // age: 10000 × (20/80) and 30000 × (100/0) → 18_24 = (20×1 + 100×3)/4 = 80; 25_34 = 20.
    expect(fold.demographics.ageBands).toEqual([{ label: '18_24', share: 80 }, { label: '25_34', share: 20 }]);
    expect(fold.demographics.gender).toEqual([{ label: 'male', share: 60 }, { label: 'female', share: 40 }]);
    expect(fold.demographics.incomeBands).toBeNull();
    expect(fold.provenanceByField).toEqual({ footfall: 'BLENDED', demographics: 'BLENDED', affinities: null });
    expect(fold.agreement.footfall).toBe(0.9);
  });

  it('a catchment with no daily figure counts as an average one; with no figure anywhere every catchment counts once', () => {
    const noFigure = foldCityAudience([
      blended({ footfall: { daily: 30000, byHour: null, byWeekday: null }, demographics: { ageBands: [{ label: 'a', share: 100 }], gender: null, incomeBands: null, affinities: null } }) as never,
      blended({ footfall: { daily: null, byHour: null, byWeekday: null }, demographics: { ageBands: [{ label: 'b', share: 100 }], gender: null, incomeBands: null, affinities: null } }) as never,
    ]);
    expect(noFigure.footfall.daily).toBe(30000);
    expect(noFigure.demographics.ageBands).toEqual([{ label: 'a', share: 50 }, { label: 'b', share: 50 }]);
    const nothing = foldCityAudience([
      blended({ footfall: { daily: null, byHour: null, byWeekday: null }, demographics: { ageBands: [{ label: 'a', share: 100 }], gender: null, incomeBands: null, affinities: null } }) as never,
      blended({ footfall: { daily: null, byHour: null, byWeekday: null }, demographics: { ageBands: [{ label: 'b', share: 100 }], gender: null, incomeBands: null, affinities: null } }) as never,
    ]);
    expect(nothing.footfall.daily).toBeNull();
    expect(nothing.demographics.ageBands).toEqual([{ label: 'a', share: 50 }, { label: 'b', share: 50 }]);
  });
});

describe('the profile', () => {
  it('is the blend over the stored rows of the city`s live spots — coverage counted, nothing asked of a vendor', async () => {
    const profile = await cityAudienceProfile('bengaluru', '2026-09', NOW);
    expect(listings.storedAudienceForListings).toHaveBeenCalledWith(['l1', 'l2', 'l3'], '2026-09');
    expect(listings.audienceForSpots).not.toHaveBeenCalled();
    expect(profile).toMatchObject({
      city: 'bengaluru',
      period: '2026-09',
      provenance: 'PANEL',
      provider: 'AZIRA',
      vendors: ['GEOIQ', 'AZIRA'],
      policy: DEFAULT_AUDIENCE_POLICY,
      coverage: { spots: 3, withSnapshot: 2, ratio: 0.667 },
      samplePoints: null,
      footfall: { daily: 20000, byHour: null, byWeekday: [10, 10, 10, 10, 20, 20, 20] },
      demographics: { ageBands: [{ label: '18_24', share: 80 }, { label: '25_34', share: 20 }] },
      provenanceByField: { footfall: 'BLENDED', demographics: 'BLENDED', affinities: null },
      agreement: { footfall: 0.9 },
      computedAt: NOW.toISOString(),
    });
    expect(profile.basis).toBe('GEOIQ + AZIRA panels, blended, on 2 of 3 live spots, 2026-09; mixes weighted by footfall');
  });

  it('defaults the period to this month and is cached a minute per (city, period)', async () => {
    await cityAudienceProfile('bengaluru', undefined, NOW);
    expect(cache.readThrough).toHaveBeenCalledWith(cityAudienceCacheKey('bengaluru', '2026-09'), CITY_AUDIENCE_CACHE_TTL_S, expect.any(Function));
    expect(CITY_AUDIENCE_CACHE_TTL_S).toBe(60);
    expect(cityAudienceCacheKey('mysuru', '2026-08')).toBe('geo:city-audience:mysuru:2026-08');
  });

  it('says so with nothing enabled, with no stored panel, and is 404 for a city that does not exist', async () => {
    listings.storedAudienceForListings.mockResolvedValue(null);
    const none = await cityAudienceProfile('bengaluru', '2026-09', NOW);
    expect(none).toMatchObject({ provider: 'NONE', vendors: [], policy: null, coverage: { spots: 3, withSnapshot: 0, ratio: 0 }, footfall: { daily: null }, basis: 'No audience vendor is configured' });

    listings.storedAudienceForListings.mockResolvedValue(stored([{ listingId: 'l1', audience: null }, { listingId: 'l2', audience: null }, { listingId: 'l3', audience: null }]));
    const empty = await cityAudienceProfile('bengaluru', '2026-09', NOW);
    expect(empty).toMatchObject({ vendors: ['GEOIQ', 'AZIRA'], coverage: { spots: 3, withSnapshot: 0, ratio: 0 }, footfall: { daily: null }, provenanceByField: { footfall: null, demographics: null, affinities: null } });
    expect(empty.basis).toBe('GEOIQ + AZIRA have no stored panel for any of the 3 live spots in 2026-09');

    await expect(cityAudienceProfile('nowhere', '2026-09', NOW)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the sample points', () => {
  it('are off by default: no grid, no vendor call, `samplePoints` null', async () => {
    const profile = await cityAudienceProfile('bengaluru', '2026-09', NOW);
    expect(profile.samplePoints).toBeNull();
    expect(listings.audienceForSpots).not.toHaveBeenCalled();
  });

  it('on, ask a grid across the listings` box under synthetic keys through the snapshot read, and fold in with the spots', async () => {
    settings.audience = { cityProfileSamplePoints: 4 };
    listings.audienceForSpots.mockResolvedValue({
      vendor: 'AZIRA',
      vendors: ['GEOIQ', 'AZIRA'],
      policy: DEFAULT_AUDIENCE_POLICY,
      spots: [
        { listingId: sampleKey('bengaluru', 0), audience: blended({ footfall: { daily: 20000, byHour: null, byWeekday: null } }) },
        { listingId: sampleKey('bengaluru', 1), audience: null },
        { listingId: sampleKey('bengaluru', 2), audience: blended({ footfall: { daily: 20000, byHour: null, byWeekday: null } }) },
        { listingId: sampleKey('bengaluru', 3), audience: null },
      ],
    });
    const profile = await cityAudienceProfile('bengaluru', '2026-09', NOW);
    expect(listings.audienceForSpots).toHaveBeenCalledTimes(1);
    const [points, period] = listings.audienceForSpots.mock.calls[0]! as [{ listingId: string; latitude: number; longitude: number }[], string];
    expect(period).toBe('2026-09');
    expect(points.map((p) => p.listingId)).toEqual(['city:bengaluru:0', 'city:bengaluru:1', 'city:bengaluru:2', 'city:bengaluru:3']);
    // The 2 × 2 grid spans the two placed listings' box, corners inclusive.
    expect(points).toEqual([
      { listingId: 'city:bengaluru:0', latitude: 12.97, longitude: 77.59 },
      { listingId: 'city:bengaluru:1', latitude: 12.97, longitude: 77.61 },
      { listingId: 'city:bengaluru:2', latitude: 12.99, longitude: 77.59 },
      { listingId: 'city:bengaluru:3', latitude: 12.99, longitude: 77.61 },
    ]);
    expect(profile.samplePoints).toEqual({ configured: 4, asked: 4, withSnapshot: 2 });
    // The spots' coverage is the spots' alone; the fold is over spots and sample points: (10000 + 30000 + 20000 + 20000) / 4.
    expect(profile.coverage).toEqual({ spots: 3, withSnapshot: 2, ratio: 0.667 });
    expect(profile.footfall.daily).toBe(20000);
    expect(profile.basis).toBe('GEOIQ + AZIRA panels, blended, on 2 of 3 live spots and 2 of 4 sample points, 2026-09; mixes weighted by footfall');
  });

  it('with no placed listing the grid spans a 3 km circle around the city point; with no point at all nothing is asked', async () => {
    settings.audience = { cityProfileSamplePoints: 1 };
    listings.storedAudienceForListings.mockResolvedValue(stored([]));
    listings.audienceForSpots.mockResolvedValue({ vendor: 'AZIRA', vendors: ['GEOIQ', 'AZIRA'], policy: DEFAULT_AUDIENCE_POLICY, spots: [{ listingId: 'city:mysuru:0', audience: null }] });
    await cityAudienceProfile('mysuru', '2026-09', NOW);
    const [points] = listings.audienceForSpots.mock.calls[0]! as [{ listingId: string; latitude: number; longitude: number }[]];
    expect(points).toHaveLength(1);
    expect(points[0]!.latitude).toBeCloseTo(12.3, 5);
    expect(points[0]!.longitude).toBeCloseTo(76.65, 5);

    const box = sampleBox([], { latitude: 12.3, longitude: 76.65 })!;
    expect(box.maxLat - box.minLat).toBeCloseTo(6000 / 111_320, 6);
    expect(sampleBox([{ id: 'x', latitude: null, longitude: null }], { latitude: null, longitude: null })).toBeNull();

    vi.clearAllMocks();
    const city = (await repo.findCityBySlug('mysuru'))!;
    await repo.updateCity(city.id, { latitude: null, longitude: null });
    listings.storedAudienceForListings.mockResolvedValue(stored([]));
    const profile = await cityAudienceProfile('mysuru', '2026-09', NOW);
    expect(listings.audienceForSpots).not.toHaveBeenCalled();
    expect(profile.samplePoints).toEqual({ configured: 1, asked: 0, withSnapshot: 0 });
  });

  it('the grid is deterministic: k × k for ceil √n points, the first n, a single point the centre', () => {
    const box = { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 };
    expect(sampleGrid(box, 1)).toEqual([{ latitude: 0.5, longitude: 0.5 }]);
    expect(sampleGrid(box, 4)).toEqual([
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
      { latitude: 1, longitude: 0 },
      { latitude: 1, longitude: 1 },
    ]);
    expect(sampleGrid(box, 5)).toHaveLength(5);
    expect(sampleGrid(box, 9)[4]).toEqual({ latitude: 0.5, longitude: 0.5 });
    expect(sampleGrid(box, 0)).toEqual([]);
  });

  it('a vendor failure on the grid is no failure of the profile', async () => {
    settings.audience = { cityProfileSamplePoints: 2 };
    listings.audienceForSpots.mockRejectedValue(new Error('vendor down'));
    const profile = await cityAudienceProfile('bengaluru', '2026-09', NOW);
    expect(profile.samplePoints).toEqual({ configured: 2, asked: 2, withSnapshot: 0 });
    expect(profile.footfall.daily).toBe(20000);
  });
});

describe('readiness', () => {
  it('gains the soft `audience` check — never counted in `ready`, a failed read a detail', async () => {
    const city = (await repo.findCityBySlug('bengaluru'))!;
    repo.rateCards.push({ cityId: city.id, name: 'Bengaluru card v1' });
    repo.parties.agents.set('bengaluru', [
      { userId: 'a1', side: 'publisher' },
      { userId: 'a2', side: 'advertiser' },
    ]);
    const withPanels = await cityReadiness('bengaluru', NOW);
    expect(withPanels.ready).toBe(true);
    expect(withPanels.checks.find((c) => c.key === 'audience')).toEqual({
      key: 'audience',
      ok: true,
      soft: true,
      detail: 'GEOIQ + AZIRA panels, blended, on 2 of 3 live spots, 2026-09; mixes weighted by footfall (soft: never blocks a launch)',
    });

    listings.storedAudienceForListings.mockResolvedValue(null);
    const none = await cityReadiness('bengaluru', NOW);
    expect(none.ready).toBe(true);
    expect(none.checks.find((c) => c.key === 'audience')).toMatchObject({ ok: false, soft: true, detail: 'No audience vendor is configured (soft: never blocks a launch)' });

    listings.storedAudienceForListings.mockRejectedValue(new Error('rows unreadable'));
    const failed = await cityReadiness('bengaluru', NOW);
    expect(failed.ready).toBe(true);
    expect(failed.checks.find((c) => c.key === 'audience')).toMatchObject({ ok: false, soft: true, detail: 'Audience data unavailable: rows unreadable (soft: never blocks a launch)' });
  });
});
