import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The wind-down of a withdrawn city — Lot V.
 *
 * Four duties, each through the owning module's own door: the live
 * listings off the market (`listings.unpublishListing`, cause
 * CITY_WITHDRAWN) with each publisher told once; campaigns left alone; the
 * open leads LOST through `leads`; the agents told. Then the marker event,
 * which is what makes a second tick do nothing — and a fresh withdrawal
 * after a re-entry is walked again.
 */

const { listings, leads, notifications, audit } = vi.hoisted(() => ({
  listings: { unpublishListing: vi.fn() },
  leads: { closeOpenLeadsInCity: vi.fn() },
  notifications: { notify: vi.fn() },
  audit: { logActivity: vi.fn() },
}));
vi.mock('../../listings', () => listings);
vi.mock('../../leads', () => leads);
vi.mock('../../notifications', () => notifications);
vi.mock('../../app-config', () => ({ getPlatformSettings: async () => ({ geo: { launchMinListings: 10, launchNeedsPrintPartner: false, comingSoonWaitlist: true } }) }));
vi.mock('../../../shared/audit', () => audit);

import { WIND_DOWN_MARK } from '../prisma-geo.repository';
import { changeRollout, setGeoRepository } from '../rollout.service';
import { runCityWindDown, setWindDownRepository } from '../winddown.service';
import { runGeoSeed, geoDatasetSchema } from '../seed.service';
import { InMemoryGeoRepository } from './in-memory-geo.repository';

const NOW = new Date('2026-09-15T10:00:00Z');
const DATASET = geoDatasetSchema.parse({
  source: 'fixture',
  generatedOn: '2026-09-15',
  states: [{ code: '19', name: 'State of Karnataka', geonameId: 1, lat: 14.75, lng: 76 }],
  districts: [],
  cities: [
    { geonameId: 101, name: 'Bengaluru', aliases: ['Bangalore'], stateCode: '19', districtCode: null, lat: 12.97, lng: 77.59, population: 8_495_492, kind: 'STATE_CAPITAL' },
    { geonameId: 102, name: 'Mysuru', aliases: ['Mysore'], stateCode: '19', districtCode: null, lat: 12.3, lng: 76.65, population: 920_550, kind: 'DISTRICT_HQ' },
  ],
});

let repo: InMemoryGeoRepository;

beforeEach(async () => {
  vi.clearAllMocks();
  repo = new InMemoryGeoRepository();
  await runGeoSeed(DATASET, repo);
  setGeoRepository(repo);
  setWindDownRepository(repo);
  // The listings module takes the row INACTIVE; here that is the row leaving the live set.
  listings.unpublishListing.mockImplementation(async (id: string) => {
    for (const [key, rows] of repo.parties.listingsLive) repo.parties.listingsLive.set(key, rows.filter((row) => row.id !== id));
    return { id, status: 'INACTIVE' };
  });
  leads.closeOpenLeadsInCity.mockResolvedValue(['lead_1', 'lead_2']);
  notifications.notify.mockResolvedValue({ notificationId: 'n', templateKey: 'city-withdrawn', deliveries: [] });
  repo.parties.listingsLive.set('bengaluru', [
    { id: 'l1', title: 'MG Road', publisherUserId: 'pub_u1' },
    { id: 'l2', title: 'Brigade Road', publisherUserId: 'pub_u1' },
  ]);
  repo.parties.listingsLive.set('bangalore', [{ id: 'l3', title: 'Old spelling', publisherUserId: 'pub_u2' }]);
  // Lot X-B: a row keyed to the city, typed as something the spellings would never match.
  const bengaluru = repo.cities.find((c) => c.slug === 'bengaluru')!;
  repo.parties.listingsLive.set(`id:${bengaluru.id}`, [{ id: 'l4', title: 'Keyed, typed "Blr"', publisherUserId: 'pub_u1' }]);
  repo.parties.agents.set('bengaluru', [
    { userId: 'agent_u1', side: 'publisher' },
    { userId: 'agent_u2', side: 'advertiser' },
  ]);
  await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', NOW);
});

afterEach(() => {
  setGeoRepository(null);
  setWindDownRepository(null);
});

describe('the four duties', () => {
  it('does nothing while no city is withdrawn', async () => {
    expect(await runCityWindDown('sys', NOW)).toEqual([]);
    expect(listings.unpublishListing).not.toHaveBeenCalled();
  });

  it('takes every live listing down through listings, closes the leads, tells each publisher and agent once, and marks the city', async () => {
    await changeRollout('bengaluru', { stage: 'WITHDRAWN', note: 'Out' }, 'admin-1', new Date('2026-09-16T00:00:00Z'));
    const out = await runCityWindDown('sys', new Date('2026-09-16T01:00:00Z'));

    expect(out).toEqual([{ city: 'bengaluru', listingsUnpublished: 4, listingsFailed: 0, publishersTold: 2, leadsClosed: 2, agentsTold: 2 }]);
    // 1. the listings — by key (l4, typed as nothing the spellings match) and by alias spelling (l3, no key) — each with the cause
    expect(listings.unpublishListing).toHaveBeenCalledTimes(4);
    expect(listings.unpublishListing).toHaveBeenCalledWith('l1', { reason: 'ADX has withdrawn from Bengaluru.', actorUserId: 'sys', cause: 'CITY_WITHDRAWN' });
    expect(listings.unpublishListing).toHaveBeenCalledWith('l3', expect.objectContaining({ cause: 'CITY_WITHDRAWN' }));
    expect(listings.unpublishListing).toHaveBeenCalledWith('l4', expect.objectContaining({ cause: 'CITY_WITHDRAWN' }));
    // 3. the leads, by key with every spelling as the fallback
    const bengaluru = repo.cities.find((c) => c.slug === 'bengaluru')!;
    expect(leads.closeOpenLeadsInCity).toHaveBeenCalledWith({ cityId: bengaluru.id, spellings: expect.arrayContaining(['Bengaluru', 'bangalore']) }, 'sys');
    // 1 + 4. the people: two publishers (one with two listings) and two agents, CITY_WITHDRAWN each, once
    const told = notifications.notify.mock.calls.map((call) => [call[0], call[1], call[2]]);
    expect(told).toHaveLength(4);
    expect(told).toContainEqual(['CITY_WITHDRAWN', 'pub_u1', { city: 'Bengaluru', detail: expect.stringContaining('3 of your listings in Bengaluru were taken off the market') }]);
    expect(told).toContainEqual(['CITY_WITHDRAWN', 'pub_u2', { city: 'Bengaluru', detail: expect.stringContaining('1 of your listing in Bengaluru was taken') }]);
    expect(told).toContainEqual(['CITY_WITHDRAWN', 'agent_u1', { city: 'Bengaluru', detail: expect.stringContaining('No new work will be offered in Bengaluru') }]);
    expect(notifications.notify.mock.calls[0]![3]).toMatchObject({ type: 'SYSTEM', inApp: { type: 'SYSTEM', subtitle: 'Bengaluru' } });
    // the marker and the audit row
    const mark = repo.events.find((e) => e.note === WIND_DOWN_MARK)!;
    expect(mark).toMatchObject({ fromStage: 'WITHDRAWN', toStage: 'WITHDRAWN', byUserId: 'sys', flags: { winddown: { listingsUnpublished: 4 } } });
    expect(audit.logActivity).toHaveBeenCalledWith('sys', 'CITY_WOUND_DOWN', expect.objectContaining({ module: 'geo', targetId: 'bengaluru' }));
  });

  it('is idempotent: a second tick finds the marker and does nothing; a fresh withdrawal after re-entry is walked again', async () => {
    await changeRollout('bengaluru', { stage: 'WITHDRAWN' }, 'admin-1', new Date('2026-09-16T00:00:00Z'));
    await runCityWindDown('sys', new Date('2026-09-16T01:00:00Z'));
    vi.clearAllMocks();
    notifications.notify.mockResolvedValue({ notificationId: 'n', templateKey: 'city-withdrawn', deliveries: [] });
    leads.closeOpenLeadsInCity.mockResolvedValue([]);

    expect(await runCityWindDown('sys', new Date('2026-09-16T02:00:00Z'))).toEqual([]);
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(leads.closeOpenLeadsInCity).not.toHaveBeenCalled();
    expect(repo.events.filter((e) => e.note === WIND_DOWN_MARK)).toHaveLength(1);

    // Re-entry republishes nothing: the live set stays empty, no listings call.
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', new Date('2026-10-01T00:00:00Z'));
    expect(listings.unpublishListing).not.toHaveBeenCalled();
    expect((await repo.activeListings({ cityId: repo.cities.find((c) => c.slug === 'bengaluru')!.id, spellings: ['Bengaluru', 'bangalore'] }))).toEqual([]);

    // Withdrawn again later: walked again, with a second marker.
    await changeRollout('bengaluru', { stage: 'WITHDRAWN' }, 'admin-1', new Date('2026-11-01T00:00:00Z'));
    const again = await runCityWindDown('sys', new Date('2026-11-01T01:00:00Z'));
    expect(again).toEqual([{ city: 'bengaluru', listingsUnpublished: 0, listingsFailed: 0, publishersTold: 0, leadsClosed: 0, agentsTold: 2 }]);
    expect(repo.events.filter((e) => e.note === WIND_DOWN_MARK)).toHaveLength(2);
  });

  it('a listing the listings module refuses is counted as failed and the rest go on', async () => {
    listings.unpublishListing.mockRejectedValueOnce(new Error('not live'));
    await changeRollout('bengaluru', { stage: 'WITHDRAWN' }, 'admin-1', NOW);
    const [out] = await runCityWindDown('sys', NOW);
    expect(out).toMatchObject({ listingsUnpublished: 3, listingsFailed: 1 });
  });

  it('a notice that cannot be sent does not stop the wind-down', async () => {
    notifications.notify.mockRejectedValue(new Error('smtp down'));
    await changeRollout('bengaluru', { stage: 'WITHDRAWN' }, 'admin-1', NOW);
    const [out] = await runCityWindDown('sys', NOW);
    expect(out).toMatchObject({ listingsUnpublished: 4, publishersTold: 2, agentsTold: 2 });
    expect(repo.events.some((e) => e.note === WIND_DOWN_MARK)).toBe(true);
  });

  it('PAUSED has no wind-down', async () => {
    await changeRollout('bengaluru', { stage: 'PAUSED' }, 'admin-1', NOW);
    expect(await runCityWindDown('sys', NOW)).toEqual([]);
    expect(listings.unpublishListing).not.toHaveBeenCalled();
  });
});

describe('the rows the wind-down finds (Lot X-B)', () => {
  it('finds a row typed under a spelling with no key, and a row keyed to the city typed as anything — and leaves another city alone', async () => {
    const bengaluru = repo.cities.find((c) => c.slug === 'bengaluru')!;
    const mysuru = repo.cities.find((c) => c.slug === 'mysuru')!;
    repo.parties.listingsLive.clear();
    repo.parties.agents.clear();
    repo.parties.listingsLive.set('bengaluru urban', [{ id: 'typed', title: 'Typed only, no key', publisherUserId: 'pub_t' }]);
    repo.parties.listingsLive.set(`id:${bengaluru.id}`, [{ id: 'keyed', title: 'Keyed, typed "Blr"', publisherUserId: 'pub_k' }]);
    repo.parties.listingsLive.set(`id:${mysuru.id}`, [{ id: 'elsewhere', title: 'Mysuru', publisherUserId: 'pub_m' }]);
    // "bengaluru urban" is not yet a spelling of the city: the typed-only row is invisible until the alias is taught.
    await changeRollout('bengaluru', { stage: 'WITHDRAWN' }, 'admin-1', NOW);
    let [out] = await runCityWindDown('sys', NOW);
    expect(out).toMatchObject({ listingsUnpublished: 1 });
    expect(listings.unpublishListing).toHaveBeenCalledWith('keyed', expect.anything());
    expect(listings.unpublishListing).not.toHaveBeenCalledWith('elsewhere', expect.anything());

    // The alias taught (geo's own row, the way `pricing.updateCity` would leave it): a fresh withdrawal finds the typed row by its spelling.
    await repo.updateCity(bengaluru.id, { aliases: ['bangalore', 'bengaluru-urban'] });
    await changeRollout('bengaluru', { stage: 'LAUNCHED' }, 'admin-1', new Date('2026-10-01T00:00:00Z'));
    await changeRollout('bengaluru', { stage: 'WITHDRAWN' }, 'admin-1', new Date('2026-11-01T00:00:00Z'));
    [out] = await runCityWindDown('sys', new Date('2026-11-01T01:00:00Z'));
    expect(out).toMatchObject({ listingsUnpublished: 1 });
    expect(listings.unpublishListing).toHaveBeenCalledWith('typed', expect.anything());
  });
});
