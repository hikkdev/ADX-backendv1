import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * AN-1 is a refactor, and this is what says so.
 *
 * The registry-backed series and the nine-figure series it replaces are
 * given the same facts and must answer the same numbers. Any difference is a
 * regression, not an improvement — the whole claim of AN-1 is that nothing
 * the console already draws changes meaning.
 *
 * It also holds the two honest asymmetries on purpose: the new path can be
 * asked for a metric the old one never had, and the old path's fixed struct
 * carries figures nobody asked for. Neither is a difference in a number.
 */

const { repository, cache } = vi.hoisted(() => ({
  repository: {
    hasCampaignSpendLegs: vi.fn(),
    campaignCaptures: vi.fn(),
    campaignsWithSpots: vi.fn(),
    paidCampaigns: vi.fn(),
    paidPackageSales: vi.fn(),
    accrualByDay: vi.fn(),
    accrualBySpot: vi.fn(),
    spotCampaigns: vi.fn(),
    creditedIncentives: vi.fn(),
    onboardedPublishers: vi.fn(),
    onboardedAdvertisers: vi.fn(),
    activatedAgents: vi.fn(),
    activeListingsCapacity: vi.fn(),
    bookedSpots: vi.fn(),
    platformRevenueByDay: vi.fn(),
    listingsPublished: vi.fn(),
    bookingsAuthorised: vi.fn(),
    bookingsCount: vi.fn(),
    campaignSpend: vi.fn(),
    accrualGross: vi.fn(),
    platformRevenue: vi.fn(),
    publisherEarnings: vi.fn(),
    activeCampaigns: vi.fn(),
    newPublishers: vi.fn(),
    newAdvertisers: vi.fn(),
    kycPending: vi.fn(),
  },
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
}));

vi.mock('../prisma-admin-overview.repository', () => ({ prismaAdminOverviewRepository: repository }));
vi.mock('../../../shared/cache', () => cache);
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => {
    const key = (name ?? '').trim().toLowerCase();
    return key === 'bengaluru' ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null;
  },
}));

import { analyticsSeries } from '../analytics.service';
import { loadMetricsSeries } from '../metrics/metrics.service';

const D = (value: string | number) => new Decimal(value);
const at = (iso: string) => new Date(iso);

const campaigns = [
  {
    id: 'cmp-1',
    name: 'Diwali burst',
    advertiserId: 'adv-1',
    advertiserName: 'Acme Foods',
    agentId: 'agt-1',
    agentName: 'Ravi',
    spots: [
      {
        id: 'spot-1',
        listingId: 'lst-1',
        lineTotal: D('6000.00'),
        category: 'INDOOR',
        city: 'Bengaluru',
        cityId: 'city_bengaluru',
        citySlug: 'bengaluru',
        cityName: 'Bengaluru',
        publisherId: 'pub-1',
        publisherName: 'Metro Gym',
      },
    ],
  },
];

const WINDOW = { from: '2026-09-01', to: '2026-09-07' };

beforeEach(() => {
  vi.clearAllMocks();
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());

  repository.hasCampaignSpendLegs.mockResolvedValue(true);
  repository.campaignCaptures.mockResolvedValue([
    { occurredAt: at('2026-09-01T19:00:00Z'), campaignId: 'cmp-1', amount: D('11800.00') },
    { occurredAt: at('2026-09-03T06:00:00Z'), campaignId: 'cmp-1', amount: D('5900.00') },
  ]);
  repository.campaignsWithSpots.mockResolvedValue(campaigns);
  repository.paidCampaigns.mockResolvedValue([
    { id: 'cmp-1', paidAt: at('2026-09-01T05:00:00Z'), total: D('11800.00'), advertiserId: 'adv-1', agentId: 'agt-1' },
  ]);
  repository.paidPackageSales.mockResolvedValue([
    { paidAt: at('2026-09-02T05:00:00Z'), total: D('2360.00'), advertiserId: 'adv-2', agentId: 'agt-1' },
  ]);
  repository.accrualByDay.mockResolvedValue([
    { forDate: at('2026-09-02T00:00:00Z'), gross: D('1000.00'), net: D('850.00'), commission: D('120.00'), taxWithheld: D('30.00') },
    { forDate: at('2026-09-03T00:00:00Z'), gross: D('1000.00'), net: D('850.00'), commission: D('120.00'), taxWithheld: D('30.00') },
  ]);
  repository.accrualBySpot.mockResolvedValue([]);
  repository.spotCampaigns.mockResolvedValue([]);
  repository.creditedIncentives.mockResolvedValue([
    { verifiedAt: at('2026-09-02T09:00:00Z'), amount: D('500.00'), agentId: 'agt-1', agentName: 'Ravi', agentCity: 'Bengaluru', agentCityId: 'city_bengaluru' },
  ]);
  repository.onboardedPublishers.mockResolvedValue([
    { at: at('2026-09-01T08:00:00Z'), city: 'Bengaluru', cityId: 'city_bengaluru' },
    { at: at('2026-09-04T09:00:00Z'), city: 'Bengaluru', cityId: 'city_bengaluru' },
  ]);
  repository.onboardedAdvertisers.mockResolvedValue([{ at: at('2026-09-03T08:00:00Z'), city: 'Bengaluru', cityId: 'city_bengaluru' }]);
  repository.activatedAgents.mockResolvedValue([{ at: at('2026-09-02T08:00:00Z'), city: null, cityId: null }]);
  repository.activeListingsCapacity.mockResolvedValue([
    { id: 'lst-1', slotsTotal: 1, publishedAt: at('2026-01-01T00:00:00Z') },
    { id: 'lst-2', slotsTotal: 3, publishedAt: at('2026-01-01T00:00:00Z') },
  ]);
  repository.bookedSpots.mockResolvedValue([{ listingId: 'lst-1', startDate: at('2026-09-02T00:00:00Z'), endDate: at('2026-09-04T00:00:00Z'), quantity: 1 }]);
  /* AN-3: ADX kept 1,770 of the 17,700 that moved — a ten per cent take rate,
     with a reversal on the 4th netting itself off against a later leg. */
  repository.platformRevenueByDay.mockResolvedValue([
    { occurredAt: at('2026-09-01T19:00:00Z'), amount: D('1180.00') },
    { occurredAt: at('2026-09-03T06:00:00Z'), amount: D('590.00') },
    { occurredAt: at('2026-09-04T06:00:00Z'), amount: D('-100.00') },
    { occurredAt: at('2026-09-04T07:00:00Z'), amount: D('100.00') },
  ]);
});

/** The nine the two paths share, and how to read each off the old shape. */
const SHARED: [string, (totals: Record<string, unknown>) => unknown][] = [
  ['gmvRecognised', (t) => t.gmvRecognised],
  ['bookingsCount', (t) => (t.bookingsAuthorised as { count: number }).count],
  ['bookingsValue', (t) => (t.bookingsAuthorised as { value: string }).value],
  ['publisherEarnings', (t) => t.publisherEarnings],
  ['advertiserSpend', (t) => t.advertiserSpend],
  ['agentCommissions', (t) => t.agentCommissions],
  ['publishersOnboarded', (t) => (t.onboardingStats as { publishersOnboarded: number }).publishersOnboarded],
  ['advertisersOnboarded', (t) => (t.onboardingStats as { advertisersOnboarded: number }).advertisersOnboarded],
  ['agentsActivated', (t) => (t.onboardingStats as { agentsActivated: number }).agentsActivated],
];

const KEYS = SHARED.map(([key]) => key);

describe('the registry answers what the nine-figure series answers', () => {
  for (const grain of ['day', 'week', 'month'] as const) {
    it(`matches every shared metric's total, by ${grain}`, async () => {
      const old = await analyticsSeries({ ...WINDOW, granularity: grain, segment: 'ALL' });
      const next = await loadMetricsSeries({ ...WINDOW, grain, metrics: KEYS });

      for (const [key, read] of SHARED) {
        expect(next.totals[key]?.value, `${key} by ${grain}`).toEqual(read(old.totals as unknown as Record<string, unknown>));
      }
    });
  }

  it('matches the previous window too, which is what every delta is drawn from', async () => {
    const old = await analyticsSeries({ ...WINDOW, granularity: 'day', segment: 'ALL' });
    const next = await loadMetricsSeries({ ...WINDOW, grain: 'day', metrics: KEYS });

    for (const [key, read] of SHARED) {
      expect(next.previous.totals[key]?.value, `${key}, previous window`).toEqual(read(old.previous.totals as unknown as Record<string, unknown>));
    }
  });

  it('agrees bucket by bucket, not only in the total', async () => {
    const old = await analyticsSeries({ ...WINDOW, granularity: 'day', segment: 'ALL' });
    const next = await loadMetricsSeries({ ...WINDOW, grain: 'day', metrics: ['gmvRecognised', 'publisherEarnings'] });

    expect(next.buckets.length).toBe(old.buckets.length);
    for (const [index, bucket] of next.buckets.entries()) {
      expect(bucket.bucket, `bucket ${index} key`).toBe(old.buckets[index]!.bucket);
      expect(bucket.values.gmvRecognised?.value, `bucket ${index} gmv`).toEqual(old.buckets[index]!.gmvRecognised);
      expect(bucket.values.publisherEarnings?.value, `bucket ${index} earnings`).toEqual(old.buckets[index]!.publisherEarnings);
    }
  });

  it('applies a city filter the same way', async () => {
    const old = await analyticsSeries({ ...WINDOW, granularity: 'day', segment: 'ALL', city: 'Bengaluru' });
    const next = await loadMetricsSeries({ ...WINDOW, grain: 'day', metrics: KEYS, city: 'Bengaluru' });

    for (const [key, read] of SHARED) {
      expect(next.totals[key]?.value, `${key}, filtered to Bengaluru`).toEqual(read(old.totals as unknown as Record<string, unknown>));
    }
  });
});

describe('what the registry adds', () => {
  it('answers a metric the old series never had', async () => {
    const series = await loadMetricsSeries({ ...WINDOW, grain: 'day', metrics: ['occupancyPct', 'taxWithheld'] });
    /* Two listings, four slots between them, seven days: 28 available
       slot-days. One spot held one slot for three days. */
    expect(series.totals.occupancyPct?.denominator).toBe(28);
    expect(series.totals.occupancyPct?.numerator).toBe(3);
    expect(series.totals.occupancyPct?.value).toBeCloseTo((3 / 28) * 100, 2);
    expect(series.totals.taxWithheld?.value).toBe('60.00');
  });

  /* AN-3: the flagship. It was a monthly figure and could not be charted. */
  it('charts the take rate, and recomputes it rather than averaging days', async () => {
    const series = await loadMetricsSeries({ ...WINDOW, grain: 'day', metrics: ['takeRatePct', 'platformRevenue'] });

    /* 1180 + 590 − 100 + 100 = 1770 kept, over 17,700 recognised. */
    expect(series.totals.platformRevenue?.value).toBe('1770.00');
    expect(series.totals.takeRatePct?.value).toBeCloseTo(10, 6);

    /* The week is not the mean of the days: most days had no revenue at all,
       and averaging their zeroes would have dragged it toward nothing. */
    const byWeek = await loadMetricsSeries({ ...WINDOW, grain: 'week', metrics: ['takeRatePct'] });
    expect(byWeek.totals.takeRatePct?.value).toBeCloseTo(10, 6);
  });

  it('nets a reversal off rather than counting it twice', async () => {
    const series = await loadMetricsSeries({ from: '2026-09-04', to: '2026-09-04', grain: 'day', metrics: ['platformRevenue'] });
    expect(series.totals.platformRevenue?.value).toBe('0.00');
  });

  it('returns only the metrics that were asked for', async () => {
    const series = await loadMetricsSeries({ ...WINDOW, grain: 'day', metrics: ['gmvRecognised'] });
    expect(Object.keys(series.totals)).toEqual(['gmvRecognised']);
    for (const bucket of series.buckets) expect(Object.keys(bucket.values)).toEqual(['gmvRecognised']);
  });

  it('refuses an unknown metric by name', async () => {
    await expect(loadMetricsSeries({ ...WINDOW, grain: 'day', metrics: ['gmvRecognizd'] })).rejects.toMatchObject({
      code: 'UNKNOWN_METRIC',
      message: expect.stringContaining('gmvRecognizd'),
    });
  });

  it('refuses an empty ask rather than answering nothing', async () => {
    await expect(loadMetricsSeries({ ...WINDOW, grain: 'day', metrics: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
