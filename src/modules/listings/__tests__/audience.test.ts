import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G7 (Q109) / Y-B — the audience panel for a spot.
 *
 * What is pinned: who may read it (ADX, the publisher's side, an advertiser
 * who has the spot in a non-draft campaign — nobody else); that each vendor
 * is asked ONCE per (listing, vendor, month) and every later read is the
 * stored row; that the snapshot expires a week past the end of its month
 * and is then refetched; that nothing enabled answers a null panel with a
 * reason rather than an error; that the campaign-side fold never throws on
 * a vendor failure. Y-B: one row PER VENDOR; only the vendor lacking a
 * fresh row is asked; the blend is made at read time from the rows, so a
 * policy change re-blends with no vendor call; a vendor enabled later
 * fills in on the next read; one vendor's failure keeps the other's answer;
 * `storedAudienceForListings` folds the rows and calls nobody.
 */

const { repository, integrations, vendors, agents, grants } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findWithPublisher: vi.fn(),
    findAudienceSnapshot: vi.fn(),
    findAudienceSnapshots: vi.fn(),
    upsertAudienceSnapshot: vi.fn(),
    advertiserHasSpot: vi.fn(),
  },
  integrations: { getEffectiveAudienceConfig: vi.fn() },
  vendors: { geoiq: vi.fn(), azira: vi.fn() },
  agents: { findAgentProfile: vi.fn() },
  grants: { holdsLiveGrant: vi.fn() },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...integrations };
});
// The seam runs for real; only the two HTTP adapters are stubbed.
vi.mock('../../../shared/audience/geoiq', () => ({ geoiqAudienceProvider: { name: 'GEOIQ', catchment: vendors.geoiq }, geoiqCatchment: vendors.geoiq }));
vi.mock('../../../shared/audience/azira', () => ({ aziraAudienceProvider: { name: 'AZIRA', catchment: vendors.azira }, aziraCatchment: vendors.azira }));
vi.mock('../../agents', () => agents);
vi.mock('../../access-grants', () => grants);
vi.mock('../../pricing', () => ({ classifySpot: vi.fn(), activeSurge: vi.fn() }));

import { ApiError } from '../../../shared/errors';
import { DEFAULT_AUDIENCE_POLICY, resolveAudiencePolicy } from '../../../shared/integrations';
import { audienceForSpots, currentPeriod, listingAudience, snapshotExpiry, storedAudienceForListings } from '../audience.service';

const GEOIQ_PANEL = {
  footfall: { daily: 18421, byHour: null, byWeekday: null },
  demographics: {
    ageBands: [{ label: '18_24', share: 21 }],
    gender: [{ label: 'male', share: 53 }, { label: 'female', share: 47 }],
    incomeBands: null,
    affinities: null,
  },
  provenance: 'PANEL',
  vendor: 'GEOIQ',
  period: '2026-09',
  radiusM: 500,
  fetchedAt: '2026-09-14T00:00:00.000Z',
};

const AZIRA_PANEL = {
  footfall: { daily: 21340, byHour: null, byWeekday: [13, 13, 13, 14, 15, 17, 15] },
  demographics: {
    ageBands: [{ label: '18-24', share: 19 }],
    gender: [{ label: 'male', share: 55 }, { label: 'female', share: 45 }],
    incomeBands: null,
    affinities: [{ label: 'Dining', share: 41 }],
  },
  provenance: 'PANEL',
  vendor: 'AZIRA',
  period: '2026-09',
  radiusM: 500,
  fetchedAt: '2026-09-14T00:00:00.000Z',
};

const config = (providers: string[], policy: Record<string, unknown> = {}) => ({
  provider: providers.length === 0 ? 'NONE' : providers.includes('AZIRA') ? 'AZIRA' : providers[0],
  providers,
  policy: resolveAudiencePolicy(policy as never),
  geoiqVariables: {},
  catchmentRadiusM: 500,
});

const listing = (over: Record<string, unknown> = {}) => ({ id: 'lst_1', latitude: 12.9758, longitude: 77.6061, ...over });

const storedRow = (vendor: string, data: unknown, expiresAt = new Date(Date.now() + 86_400_000)) => ({
  id: `snap_${vendor}`,
  listingId: 'lst_1',
  vendor,
  period: '2026-09',
  data,
  fetchedAt: new Date(),
  expiresAt,
});

const ADMIN = { userId: 'usr_ops', isAdmin: true, advertiserId: null };
const PUBLISHER = { userId: 'usr_publisher', isAdmin: false, advertiserId: null };
const ADVERTISER = { userId: 'usr_advertiser', isAdmin: false, advertiserId: 'adv_1' };
const STRANGER = { userId: 'usr_other', isAdmin: false, advertiserId: null };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue(listing());
  repository.findWithPublisher.mockResolvedValue({ id: 'lst_1', publisher: { id: 'pub_1', userId: 'usr_publisher', agentId: 'agt_1' } });
  repository.findAudienceSnapshot.mockResolvedValue(null);
  repository.findAudienceSnapshots.mockResolvedValue([]);
  repository.upsertAudienceSnapshot.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'snap_1', fetchedAt: new Date(), ...input }));
  repository.advertiserHasSpot.mockResolvedValue(false);
  agents.findAgentProfile.mockResolvedValue(null);
  grants.holdsLiveGrant.mockResolvedValue(false);
  integrations.getEffectiveAudienceConfig.mockResolvedValue(config(['GEOIQ']));
  vendors.geoiq.mockResolvedValue(GEOIQ_PANEL);
  vendors.azira.mockResolvedValue(AZIRA_PANEL);
});

describe('who may read a spot`s audience', () => {
  it('ADX, without reading the listing`s publisher', async () => {
    await expect(listingAudience('lst_1', '2026-09', ADMIN)).resolves.toMatchObject({ provider: 'GEOIQ', providers: ['GEOIQ'] });
    expect(repository.findWithPublisher).not.toHaveBeenCalled();
  });

  it('the publisher of the listing', async () => {
    await expect(listingAudience('lst_1', '2026-09', PUBLISHER)).resolves.toMatchObject({ audience: expect.objectContaining({ footfall: GEOIQ_PANEL.footfall }) });
  });

  it('an advertiser who has the spot in a campaign — and not one who merely browsed it', async () => {
    await expect(listingAudience('lst_1', '2026-09', ADVERTISER)).rejects.toMatchObject({ statusCode: 403 });
    repository.advertiserHasSpot.mockResolvedValue(true);
    await expect(listingAudience('lst_1', '2026-09', ADVERTISER)).resolves.toMatchObject({ audience: expect.objectContaining({ vendor: 'GEOIQ' }) });
    expect(repository.advertiserHasSpot).toHaveBeenCalledWith('adv_1', 'lst_1');
  });

  it('nobody else', async () => {
    await expect(listingAudience('lst_1', '2026-09', STRANGER)).rejects.toMatchObject({ statusCode: 403 });
    expect(vendors.geoiq).not.toHaveBeenCalled();
  });

  it('is 404 for a listing that does not exist, before any access question', async () => {
    repository.findById.mockResolvedValue(null);
    await expect(listingAudience('lst_x', '2026-09', STRANGER)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('one vendor call per (listing, vendor, month)', () => {
  it('asks the vendor and stores its RAW answer until a week past the end of the month; the read is the blended shape', async () => {
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(vendors.geoiq).toHaveBeenCalledWith(12.9758, 77.6061, 500, '2026-09');
    expect(repository.upsertAudienceSnapshot).toHaveBeenCalledWith({
      listingId: 'lst_1',
      vendor: 'GEOIQ',
      period: '2026-09',
      data: GEOIQ_PANEL,
      expiresAt: new Date('2026-10-08T00:00:00.000Z'),
    });
    expect(read).toMatchObject({ listingId: 'lst_1', period: '2026-09', provider: 'GEOIQ', providers: ['GEOIQ'], cached: false, unavailable: [] });
    expect(read.audience).toMatchObject({
      ...GEOIQ_PANEL,
      provenanceByField: { footfall: 'GEOIQ', demographics: 'GEOIQ', affinities: null },
      vendors: ['GEOIQ'],
      agreement: { footfall: null },
      rawByVendor: { GEOIQ: GEOIQ_PANEL },
    });
    expect(read.basis).toContain('GEOIQ panel for the 500 m catchment, 2026-09');
  });

  it('reads the stored snapshot and never calls the vendor again while it lives', async () => {
    repository.findAudienceSnapshot.mockResolvedValue(storedRow('GEOIQ', GEOIQ_PANEL));
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(vendors.geoiq).not.toHaveBeenCalled();
    expect(read).toMatchObject({ audience: expect.objectContaining({ rawByVendor: { GEOIQ: GEOIQ_PANEL } }), cached: true });
    expect(read.basis).toContain('(stored)');
  });

  it('refetches once the snapshot has expired', async () => {
    repository.findAudienceSnapshot.mockResolvedValue({ ...storedRow('GEOIQ', GEOIQ_PANEL, new Date(Date.now() - 1000)), period: '2026-08' });
    await listingAudience('lst_1', '2026-08', ADMIN);
    expect(vendors.geoiq).toHaveBeenCalledTimes(1);
    expect(repository.upsertAudienceSnapshot).toHaveBeenCalled();
  });

  it('does not store "nothing there" — the vendor is asked again next time', async () => {
    vendors.geoiq.mockResolvedValue(null);
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(read.audience).toBeNull();
    expect(read.basis).toBe('GEOIQ has no panel for this catchment in 2026-09');
    expect(repository.upsertAudienceSnapshot).not.toHaveBeenCalled();
  });

  it('keys the snapshot by vendor: switching to Azira asks Azira, not GeoIQ`s row', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(config(['AZIRA']));
    await listingAudience('lst_1', '2026-09', ADMIN);
    expect(repository.findAudienceSnapshot).toHaveBeenCalledWith('lst_1', 'AZIRA', '2026-09');
    expect(repository.findAudienceSnapshot).not.toHaveBeenCalledWith('lst_1', 'GEOIQ', '2026-09');
    expect(vendors.azira).toHaveBeenCalledTimes(1);
    expect(vendors.geoiq).not.toHaveBeenCalled();
  });

  it('defaults the period to this month', async () => {
    const read = await listingAudience('lst_1', undefined, ADMIN);
    expect(read.period).toBe(currentPeriod());
    expect(snapshotExpiry('2026-12')).toEqual(new Date('2027-01-08T00:00:00.000Z'));
  });
});

describe('Y-B: both vendors, one row each', () => {
  beforeEach(() => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(config(['GEOIQ', 'AZIRA']));
  });

  it('asks both, stores one row per vendor, and answers the blend by the default policy', async () => {
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(vendors.geoiq).toHaveBeenCalledTimes(1);
    expect(vendors.azira).toHaveBeenCalledTimes(1);
    expect(repository.upsertAudienceSnapshot).toHaveBeenCalledTimes(2);
    expect(repository.upsertAudienceSnapshot).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'GEOIQ', data: GEOIQ_PANEL }));
    expect(repository.upsertAudienceSnapshot).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'AZIRA', data: AZIRA_PANEL }));
    expect(read.provider).toBe('AZIRA');
    expect(read.providers).toEqual(['GEOIQ', 'AZIRA']);
    expect(read.audience).toMatchObject({
      footfall: { daily: Math.round((18421 + 21340) / 2), byHour: null, byWeekday: AZIRA_PANEL.footfall.byWeekday },
      demographics: { ageBands: GEOIQ_PANEL.demographics.ageBands, gender: GEOIQ_PANEL.demographics.gender, incomeBands: null, affinities: AZIRA_PANEL.demographics.affinities },
      provenanceByField: { footfall: 'BLENDED', demographics: 'GEOIQ', affinities: 'AZIRA' },
      vendors: ['GEOIQ', 'AZIRA'],
      rawByVendor: { GEOIQ: GEOIQ_PANEL, AZIRA: AZIRA_PANEL },
    });
    expect(read.audience?.agreement.footfall).toBeCloseTo(1 - (21340 - 18421) / 21340, 3);
    expect(read.basis).toContain('GEOIQ + AZIRA panels, blended, for the 500 m catchment, 2026-09');
    expect(read.cached).toBe(false);
  });

  it('asks only the vendor that lacks a fresh row; a vendor enabled later fills in on the next read', async () => {
    repository.findAudienceSnapshot.mockImplementation(async (_id: string, vendor: string) => (vendor === 'GEOIQ' ? storedRow('GEOIQ', GEOIQ_PANEL) : null));
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(vendors.geoiq).not.toHaveBeenCalled();
    expect(vendors.azira).toHaveBeenCalledTimes(1);
    expect(repository.upsertAudienceSnapshot).toHaveBeenCalledTimes(1);
    expect(repository.upsertAudienceSnapshot).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'AZIRA' }));
    expect(read.audience?.vendors).toEqual(['GEOIQ', 'AZIRA']);
    expect(read.cached).toBe(false);
  });

  it('re-blends from the rows on a policy change with NO vendor call', async () => {
    repository.findAudienceSnapshot.mockImplementation(async (_id: string, vendor: string) => storedRow(vendor, vendor === 'GEOIQ' ? GEOIQ_PANEL : AZIRA_PANEL));
    const averaged = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(averaged.audience?.footfall.daily).toBe(Math.round((18421 + 21340) / 2));
    expect(averaged.audience?.demographics.ageBands).toEqual(GEOIQ_PANEL.demographics.ageBands);

    integrations.getEffectiveAudienceConfig.mockResolvedValue(config(['GEOIQ', 'AZIRA'], { footfall: { blend: 'PRIMARY' }, demographics: { primary: 'AZIRA' } }));
    const swapped = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(swapped.audience?.footfall.daily).toBe(21340);
    expect(swapped.audience?.demographics.ageBands).toEqual(AZIRA_PANEL.demographics.ageBands);
    expect(swapped.audience?.provenanceByField).toEqual({ footfall: 'AZIRA', demographics: 'AZIRA', affinities: 'AZIRA' });
    expect(swapped.cached).toBe(true);
    expect(vendors.geoiq).not.toHaveBeenCalled();
    expect(vendors.azira).not.toHaveBeenCalled();
    expect(repository.upsertAudienceSnapshot).not.toHaveBeenCalled();
  });

  it('one vendor`s failure keeps the other`s answer, named in `unavailable`; a vendor with no credentials is skipped', async () => {
    vendors.azira.mockRejectedValue(new ApiError(429, 'TOO_MANY_REQUESTS', 'Azira rate limit reached.'));
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(read.audience?.vendors).toEqual(['GEOIQ']);
    expect(read.audience?.footfall.daily).toBe(18421);
    expect(read.unavailable).toEqual([{ vendor: 'AZIRA', reason: 'Azira rate limit reached.' }]);
    expect(repository.upsertAudienceSnapshot).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    repository.findById.mockResolvedValue(listing());
    repository.findAudienceSnapshot.mockResolvedValue(null);
    integrations.getEffectiveAudienceConfig.mockResolvedValue(config(['GEOIQ', 'AZIRA']));
    vendors.geoiq.mockResolvedValue(GEOIQ_PANEL);
    vendors.azira.mockRejectedValue(new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Azira is not configured.'));
    const skipped = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(skipped.audience?.vendors).toEqual(['GEOIQ']);
    expect(skipped.unavailable).toEqual([{ vendor: 'AZIRA', reason: 'not configured' }]);
  });

  it('a vendor disabled later is left out of the blend though its row stays', async () => {
    repository.findAudienceSnapshot.mockImplementation(async (_id: string, vendor: string) => storedRow(vendor, vendor === 'GEOIQ' ? GEOIQ_PANEL : AZIRA_PANEL));
    integrations.getEffectiveAudienceConfig.mockResolvedValue(config(['GEOIQ']));
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(read.audience?.vendors).toEqual(['GEOIQ']);
    expect(repository.findAudienceSnapshot).not.toHaveBeenCalledWith('lst_1', 'AZIRA', '2026-09');
  });
});

describe('when nothing backs a figure', () => {
  it('nothing enabled is a null panel with the reason, not an error — and the access rule still applies', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(config([]));
    await expect(listingAudience('lst_1', '2026-09', STRANGER)).rejects.toMatchObject({ statusCode: 403 });
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(read).toEqual({
      listingId: 'lst_1',
      period: '2026-09',
      provider: 'NONE',
      providers: [],
      audience: null,
      basis: 'No audience vendor is configured',
      cached: false,
      unavailable: [],
    });
    expect(vendors.geoiq).not.toHaveBeenCalled();
  });

  it('a spot with no coordinates is a null panel with the reason', async () => {
    repository.findById.mockResolvedValue(listing({ latitude: null, longitude: null }));
    const read = await listingAudience('lst_1', '2026-09', ADMIN);
    expect(read).toMatchObject({ provider: 'GEOIQ', audience: null, basis: 'This spot has no coordinates yet' });
    expect(vendors.geoiq).not.toHaveBeenCalled();
  });

  it('the vendor`s own failure is the caller`s to see on the direct read when nobody answered', async () => {
    vendors.geoiq.mockRejectedValue(new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'GeoIQ is not configured.'));
    await expect(listingAudience('lst_1', '2026-09', ADMIN)).rejects.toMatchObject({ statusCode: 503 });
    vendors.geoiq.mockRejectedValue(new ApiError(502, 'INTERNAL_ERROR', 'GeoIQ could not be reached.'));
    await expect(listingAudience('lst_1', '2026-09', ADMIN)).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('audienceForSpots — the campaign fold`s read', () => {
  it('is null altogether with no vendor, so the analytics print "no panel"', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(config([]));
    expect(await audienceForSpots([{ listingId: 'lst_1', latitude: 1, longitude: 2 }], '2026-09')).toBeNull();
  });

  it('reads each spot once, through the snapshots, and never throws on one spot`s failure', async () => {
    vendors.geoiq
      .mockResolvedValueOnce(GEOIQ_PANEL)
      .mockRejectedValueOnce(new ApiError(429, 'TOO_MANY_REQUESTS', 'rate limit'));
    const result = await audienceForSpots(
      [
        { listingId: 'lst_1', latitude: 12.97, longitude: 77.6 },
        { listingId: 'lst_1', latitude: 12.97, longitude: 77.6 },
        { listingId: 'lst_2', latitude: 12.93, longitude: 77.62 },
        { listingId: 'lst_3', latitude: null, longitude: null },
      ],
      '2026-09',
    );
    expect(result?.vendor).toBe('GEOIQ');
    expect(result?.vendors).toEqual(['GEOIQ']);
    expect(result?.policy).toEqual(DEFAULT_AUDIENCE_POLICY);
    expect(result?.spots).toEqual([
      { listingId: 'lst_1', audience: expect.objectContaining({ rawByVendor: { GEOIQ: GEOIQ_PANEL }, vendors: ['GEOIQ'] }) },
      { listingId: 'lst_2', audience: null },
      { listingId: 'lst_3', audience: null },
    ]);
    expect(vendors.geoiq).toHaveBeenCalledTimes(2);
  });
});

describe('storedAudienceForListings — the city profile`s read', () => {
  it('folds the rows of the vendors in force, blended by the policy, and calls no vendor', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(config(['GEOIQ', 'AZIRA']));
    repository.findAudienceSnapshots.mockResolvedValue([
      { ...storedRow('GEOIQ', GEOIQ_PANEL), listingId: 'lst_1' },
      { ...storedRow('AZIRA', AZIRA_PANEL), listingId: 'lst_1' },
      // An expired row still describes the month.
      { ...storedRow('AZIRA', AZIRA_PANEL, new Date(Date.now() - 1000)), listingId: 'lst_2' },
    ]);
    const result = await storedAudienceForListings(['lst_1', 'lst_2', 'lst_2', 'lst_3'], '2026-09');
    expect(repository.findAudienceSnapshots).toHaveBeenCalledWith(['lst_1', 'lst_2', 'lst_3'], '2026-09');
    expect(result?.vendors).toEqual(['GEOIQ', 'AZIRA']);
    expect(result?.spots.map((s) => [s.listingId, s.audience?.vendors ?? null])).toEqual([
      ['lst_1', ['GEOIQ', 'AZIRA']],
      ['lst_2', ['AZIRA']],
      ['lst_3', null],
    ]);
    expect(result?.spots[0]?.audience?.footfall.daily).toBe(Math.round((18421 + 21340) / 2));
    expect(vendors.geoiq).not.toHaveBeenCalled();
    expect(vendors.azira).not.toHaveBeenCalled();
    expect(repository.upsertAudienceSnapshot).not.toHaveBeenCalled();
  });

  it('leaves out a vendor no longer in force, and is null with nothing enabled', async () => {
    repository.findAudienceSnapshots.mockResolvedValue([
      { ...storedRow('GEOIQ', GEOIQ_PANEL), listingId: 'lst_1' },
      { ...storedRow('AZIRA', AZIRA_PANEL), listingId: 'lst_1' },
    ]);
    const only = await storedAudienceForListings(['lst_1'], '2026-09');
    expect(only?.spots[0]?.audience?.vendors).toEqual(['GEOIQ']);
    integrations.getEffectiveAudienceConfig.mockResolvedValue(config([]));
    expect(await storedAudienceForListings(['lst_1'], '2026-09')).toBeNull();
    expect(repository.findAudienceSnapshots).toHaveBeenCalledTimes(1);
  });
});
