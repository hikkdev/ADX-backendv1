import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * G7 (Q109) — the Audience Breakdown on a campaign's analytics.
 *
 * The owner's answer: campaign analytics are digital interactions; the
 * audience panel is a footfall / data-panel vendor's. So the read gains
 * `audience`: the vendor's panels over the booked spots, folded — footfall
 * summed across sites, shares averaged weighted by days × quantity — with
 * PANEL provenance and the vendor's name; null when no vendor is configured;
 * a spot with no panel counted in the total and nowhere else; never a
 * failure of the analytics read. Y-B: the fold reads the blended shape and
 * carries the provenance — the vendors in force, per field group who the
 * folded figures came from, the mean vendor agreement across the sites.
 */

const { repository, listings } = vi.hoisted(() => ({
  repository: {
    trackingTotals: vi.fn(async () => ({ scans: 0, clicks: 0, redemptions: 0 })),
    eventTotalsByDay: vi.fn(async () => []),
    interactionTotals: vi.fn(async () => ({ byDevice: [], byHour: [], byCity: [], byCta: [] })),
    listCampaigns: vi.fn(),
    findCampaign: vi.fn(),
    upsertDailyMetric: vi.fn(),
    dailyMetricsFor: vi.fn(async () => []),
  },
  listings: {
    audienceForSpots: vi.fn(),
    currentPeriod: (now = new Date()) => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
  },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../listings', () => listings);

import { audiencePeriodFor, campaignAnalytics, foldAudience, portfolioAnalytics } from '../analytics.service';

const panel = (over: Record<string, unknown> = {}) => ({
  footfall: { daily: 10000, byHour: null, byWeekday: [10, 10, 10, 10, 20, 20, 20] },
  demographics: {
    ageBands: [{ label: '18_24', share: 20 }, { label: '25_34', share: 80 }],
    gender: [{ label: 'male', share: 60 }, { label: 'female', share: 40 }],
    incomeBands: null,
    affinities: null,
  },
  provenance: 'PANEL',
  vendor: 'GEOIQ',
  period: '2026-04',
  radiusM: 500,
  fetchedAt: '2026-04-05T00:00:00.000Z',
  ...over,
});

const spot = (id: string, listingId: string, days: number, over: Record<string, unknown> = {}) => ({
  id,
  listingId,
  status: 'LIVE',
  ratePerDay: new Decimal('2000'),
  days,
  quantity: 1,
  lineTotal: new Decimal(2000 * days),
  listing: { id: listingId, title: listingId, city: 'Bengaluru', latitude: 12.97, longitude: 77.6, estimatedDailyFootfall: null, mediaType: null, photos: [] },
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    name: 'Anita coffee, April',
    status: 'LIVE',
    startDate: new Date('2026-04-01T00:00:00Z'),
    endDate: new Date('2026-04-14T00:00:00Z'),
    budget: new Decimal('100000'),
    total: new Decimal('34810'),
    trackingMethod: 'NONE',
    spots: [spot('spt_1', 'lst_1', 14), spot('spt_2', 'lst_2', 2)],
    codes: [],
    ...over,
  }) as never;

const NOW = new Date('2026-04-05T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  listings.audienceForSpots.mockResolvedValue({
    vendor: 'GEOIQ',
    spots: [
      { listingId: 'lst_1', audience: panel() },
      { listingId: 'lst_2', audience: panel({ footfall: { daily: 3000, byHour: null, byWeekday: null }, demographics: { ageBands: [{ label: '18_24', share: 100 }], gender: null, incomeBands: null, affinities: null } }) },
    ],
  });
});

describe('the audience on one campaign', () => {
  it('is the vendor`s panels folded over the booked spots, PANEL and named', async () => {
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(listings.audienceForSpots).toHaveBeenCalledWith(
      [
        { listingId: 'lst_1', latitude: 12.97, longitude: 77.6 },
        { listingId: 'lst_2', latitude: 12.97, longitude: 77.6 },
      ],
      '2026-04',
    );
    expect(analytics.audience).toMatchObject({
      provenance: 'PANEL',
      vendor: 'GEOIQ',
      period: '2026-04',
      spotsWithData: 2,
      spotsTotal: 2,
      // Footfall is summed across sites: the campaign's audience is every site's catchment.
      footfall: { daily: 13000, byHour: null, byWeekday: [10, 10, 10, 10, 20, 20, 20] },
      // Shares are averaged, weighted by days: 14 days at 20/80 and 2 days at 100/0.
      demographics: {
        ageBands: [{ label: '18_24', share: 30 }, { label: '25_34', share: 70 }],
        gender: [{ label: 'male', share: 60 }, { label: 'female', share: 40 }],
        incomeBands: null,
        affinities: null,
      },
    });
    expect(analytics.audience?.basis).toBe('GEOIQ panel on 2 of 2 booked sites, 2026-04; shares weighted by days booked');
    expect(analytics.demographics.basis).toContain('see audience for the GEOIQ panel');
  });

  it('is null, and the demographics say why, when no vendor is configured', async () => {
    listings.audienceForSpots.mockResolvedValue(null);
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.audience).toBeNull();
    expect(analytics.demographics).toEqual({
      value: null,
      provenance: 'UNAVAILABLE',
      basis: 'No audience panel or pixel backs a demographic split of out-of-home',
    });
  });

  it('counts a spot with no panel in the total and nowhere else', async () => {
    listings.audienceForSpots.mockResolvedValue({ vendor: 'AZIRA', spots: [{ listingId: 'lst_1', audience: panel({ vendor: 'AZIRA' }) }, { listingId: 'lst_2', audience: null }] });
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.audience).toMatchObject({ vendor: 'AZIRA', spotsWithData: 1, spotsTotal: 2, footfall: { daily: 10000 } });
    expect(analytics.audience?.demographics.ageBands).toEqual([{ label: '18_24', share: 20 }, { label: '25_34', share: 80 }]);
  });

  it('says so when no site has a panel, and is null with nothing booked', async () => {
    listings.audienceForSpots.mockResolvedValue({ vendor: 'GEOIQ', spots: [{ listingId: 'lst_1', audience: null }, { listingId: 'lst_2', audience: null }] });
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.audience).toMatchObject({ spotsWithData: 0, spotsTotal: 2, footfall: { daily: null, byHour: null, byWeekday: null }, basis: 'GEOIQ has no panel for any of the 2 booked sites in 2026-04' });
    const empty = await campaignAnalytics(campaign({ spots: [] }), NOW);
    expect(empty.audience).toBeNull();
    expect(listings.audienceForSpots).toHaveBeenCalledTimes(1);
  });

  it('never fails the analytics read when the listings side throws', async () => {
    listings.audienceForSpots.mockRejectedValue(new Error('vendor down'));
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.audience).toBeNull();
    expect(analytics.spend.toDate).toBe('20000.00');
  });

  it('is skipped for the portfolio view and the daily snapshot', async () => {
    repository.listCampaigns.mockResolvedValue([{ id: 'cmp_1', status: 'LIVE', brandName: null }]);
    repository.findCampaign.mockResolvedValue(campaign());
    await portfolioAnalytics({ isAdmin: true } as never, {}, NOW);
    expect(listings.audienceForSpots).not.toHaveBeenCalled();
  });
});

describe('which month the panels are read for', () => {
  const start = new Date('2026-04-01T00:00:00Z');
  const end = new Date('2026-06-14T00:00:00Z');
  it('the latest month the flight has run in; the start month before it starts; this month with no dates', () => {
    expect(audiencePeriodFor(start, end, new Date('2026-05-20T00:00:00Z'))).toBe('2026-05');
    expect(audiencePeriodFor(start, end, new Date('2026-09-01T00:00:00Z'))).toBe('2026-06');
    expect(audiencePeriodFor(start, end, new Date('2026-03-01T00:00:00Z'))).toBe('2026-04');
    expect(audiencePeriodFor(null, null, new Date('2026-03-01T00:00:00Z'))).toBe('2026-03');
  });
});

describe('Y-B: the fold carries the provenance', () => {
  const blended = (over: Record<string, unknown> = {}) =>
    panel({
      provenanceByField: { footfall: 'BLENDED', demographics: 'GEOIQ', affinities: 'AZIRA' },
      vendors: ['GEOIQ', 'AZIRA'],
      agreement: { footfall: 0.86 },
      rawByVendor: {},
      ...over,
    });

  it('names both vendors, folds the per-field provenance across sites and averages the agreement', async () => {
    listings.audienceForSpots.mockResolvedValue({
      vendor: 'AZIRA',
      vendors: ['GEOIQ', 'AZIRA'],
      spots: [
        { listingId: 'lst_1', audience: blended() },
        { listingId: 'lst_2', audience: blended({ provenanceByField: { footfall: 'GEOIQ', demographics: 'AZIRA', affinities: null }, vendors: ['GEOIQ'], agreement: { footfall: null } }) },
      ],
    });
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.audience).toMatchObject({
      vendor: 'AZIRA',
      vendors: ['GEOIQ', 'AZIRA'],
      provenanceByField: { footfall: 'BLENDED', demographics: 'BLENDED', affinities: 'AZIRA' },
      agreement: { footfall: 0.86 },
      spotsWithData: 2,
    });
    expect(analytics.audience?.basis).toBe('GEOIQ + AZIRA panels, blended, on 2 of 2 booked sites, 2026-04; shares weighted by days booked');
  });

  it('reads a raw single-vendor panel (an old row) as that vendor`s on every group it carries', () => {
    const folded = foldAudience([{ listingId: 'a', days: 1, quantity: 1 }], [{ listingId: 'a', audience: panel() as never }], 'GEOIQ', '2026-04');
    expect(folded.vendors).toEqual(['GEOIQ']);
    expect(folded.provenanceByField).toEqual({ footfall: 'GEOIQ', demographics: 'GEOIQ', affinities: null });
    expect(folded.agreement).toEqual({ footfall: null });
  });
});

describe('foldAudience', () => {
  it('weights by days × quantity and folds hourly profiles element-wise', () => {
    const folded = foldAudience(
      [
        { listingId: 'a', days: 1, quantity: 3 },
        { listingId: 'b', days: 1, quantity: 1 },
      ],
      [
        { listingId: 'a', audience: panel({ footfall: { daily: 100, byHour: new Array(24).fill(0).map((_, i) => (i === 8 ? 100 : 0)), byWeekday: null } }) as never },
        { listingId: 'b', audience: panel({ footfall: { daily: 100, byHour: new Array(24).fill(0).map((_, i) => (i === 20 ? 100 : 0)), byWeekday: null } }) as never },
      ],
      'AZIRA',
      '2026-04',
    );
    expect(folded.footfall.daily).toBe(200);
    expect(folded.footfall.byHour?.[8]).toBe(75);
    expect(folded.footfall.byHour?.[20]).toBe(25);
    expect(folded.footfall.byWeekday).toBeNull();
  });
});
