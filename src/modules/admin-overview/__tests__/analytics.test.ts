import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';
import { dayWindowISTFor } from '../../../shared/time';

/**
 * Lot G (Q115): the analytics set — the series, the breakdown, the tiles and
 * the CSV. Every read is a day-granular walk over the ledger and the orders,
 * bucketed by Indian day and cached a minute keyed by its query.
 */

const { repository, cache } = vi.hoisted(() => ({
  repository: {
    // Lot B aggregates, which the tiles reuse.
    bookingsAuthorised: vi.fn(),
    bookingsCount: vi.fn(),
    campaignSpend: vi.fn(),
    hasCampaignSpendLegs: vi.fn(),
    accrualGross: vi.fn(),
    platformRevenue: vi.fn(),
    publisherEarnings: vi.fn(),
    activeCampaigns: vi.fn(),
    newPublishers: vi.fn(),
    newAdvertisers: vi.fn(),
    kycPending: vi.fn(),
    // Lot G facts.
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
    listingsPublished: vi.fn(),
  },
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
}));

vi.mock('../prisma-admin-overview.repository', () => ({ prismaAdminOverviewRepository: repository }));
vi.mock('../../../shared/cache', () => cache);
// Lot X-B: `?city=` resolves once through pricing — Bengaluru and Mumbai are catalogued (by name or slug), anything else is a typed town.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => {
    const key = (name ?? '').trim().toLowerCase();
    return key === 'bengaluru' || key === 'bangalore' ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : key === 'mumbai' ? { cityId: 'city_mumbai', slug: 'mumbai' } : null;
  },
}));

import {
  ANALYTICS_CACHE_SECONDS,
  MAX_ANALYTICS_DAYS,
  analyticsBreakdown,
  analyticsSeries,
  analyticsTiles,
  analyticsWindow,
  breakdownCacheKey,
  bucketKeyOf,
  deltaPct,
  seriesCacheKey,
  seriesCsvLines,
  tilesCacheKey,
} from '../analytics.service';

const D = (value: string | number) => new Decimal(value);
const at = (iso: string) => new Date(iso);

/** Two campaigns: one agent-assisted with two spots in two categories, one self-serve. */
const campaigns = [
  {
    id: 'cmp-1',
    name: 'Diwali burst',
    advertiserId: 'adv-1',
    advertiserName: 'Acme Foods',
    agentId: 'agt-1',
    agentName: 'Ravi',
    spots: [
      // Lot X-B: spot-1 is keyed; spot-2 was typed "Mumbai" before the key existed and carries none.
      { id: 'spot-1', listingId: 'lst-1', lineTotal: D('6000.00'), category: 'INDOOR', city: 'Blr', cityId: 'city_bengaluru', citySlug: 'bengaluru', cityName: 'Bengaluru', publisherId: 'pub-1', publisherName: 'Metro Gym' },
      { id: 'spot-2', listingId: 'lst-2', lineTotal: D('4000.00'), category: 'OUTDOOR', city: 'Mumbai', cityId: null, citySlug: null, cityName: null, publisherId: 'pub-2', publisherName: 'Sea Face Boards' },
    ],
  },
  {
    id: 'cmp-2',
    name: 'Monsoon sale',
    advertiserId: 'adv-2',
    advertiserName: 'Brolly Co',
    agentId: null,
    agentName: null,
    spots: [{ id: 'spot-3', listingId: 'lst-3', lineTotal: D('5000.00'), category: 'INDOOR', city: 'Bengaluru', cityId: 'city_bengaluru', citySlug: 'bengaluru', cityName: 'Bengaluru', publisherId: 'pub-1', publisherName: 'Metro Gym' }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());

  repository.hasCampaignSpendLegs.mockResolvedValue(true);
  // 19:00Z on 1 Sep is 00:30 IST on 2 Sep — the capture belongs to the 2nd.
  repository.campaignCaptures.mockResolvedValue([
    { occurredAt: at('2026-09-01T19:00:00Z'), campaignId: 'cmp-1', amount: D('11800.00') },
    { occurredAt: at('2026-09-03T06:00:00Z'), campaignId: 'cmp-2', amount: D('5900.00') },
  ]);
  repository.campaignsWithSpots.mockResolvedValue(campaigns);
  repository.paidCampaigns.mockResolvedValue([
    { id: 'cmp-1', paidAt: at('2026-09-01T05:00:00Z'), total: D('11800.00'), advertiserId: 'adv-1', agentId: 'agt-1' },
    { id: 'cmp-2', paidAt: at('2026-09-03T05:00:00Z'), total: D('5900.00'), advertiserId: 'adv-2', agentId: null },
  ]);
  repository.paidPackageSales.mockResolvedValue([{ paidAt: at('2026-09-02T05:00:00Z'), total: D('2360.00'), advertiserId: 'adv-2', agentId: 'agt-1' }]);
  repository.accrualByDay.mockResolvedValue([
    { forDate: at('2026-09-02T00:00:00Z'), gross: D('1000.00'), net: D('850.00') },
    { forDate: at('2026-09-03T00:00:00Z'), gross: D('1000.00'), net: D('850.00') },
  ]);
  repository.accrualBySpot.mockResolvedValue([
    { campaignSpotId: 'spot-1', gross: D('1200.00'), net: D('1020.00') },
    { campaignSpotId: 'spot-3', gross: D('800.00'), net: D('680.00') },
  ]);
  repository.spotCampaigns.mockResolvedValue([
    { id: 'spot-1', campaignId: 'cmp-1' },
    { id: 'spot-3', campaignId: 'cmp-2' },
  ]);
  repository.creditedIncentives.mockResolvedValue([
    { verifiedAt: at('2026-09-02T09:00:00Z'), amount: D('500.00'), agentId: 'agt-1', agentName: 'Ravi', agentCity: 'Bengaluru', agentCityId: 'city_bengaluru' },
    // Typed "Bombay" and keyed to Mumbai: the key, not the spelling, puts the commission in Mumbai.
    { verifiedAt: at('2026-09-02T10:00:00Z'), amount: D('250.00'), agentId: 'agt-2', agentName: 'Meera', agentCity: 'Bombay', agentCityId: 'city_mumbai' },
  ]);
  repository.onboardedPublishers.mockResolvedValue([
    { at: at('2026-09-01T08:00:00Z'), city: 'Bengaluru', cityId: 'city_bengaluru' },
    { at: at('2026-09-01T09:00:00Z'), city: 'Mumbai', cityId: null },
  ]);
  repository.onboardedAdvertisers.mockResolvedValue([{ at: at('2026-09-03T08:00:00Z'), city: 'Bengaluru', cityId: 'city_bengaluru' }]);
  repository.activatedAgents.mockResolvedValue([{ at: at('2026-09-02T08:00:00Z'), city: null, cityId: null }]);

  repository.bookingsAuthorised.mockResolvedValue({ campaigns: D('17700.00'), packages: D('2360.00') });
  repository.campaignSpend.mockResolvedValue(D('17700.00'));
  repository.accrualGross.mockResolvedValue(D('2000.00'));
  repository.platformRevenue.mockResolvedValue(D('1770.00'));
  repository.activeCampaigns.mockResolvedValue(2);
  repository.kycPending.mockResolvedValue(3);
  // G13-B: 64 listings went live in the window, 40 in the one before.
  repository.listingsPublished.mockResolvedValueOnce(64).mockResolvedValueOnce(40);
  repository.activeListingsCapacity.mockResolvedValue([
    { id: 'lst-1', slotsTotal: 1, publishedAt: at('2026-01-01T00:00:00Z') },
    { id: 'lst-2', slotsTotal: 3, publishedAt: at('2026-01-01T00:00:00Z') },
  ]);
  repository.bookedSpots.mockResolvedValue([]);
});

describe('the window and its buckets', () => {
  it('is inclusive Indian days, from the first IST midnight to the last', () => {
    const window = analyticsWindow('2026-09-01', '2026-09-03');
    expect(window.start).toEqual(dayWindowISTFor('2026-09-01').start);
    expect(window.end).toEqual(dayWindowISTFor('2026-09-03').end);
    expect(window.days).toBe(3);
    expect(window.previous).toEqual({ start: dayWindowISTFor('2026-08-29').start, end: window.start });
  });

  it('refuses a reversed range and one longer than a year', () => {
    expect(() => analyticsWindow('2026-09-03', '2026-09-01')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => analyticsWindow('2025-01-01', '2026-09-01')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(MAX_ANALYTICS_DAYS).toBe(366);
  });

  it('keys a bucket by its Indian day, the Monday of its week, or the first of its month', () => {
    // 19:00Z on Tuesday 1 Sep is already Wednesday 2 Sep in India.
    const instant = at('2026-09-01T19:00:00Z');
    expect(bucketKeyOf(instant, 'day')).toBe('2026-09-02');
    expect(bucketKeyOf(instant, 'week')).toBe('2026-08-31');
    expect(bucketKeyOf(instant, 'month')).toBe('2026-09-01');
    // Sunday 6 Sep belongs to the week of Monday 31 Aug.
    expect(bucketKeyOf(at('2026-09-06T10:00:00Z'), 'week')).toBe('2026-08-31');
  });

  it('answers one bucket per day, empty days included, with the bounds clamped to the window', async () => {
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-04', granularity: 'day', segment: 'ALL' });
    expect(series.buckets.map((b) => b.bucket)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
    expect(series.buckets[0]!.start).toBe(dayWindowISTFor('2026-09-01').start.toISOString());
    expect(series.buckets[3]!.end).toBe(dayWindowISTFor('2026-09-04').end.toISOString());
    expect(series.buckets[3]).toMatchObject({ gmvRecognised: '0.00', bookingsAuthorised: { count: 0, value: '0.00' } });
  });

  it('buckets by week and by month, the first bucket labelled by its natural start and clamped to the window', async () => {
    const weekly = await analyticsSeries({ from: '2026-09-01', to: '2026-09-14', granularity: 'week', segment: 'ALL' });
    expect(weekly.buckets.map((b) => b.bucket)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
    expect(weekly.buckets[0]!.start).toBe(dayWindowISTFor('2026-09-01').start.toISOString());
    expect(weekly.buckets[0]!.end).toBe(dayWindowISTFor('2026-09-06').end.toISOString());
    expect(weekly.buckets[2]!.end).toBe(dayWindowISTFor('2026-09-14').end.toISOString());

    const monthly = await analyticsSeries({ from: '2026-08-15', to: '2026-09-10', granularity: 'month', segment: 'ALL' });
    expect(monthly.buckets.map((b) => b.bucket)).toEqual(['2026-08-01', '2026-09-01']);
  });
});

describe('the series', () => {
  it('takes GMV from the capture legs by the Indian day they were posted', async () => {
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL' });
    expect(series.gmvSource).toBe('CAMPAIGN_SPEND');
    expect(series.buckets.map((b) => b.gmvRecognised)).toEqual(['0.00', '11800.00', '5900.00']);
    expect(series.totals.gmvRecognised).toBe('17700.00');
  });

  it('counts and values bookings by paidAt, package sales included', async () => {
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL' });
    expect(series.buckets.map((b) => b.bookingsAuthorised)).toEqual([
      { count: 1, value: '11800.00' },
      { count: 1, value: '2360.00' },
      { count: 1, value: '5900.00' },
    ]);
    expect(series.totals.bookingsAuthorised).toEqual({ count: 3, value: '20060.00' });
  });

  it('answers publisher earnings from the accrual, advertiser spend as GMV plus package sales, and commissions from credited incentives', async () => {
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL' });
    expect(series.buckets.map((b) => b.publisherEarnings)).toEqual(['0.00', '850.00', '850.00']);
    expect(series.buckets.map((b) => b.advertiserSpend)).toEqual(['0.00', '14160.00', '5900.00']);
    expect(series.buckets.map((b) => b.agentCommissions)).toEqual(['0.00', '750.00', '0.00']);
  });

  it('counts onboarding by the day a party was activated', async () => {
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL' });
    expect(series.buckets.map((b) => b.onboardingStats)).toEqual([
      { publishersOnboarded: 2, advertisersOnboarded: 0, agentsActivated: 0 },
      { publishersOnboarded: 0, advertisersOnboarded: 0, agentsActivated: 1 },
      { publishersOnboarded: 0, advertisersOnboarded: 1, agentsActivated: 0 },
    ]);
  });

  /**
   * A capture is the whole booking; a category or city filter sees the part
   * of it the matching spots carry, in the ratio of their line totals. A
   * package sale has no listing and drops out under either filter.
   */
  it('apportions a booking across its spots when filtered by category or city', async () => {
    const indoor = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL', category: 'INDOOR' });
    // cmp-1 is 60% indoor; cmp-2 wholly.
    expect(indoor.buckets.map((b) => b.gmvRecognised)).toEqual(['0.00', '7080.00', '5900.00']);
    expect(indoor.buckets.map((b) => b.bookingsAuthorised)).toEqual([
      { count: 1, value: '7080.00' },
      { count: 0, value: '0.00' },
      { count: 1, value: '5900.00' },
    ]);
    expect(repository.accrualByDay).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ category: 'INDOOR' }));

    const mumbai = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL', city: 'mumbai' });
    // Lot X-B: spot-2 has no key and is caught by its spelling; the accrual read is asked by key and spelling.
    expect(mumbai.buckets.map((b) => b.gmvRecognised)).toEqual(['0.00', '4720.00', '0.00']);
    expect(repository.accrualByDay).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ city: 'mumbai', cityId: 'city_mumbai' }));
    // The city filter reaches the agent's and the parties' cities too — the agent by key (typed "Bombay"), the publisher by spelling (no key).
    expect(mumbai.buckets[1]!.agentCommissions).toBe('250.00');
    expect(mumbai.buckets[0]!.onboardingStats.publishersOnboarded).toBe(1);
    expect(mumbai.filters).toEqual({ category: null, city: 'mumbai' });
  });

  /* Lot X-B */
  it('narrows by the key, so a spot typed under an old spelling is found by the slug, and a typed town with no key by its spelling alone', async () => {
    // spot-1 is typed "Blr" but keyed to Bengaluru: 60% of cmp-1 (7080) and the whole of cmp-2 (5900).
    const bengaluru = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL', city: 'bengaluru' });
    expect(bengaluru.buckets.map((b) => b.gmvRecognised)).toEqual(['0.00', '7080.00', '5900.00']);
    // The key is the identity: "Blr" alone (no catalogue row) matches nothing keyed elsewhere, however it was typed.
    const blr = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL', city: 'Blr' });
    expect(blr.buckets.map((b) => b.gmvRecognised)).toEqual(['0.00', '0.00', '0.00']);
    expect(repository.accrualByDay).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ city: 'Blr', cityId: null }));
  });

  it('narrows the money to agent-assisted bookings under the AGENTS segment', async () => {
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'AGENTS' });
    expect(series.buckets.map((b) => b.gmvRecognised)).toEqual(['0.00', '11800.00', '0.00']);
    expect(series.buckets.map((b) => b.bookingsAuthorised.count)).toEqual([1, 1, 0]);
    expect(series.series).toEqual(['bookingsCount', 'bookingsValue', 'gmvRecognised', 'agentCommissions', 'agentsActivated']);
    expect(repository.accrualByDay).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentAssisted: true }));
  });

  it('names the series each segment draws', async () => {
    const publishers = await analyticsSeries({ from: '2026-09-01', to: '2026-09-01', granularity: 'day', segment: 'PUBLISHERS' });
    expect(publishers.series).toEqual(['gmvRecognised', 'publisherEarnings', 'publishersOnboarded']);
    const advertisers = await analyticsSeries({ from: '2026-09-01', to: '2026-09-01', granularity: 'day', segment: 'ADVERTISERS' });
    expect(advertisers.series).toEqual(['bookingsCount', 'bookingsValue', 'gmvRecognised', 'advertiserSpend', 'advertisersOnboarded']);
  });

  it('falls back to the accrual gross while no spend leg has ever been posted', async () => {
    repository.hasCampaignSpendLegs.mockResolvedValue(false);
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL' });
    expect(series.gmvSource).toBe('ACCRUAL_GROSS');
    expect(series.buckets.map((b) => b.gmvRecognised)).toEqual(['0.00', '1000.00', '1000.00']);
    expect(repository.campaignCaptures).not.toHaveBeenCalled();
  });

  it('puts the previous window of the same length beside it, per metric, with the delta', async () => {
    // Facts are loaded once over both windows and split: the 29–31 Aug rows are "previous".
    repository.campaignCaptures.mockResolvedValue([
      { occurredAt: at('2026-08-30T06:00:00Z'), campaignId: 'cmp-2', amount: D('5000.00') },
      { occurredAt: at('2026-09-02T06:00:00Z'), campaignId: 'cmp-1', amount: D('11800.00') },
    ]);
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'day', segment: 'ALL' });
    expect(series.previousWindow).toEqual({
      start: dayWindowISTFor('2026-08-29').start.toISOString(),
      end: dayWindowISTFor('2026-09-01').start.toISOString(),
    });
    expect(series.previous.buckets.map((b) => b.bucket)).toEqual(['2026-08-29', '2026-08-30', '2026-08-31']);
    expect(series.previous.totals.gmvRecognised).toBe('5000.00');
    expect(series.comparison.gmvRecognised).toEqual({ current: '11800.00', previous: '5000.00', deltaPct: '136.00' });
    expect(series.comparison.publishersOnboarded).toEqual({ current: 2, previous: 0, deltaPct: null });
    // The repository was asked for the combined span once, not twice.
    expect(repository.campaignCaptures).toHaveBeenCalledTimes(1);
    expect(repository.campaignCaptures).toHaveBeenCalledWith({ start: dayWindowISTFor('2026-08-29').start, end: dayWindowISTFor('2026-09-03').end });
  });

  it('computes the delta as a percentage with two decimals, null over nothing', () => {
    expect(deltaPct(D('120'), D('100'))).toBe('20.00');
    expect(deltaPct(D('80'), D('100'))).toBe('-20.00');
    expect(deltaPct(D('5'), D('0'))).toBeNull();
    expect(deltaPct(D('0'), D('0'))).toBeNull();
  });

  it('is cached a minute keyed by its query', async () => {
    await analyticsSeries({ from: '2026-09-01', to: '2026-09-03', granularity: 'week', segment: 'AGENTS', city: 'Mumbai' });
    expect(cache.readThrough).toHaveBeenCalledWith(
      seriesCacheKey({ from: '2026-09-01', to: '2026-09-03', granularity: 'week', segment: 'AGENTS', city: 'Mumbai' }),
      ANALYTICS_CACHE_SECONDS,
      expect.any(Function),
    );
    expect(ANALYTICS_CACHE_SECONDS).toBe(60);
    expect(seriesCacheKey({ from: '2026-09-01', to: '2026-09-03', granularity: 'week', segment: 'AGENTS', city: 'Mumbai' })).toBe(
      'admin-overview:series:2026-09-01:2026-09-03:week:AGENTS:-:mumbai',
    );
  });

  it('streams as CSV, a header and one line per bucket, money as decimal strings', async () => {
    const series = await analyticsSeries({ from: '2026-09-01', to: '2026-09-02', granularity: 'day', segment: 'ALL' });
    const lines = [...seriesCsvLines(series)];
    expect(lines[0]).toBe(
      'bucket,start,end,gmvRecognised,bookingsCount,bookingsValue,publisherEarnings,advertiserSpend,agentCommissions,publishersOnboarded,advertisersOnboarded,agentsActivated\r\n',
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(`2026-09-02,${series.buckets[1]!.start},${series.buckets[1]!.end},11800.00,1,2360.00,850.00,14160.00,750.00,0,0,1\r\n`);
  });
});

describe('the breakdown', () => {
  const query = (by: 'category' | 'city' | 'publisher' | 'advertiser' | 'agent', extra: Record<string, unknown> = {}) => ({
    from: '2026-09-01',
    to: '2026-09-03',
    by,
    sort: 'GMV_DESC' as const,
    page: 1,
    pageSize: 20,
    ...extra,
  });

  it('answers GMV, bookings and earnings by publisher on the list contract, top first', async () => {
    const page = await analyticsBreakdown(query('publisher'));
    expect(page).toMatchObject({ total: 2, page: 1, pageSize: 20, counts: {} });
    expect(page.items).toEqual([
      {
        key: 'pub-1',
        label: 'Metro Gym',
        href: '/publishers/pub-1',
        gmvRecognised: '12980.00',
        bookingsCount: 2,
        bookingsValue: '12980.00',
        publisherEarnings: '1700.00',
        sharePct: '73.33',
        // G11-1: the mocks answer the same facts for the window shifted back, so the row moved 0.00 %.
        previous: { gmvRecognised: '12980.00', bookings: 2 },
        deltaPct: '0.00',
      },
      {
        key: 'pub-2',
        label: 'Sea Face Boards',
        href: '/publishers/pub-2',
        gmvRecognised: '4720.00',
        bookingsCount: 1,
        bookingsValue: '4720.00',
        publisherEarnings: '0.00',
        sharePct: '26.67',
        previous: { gmvRecognised: '4720.00', bookings: 1 },
        deltaPct: '0.00',
      },
    ]);
  });

  it('answers by category and by city with the listings links', async () => {
    const byCategory = await analyticsBreakdown(query('category'));
    expect(byCategory.items.map((r) => [r.key, r.gmvRecognised, r.href])).toEqual([
      ['INDOOR', '12980.00', '/listings?category=INDOOR'],
      ['OUTDOOR', '4720.00', '/listings?category=OUTDOOR'],
    ]);
    // Lot X-B: by key — the slug, labelled from the catalogue; the spot typed "Mumbai" with no key is the "Other (typed)" bucket.
    const byCity = await analyticsBreakdown(query('city'));
    expect(byCity.items.map((r) => [r.key, r.label, r.gmvRecognised, r.href])).toEqual([
      ['bengaluru', 'Bengaluru', '12980.00', '/listings?city=bengaluru'],
      ['other', 'Other (typed)', '4720.00', ''],
    ]);
  });

  it('answers by advertiser whole, and by agent for the assisted bookings only', async () => {
    const byAdvertiser = await analyticsBreakdown(query('advertiser'));
    expect(byAdvertiser.items).toEqual([
      expect.objectContaining({ key: 'adv-1', label: 'Acme Foods', href: '/advertisers/adv-1', gmvRecognised: '11800.00', bookingsCount: 1, publisherEarnings: '1020.00' }),
      expect.objectContaining({ key: 'adv-2', label: 'Brolly Co', gmvRecognised: '5900.00', bookingsCount: 2, bookingsValue: '8260.00', publisherEarnings: '680.00' }),
    ]);
    const byAgent = await analyticsBreakdown(query('agent'));
    expect(byAgent.total).toBe(1);
    expect(byAgent.items[0]).toMatchObject({ key: 'agt-1', label: 'Ravi', href: '/agents/agt-1', gmvRecognised: '11800.00', bookingsCount: 2, bookingsValue: '14160.00' });
  });

  it('sorts by every column, searches the label and pages', async () => {
    expect((await analyticsBreakdown(query('publisher', { sort: 'GMV_ASC' }))).items.map((r) => r.key)).toEqual(['pub-2', 'pub-1']);
    expect((await analyticsBreakdown(query('publisher', { sort: 'BOOKINGS_ASC' }))).items.map((r) => r.key)).toEqual(['pub-2', 'pub-1']);
    expect((await analyticsBreakdown(query('publisher', { sort: 'VALUE_DESC' }))).items.map((r) => r.key)).toEqual(['pub-1', 'pub-2']);
    expect((await analyticsBreakdown(query('publisher', { sort: 'EARNINGS_ASC' }))).items.map((r) => r.key)).toEqual(['pub-2', 'pub-1']);
    expect((await analyticsBreakdown(query('publisher', { sort: 'LABEL_DESC' }))).items.map((r) => r.key)).toEqual(['pub-2', 'pub-1']);
    expect((await analyticsBreakdown(query('publisher', { sort: 'LABEL_ASC' }))).items.map((r) => r.key)).toEqual(['pub-1', 'pub-2']);

    const searched = await analyticsBreakdown(query('publisher', { q: 'sea face' }));
    expect(searched.total).toBe(1);
    expect(searched.items[0]!.key).toBe('pub-2');

    const paged = await analyticsBreakdown(query('publisher', { page: 2, pageSize: 1 }));
    expect(paged).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(paged.items.map((r) => r.key)).toEqual(['pub-2']);
  });

  it('caches the whole table a minute per window and dimension; sort, search and page are applied on read', async () => {
    await analyticsBreakdown(query('city', { sort: 'LABEL_ASC', q: 'ben', page: 2 }));
    expect(cache.readThrough).toHaveBeenCalledWith(breakdownCacheKey({ from: '2026-09-01', to: '2026-09-03', by: 'city' }), ANALYTICS_CACHE_SECONDS, expect.any(Function));
  });
});

describe('the tiles', () => {
  it('answers active listings and the fill rate over ACTIVE listings in the window', async () => {
    // Ten days; lst-1 has one slot, lst-2 three: 40 listing-days available.
    // A spot on lst-2 for four days of the window at quantity 2, one on lst-1
    // running past the end: 8 + 3 = 11 booked.
    repository.bookedSpots.mockResolvedValue([
      { listingId: 'lst-2', startDate: at('2026-09-03T00:00:00Z'), endDate: at('2026-09-06T00:00:00Z'), quantity: 2 },
      { listingId: 'lst-1', startDate: at('2026-09-08T00:00:00Z'), endDate: at('2026-09-20T00:00:00Z'), quantity: 1 },
    ]);
    const tiles = await analyticsTiles({ from: '2026-09-01', to: '2026-09-10' });
    expect(tiles.activeListings.count).toBe(2);
    expect(tiles.fillRate.current).toEqual({ pct: '27.50', bookedListingDays: 11, availableListingDays: 40 });
  });

  it('G13-B: carries the listings published in the window against the previous window — the "1,092 up 64" tile', async () => {
    const tiles = await analyticsTiles({ from: '2026-09-01', to: '2026-09-10' });
    expect(tiles.activeListings).toEqual({ count: 2, newInWindow: 64, previousNewInWindow: 40, delta: 24 });
    // Listing.publishedAt in the window, then in the window before it.
    const window = analyticsWindow('2026-09-01', '2026-09-10');
    expect(repository.listingsPublished).toHaveBeenNthCalledWith(1, { start: window.start, end: window.end });
    expect(repository.listingsPublished).toHaveBeenNthCalledWith(2, { start: window.previous.start, end: window.previous.end });
  });

  it('counts a listing as available only from the day it was published', async () => {
    repository.activeListingsCapacity.mockResolvedValue([{ id: 'lst-9', slotsTotal: 2, publishedAt: at('2026-09-06T00:00:00Z') }]);
    const tiles = await analyticsTiles({ from: '2026-09-01', to: '2026-09-10' });
    // Published on the 6th: the 6th to the 10th, five days, two slots.
    expect(tiles.fillRate.current.availableListingDays).toBe(10);
    expect(tiles.fillRate.current.pct).toBe('0.00');
  });

  it('carries the four KPIs with the previous window and the delta', async () => {
    repository.campaignSpend.mockResolvedValueOnce(D('17700.00')).mockResolvedValueOnce(D('10000.00'));
    repository.platformRevenue.mockResolvedValueOnce(D('1770.00')).mockResolvedValueOnce(D('500.00'));
    repository.activeCampaigns.mockResolvedValueOnce(2).mockResolvedValueOnce(4);
    const tiles = await analyticsTiles({ from: '2026-09-01', to: '2026-09-10' });
    expect(tiles.gmvRecognised).toEqual({ current: '17700.00', previous: '10000.00', deltaPct: '77.00' });
    expect(tiles.takeRatePct).toEqual({ current: '10.00', previous: '5.00', deltaPct: '100.00' });
    expect(tiles.activeCampaigns).toEqual({ current: 2, previous: 4, deltaPct: '-50.00' });
    expect(tiles.bookingsAuthorised.current).toBe('20060.00');
    expect(tiles.kycPending).toBe(3);
    expect(tiles.gmvSource).toBe('CAMPAIGN_SPEND');
  });

  it('is cached a minute keyed by the window', async () => {
    await analyticsTiles({ from: '2026-09-01', to: '2026-09-10' });
    expect(cache.readThrough).toHaveBeenCalledWith(tilesCacheKey({ from: '2026-09-01', to: '2026-09-10' }), ANALYTICS_CACHE_SECONDS, expect.any(Function));
  });
});
