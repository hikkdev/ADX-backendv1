import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, QUERY, campaignsSeed, labelsOf } from './fixtures';
import { inMemoryRepository, type Seed } from './in-memory.repository';

/**
 * 2 Oct 2026 (the Campaigns lot): the Campaigns overview — the owner,
 * "Campaigns section feels too weak here".
 *
 * Pinned: the states (live, scheduled, awaiting payment, waiting to launch)
 * without a previous; the window figures against the previous window (paid,
 * completed, cancelled, the engagement); the booked value as a money figure
 * and its series; the three work lists with their links (the directory on
 * the next seven days, ending soonest, the launch queue by reason through
 * the campaigns module's own count); the breakdowns by status (lifecycle
 * order), city (narrowing this overview), goal and advertiser (labelled);
 * the city passed to the launch queue; the cache key.
 */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  advertisers: { findAdvertiserLabels: vi.fn() },
  campaigns: {
    WAITING_REASONS: ['RESERVATION_FEE', 'PAYMENT', 'DESIGN_QUOTE', 'KYC', 'ARTWORK', 'PUBLISHER', 'AGENT'],
    launchQueueSummary: vi.fn(),
  },
}));

vi.mock('../prisma-section-overviews.repository', () => ({
  prismaSectionOverviewsRepository: new Proxy({}, { get: (_target, property) => (state.repository as unknown as Record<PropertyKey, unknown>)[property] }),
}));
vi.mock('../../../shared/cache', () => state.cache);
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => {
    const key = (name ?? '').trim().toLowerCase();
    return key === 'bengaluru' ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : key === 'mumbai' ? { cityId: 'city_mumbai', slug: 'mumbai' } : null;
  },
}));
vi.mock('../../campaigns', () => state.campaigns);
vi.mock('../../advertisers', () => state.advertisers);
vi.mock('../../supply', () => ({ RISK_WINDOW_DAYS: { PERMANENT: 15 } }));
vi.mock('../../publishers', () => ({}));
vi.mock('../../agents', () => ({}));
vi.mock('../../leads', () => ({}));
vi.mock('../../employees', () => ({}));
vi.mock('../../print-partners', () => ({}));

import { SECTIONS, sectionOverview, sectionOverviewCacheKey, type CampaignsOverview } from '../section-overviews.service';
import { sectionParamSchema } from '../section-overviews.schema';

const read = (query: { from?: string; to?: string; city?: string } = QUERY, seed: Seed = campaignsSeed()) => {
  state.repository = inMemoryRepository(seed);
  return sectionOverview('campaigns', query, NOW) as Promise<CampaignsOverview>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  state.advertisers.findAdvertiserLabels.mockImplementation(labelsOf);
  state.campaigns.launchQueueSummary.mockResolvedValue({
    total: 6,
    byReason: { RESERVATION_FEE: 0, PAYMENT: 1, DESIGN_QUOTE: 0, KYC: 3, ARTWORK: 2, PUBLISHER: 1, AGENT: 1 },
  });
});

describe('the campaigns overview', () => {
  it('is a section of its own, and the route takes it', () => {
    expect(SECTIONS).toContain('campaigns');
    expect(sectionParamSchema.safeParse({ section: 'campaigns' }).success).toBe(true);
  });

  it('carries the book now as states, and the window against the window before', async () => {
    const data = await read();
    expect(data.section).toBe('campaigns');
    expect(data.tiles.live).toEqual({ value: 5, previous: null, delta: null });
    expect(data.tiles.scheduled).toEqual({ value: 2, previous: null, delta: null });
    expect(data.tiles.awaitingPayment).toEqual({ value: 4, previous: null, delta: null });
    expect(data.tiles.waitingToLaunch).toEqual({ value: 6, previous: null, delta: null });
    expect(data.tiles.paid).toEqual({ value: 3, previous: 1, delta: 2 });
    expect(data.tiles.completed).toEqual({ value: 1, previous: 2, delta: -1 });
    expect(data.tiles.cancelled).toEqual({ value: 1, previous: 0, delta: 1 });
    expect(data.tiles.scans).toEqual({ value: 3, previous: 1, delta: 2 });
    expect(data.tiles.landingViews).toEqual({ value: 2, previous: 0, delta: 2 });
    expect(data.tiles.ctaClicks).toEqual({ value: 1, previous: 0, delta: 1 });
    expect(data.tiles.enquiries).toEqual({ value: 1, previous: 1, delta: 0 });
  });

  it('sums the booked value of the campaigns paid in the window, with its series', async () => {
    const data = await read();
    expect(data.money.bookedValue).toEqual({ value: '115000.00', previous: '30000.00', delta: '85000.00' });
    expect(data.series.bookedValue.days).toHaveLength(10);
    expect(data.series.bookedValue.days[0]).toEqual({ day: '2026-09-01', value: '50000.00' });
    expect(data.series.bookedValue.total).toEqual(data.money.bookedValue);
    expect(data.series.scans.days.find((point) => point.day === '2026-09-02')?.value).toBe(2);
    expect(data.series.scans.total).toEqual(data.tiles.scans);
  });

  it('lists the work: launching and ending in the next seven days, and the launch queue by reason', async () => {
    const data = await read();
    // NOW is 15 Sep 2026 in India: the directory on 15–21 Sep.
    expect(data.work.launchingSoon).toEqual({ count: 4, horizonDays: 7, href: '/campaigns/directory?status=SCHEDULED&from=2026-09-15&to=2026-09-21' });
    expect(data.work.endingSoon).toEqual({ count: 2, horizonDays: 7, href: '/campaigns/directory?status=LIVE&sort=ENDING_SOON' });
    expect(data.work.waitingToLaunch.total).toBe(6);
    expect(data.work.waitingToLaunch.href).toBe('/campaigns/launch-queue');
    expect(data.work.waitingToLaunch.byReason.items.map((row) => [row.key, row.label, row.count, row.href])).toEqual([
      ['RESERVATION_FEE', 'Reservation fee', 0, '/campaigns/launch-queue?reason=RESERVATION_FEE'],
      ['PAYMENT', 'Payment', 1, '/campaigns/launch-queue?reason=PAYMENT'],
      ['DESIGN_QUOTE', 'Design quote', 0, '/campaigns/launch-queue?reason=DESIGN_QUOTE'],
      ['KYC', 'KYC', 3, '/campaigns/launch-queue?reason=KYC'],
      ['ARTWORK', 'Artwork', 2, '/campaigns/launch-queue?reason=ARTWORK'],
      ['PUBLISHER', 'Publisher', 1, '/campaigns/launch-queue?reason=PUBLISHER'],
      ['AGENT', 'Agent', 1, '/campaigns/launch-queue?reason=AGENT'],
    ]);
  });

  it('asks the work lists for the next seven UTC flight days from today in India', async () => {
    state.repository = inMemoryRepository(campaignsSeed());
    const launching = vi.spyOn(state.repository, 'campaignsLaunchingIn');
    const ending = vi.spyOn(state.repository, 'campaignsEndingIn');
    await sectionOverview('campaigns', QUERY, NOW);
    const range = { start: new Date('2026-09-15T00:00:00.000Z'), end: new Date('2026-09-22T00:00:00.000Z') };
    expect(launching).toHaveBeenCalledWith(range, expect.anything());
    expect(ending).toHaveBeenCalledWith(range, expect.anything());
  });

  it('lists the statuses in the lifecycle order, each opening the directory on that status', async () => {
    const data = await read();
    expect(data.breakdowns.byStatus.items.map((row) => [row.key, row.label, row.count, row.href])).toEqual([
      ['DRAFT', 'Draft', 3, '/campaigns/directory?status=DRAFT'],
      ['PENDING_PAYMENT', 'Awaiting payment', 4, '/campaigns/directory?status=PENDING_PAYMENT'],
      ['SCHEDULED', 'Scheduled', 2, '/campaigns/directory?status=SCHEDULED'],
      ['LIVE', 'Live', 5, '/campaigns/directory?status=LIVE'],
    ]);
  });

  it('breaks the book down by city, goal and advertiser', async () => {
    const data = await read();
    const bengaluru = data.breakdowns.byCity.items.find((row) => row.key === 'bengaluru')!;
    expect(bengaluru).toMatchObject({ label: 'Bengaluru', href: '/campaigns?city=bengaluru', count: 6, live: 3, bookedValue: '75000.00' });
    expect(data.breakdowns.byGoal.items[0]).toEqual({ key: 'BRAND_AWARENESS', label: 'Brand awareness', href: '/campaigns/directory?goal=BRAND_AWARENESS', count: 6, live: 3 });
    expect(data.breakdowns.byAdvertiser.items).toEqual([
      { key: 'adv_a', label: 'Name adv_a', displayId: 'D-adv_a', href: '/advertisers/adv_a', amount: '75000.00', count: 2 },
      { key: 'adv_b', label: 'Name adv_b', displayId: 'D-adv_b', href: '/advertisers/adv_b', amount: '40000.00', count: 1 },
    ]);
  });

  it('narrows to a city — the launch queue too — and caches per section, window and city', async () => {
    const data = await read({ ...QUERY, city: 'Bengaluru' });
    expect(data.city).toBe('Bengaluru');
    expect(data.tiles.paid.value).toBe(2);
    expect(data.breakdowns.byCity.items.map((row) => row.key)).toEqual(['bengaluru']);
    expect(state.campaigns.launchQueueSummary).toHaveBeenCalledWith({ city: 'Bengaluru', cityId: 'city_bengaluru' });
    expect(state.cache.readThrough).toHaveBeenCalledWith(sectionOverviewCacheKey('campaigns', '2026-09-01', '2026-09-10', 'Bengaluru'), 60, expect.any(Function));
  });
});
