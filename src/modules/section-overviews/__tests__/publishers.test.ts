import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, PREVIOUS_START, QUERY, WINDOW_END, WINDOW_START, labelsOf, publishersSeed } from './fixtures';
import { inMemoryRepository, type Seed } from './in-memory.repository';

/**
 * O-B: the publishers overview — the window and previous-window maths, the
 * delta's sign, the cache key, the city filter, the supply funnel reused
 * through supply's export, and the list contract on the breakdowns.
 */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  supply: { supplyFunnel: vi.fn() },
  publishers: { findPublisherLabels: vi.fn() },
  agents: { findAgentLabels: vi.fn() },
}));

vi.mock('../prisma-section-overviews.repository', () => ({
  prismaSectionOverviewsRepository: new Proxy({}, { get: (_target, property) => (state.repository as unknown as Record<PropertyKey, unknown>)[property] }),
}));
vi.mock('../../../shared/cache', () => state.cache);
// Lot X-B: `?city=` resolves once through pricing — Bengaluru and Mumbai are catalogued (by name or slug), anything else is a typed town.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => {
    const key = (name ?? '').trim().toLowerCase();
    return key === 'bengaluru' || key === 'bangalore' ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : key === 'mumbai' ? { cityId: 'city_mumbai', slug: 'mumbai' } : null;
  },
}));

vi.mock('../../supply', () => state.supply);
vi.mock('../../publishers', () => state.publishers);
vi.mock('../../agents', () => state.agents);
vi.mock('../../advertisers', () => ({}));
vi.mock('../../employees', () => ({}));
vi.mock('../../print-partners', () => ({}));

import { SECTION_OVERVIEW_CACHE_SECONDS, sectionOverview, sectionOverviewCacheKey, type PublishersOverview } from '../section-overviews.service';

const FUNNEL = {
  accountsCreated: 9,
  kycVerified: 7,
  platformAgreementAccepted: 6,
  withInventory: 6,
  listingAgreementAccepted: 5,
  listingsLive: 8,
  stuckOnPublisher: { awaitingAgreement: 1, awaitingDocuments: 1 },
  stuckOnAdx: { pendingDocumentReview: 0, awaitingSiteVerification: 1 },
};

const read = (query: { from?: string; to?: string; city?: string } = QUERY, seed: Seed = publishersSeed()) => {
  state.repository = inMemoryRepository(seed);
  return sectionOverview('publishers', query, NOW) as Promise<PublishersOverview>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  state.supply.supplyFunnel.mockResolvedValue(FUNNEL);
  state.publishers.findPublisherLabels.mockImplementation(labelsOf);
  state.agents.findAgentLabels.mockImplementation(labelsOf);
});

describe('the window', () => {
  it('opens at from\'s IST midnight, closes after to, and puts the previous window immediately before', async () => {
    const result = await read();
    expect(result.window).toMatchObject({ from: '2026-09-01', to: '2026-09-10', days: 10, start: WINDOW_START.toISOString(), end: WINDOW_END.toISOString() });
    expect(result.previousWindow).toMatchObject({ from: '2026-08-22', to: '2026-08-31', days: 10, start: PREVIOUS_START.toISOString(), end: WINDOW_START.toISOString() });
  });

  it('defaults to the last thirty Indian days ending today', async () => {
    const result = await read({});
    expect(result.window).toMatchObject({ from: '2026-08-17', to: '2026-09-15', days: 30 });
    expect(result.previousWindow).toMatchObject({ from: '2026-07-18', to: '2026-08-16', days: 30 });
  });

  it('refuses to before from, and more than a year', async () => {
    await expect(read({ from: '2026-09-10', to: '2026-09-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(read({ from: '2025-01-01', to: '2026-03-01' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('the tiles', () => {
  it('counts the window and the one before it, with the delta signed', async () => {
    const { tiles } = await read();
    // Three created 1–10 Sep (one at 00:15 IST on the 1st), five 22–31 Aug (one at 23:30 IST on the 31st).
    expect(tiles.newInWindow).toEqual({ value: 3, previous: 5, delta: -2 });
    // The population as at each window's close: 9 by 11 Sep, 6 by 1 Sep.
    expect(tiles.total).toEqual({ value: 9, previous: 6, delta: 3 });
  });

  it('carries the states without a previous — the platform keeps no history of them', async () => {
    const { tiles } = await read();
    expect(tiles.active).toEqual({ value: 6, previous: null, delta: null });
    expect(tiles.suspended).toEqual({ value: 1, previous: null, delta: null });
    expect(tiles.closed).toEqual({ value: 2, previous: null, delta: null });
    expect(tiles.kyc).toEqual({ awaitingDocuments: 4, requested: 1, pending: 2, needsInfo: 1, rejected: 0, verified: 7 });
  });

  it('reuses the supply funnel through its export', async () => {
    const result = await read();
    expect(result.funnel).toEqual(FUNNEL);
    expect(state.supply.supplyFunnel).toHaveBeenCalledTimes(1);
  });
});

describe('the series', () => {
  it('fills every day of both windows and totals them', async () => {
    const { series } = await read();
    expect(series.newPublishers.days).toHaveLength(10);
    expect(series.newPublishers.previous).toHaveLength(10);
    expect(series.newPublishers.days[0]).toEqual({ day: '2026-09-01', value: 1 });
    expect(series.newPublishers.days[2]).toEqual({ day: '2026-09-03', value: 1 });
    expect(series.newPublishers.days[9]).toEqual({ day: '2026-09-10', value: 1 });
    expect(series.newPublishers.previous[9]).toEqual({ day: '2026-08-31', value: 1 });
    expect(series.newPublishers.previous[0]).toEqual({ day: '2026-08-22', value: 1 });
    expect(series.newPublishers.total).toEqual({ value: 3, previous: 5, delta: -2 });
  });

  it('answers first listings and first bookings by day', async () => {
    const { series } = await read();
    expect(series.firstListingsPublished.days.find((point) => point.day === '2026-09-02')).toEqual({ day: '2026-09-02', value: 2 });
    expect(series.firstListingsPublished.total).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(series.firstBookings.total).toEqual({ value: 1, previous: 1, delta: 0 });
  });
});

describe('the money', () => {
  it('answers decimal strings with a signed delta', async () => {
    const { money } = await read();
    expect(money.earningsPaid).toEqual({ value: '5000.25', previous: '4000.00', delta: '1000.25' });
    expect(money.payoutsReleased).toEqual({ value: '2000.00', previous: '2500.00', delta: '-500.00' });
  });

  it('ranks the top ten by earnings with the publisher\'s label and console route', async () => {
    const { top } = await read();
    expect(top.byEarnings).toMatchObject({ total: 2, page: 1, counts: {} });
    expect(top.byEarnings.items[0]).toEqual({ key: 'pub_b', amount: '3000.00', label: 'Name pub_b', displayId: 'D-pub_b', href: '/publishers/pub_b' });
    expect(top.byEarnings.items[1]).toMatchObject({ key: 'pub_a', amount: '2000.25' });
    expect(state.publishers.findPublisherLabels).toHaveBeenCalledWith(['pub_b', 'pub_a']);
  });
});

describe('the breakdowns', () => {
  it('answer the list contract', async () => {
    const { breakdowns } = await read();
    expect(breakdowns.byCity).toMatchObject({ total: 2, page: 1, pageSize: 100, counts: {} });
    // Lot X-B: keyed by the slug, labelled from the catalogue, the key beside it.
    expect(breakdowns.byCity.items[0]).toEqual({ key: 'bengaluru', label: 'Bengaluru', href: '/publishers?city=bengaluru', cityId: 'city_bengaluru', typed: [], count: 6, listings: 12, gmv: '2000.25' });
    expect(breakdowns.byCategory.items[0]).toMatchObject({ key: 'OUTDOOR', label: 'Outdoor', publishers: 3, listings: 5 });
    expect(breakdowns.bySubscriptionTier.items.map((row) => row.key)).toEqual(['PLUS', 'STANDARD']);
    expect(breakdowns.byAgent.items[0]).toEqual({ key: 'agt_1', count: 5, label: 'Name agt_1', displayId: 'D-agt_1', href: '/agents/agt_1' });
  });
});

describe('the city filter', () => {
  it('narrows every window figure to the publisher\'s city, case-insensitively', async () => {
    const result = await read({ ...QUERY, city: 'bengaluru' });
    expect(result.city).toBe('bengaluru');
    expect(result.tiles.newInWindow).toEqual({ value: 2, previous: 3, delta: -1 });
    expect(result.money.earningsPaid.value).toBe('2000.25');
    expect(result.top.byEarnings.items.map((row) => row.key)).toEqual(['pub_a']);
    expect(result.breakdowns.byCity.items.map((row) => row.key)).toEqual(['bengaluru']);
    expect(state.repository.calls.length).toBeGreaterThan(0);
  });

  /* Lot X-B */
  it('resolves the facet to its key once and hands the repository both the key and the spelling', async () => {
    const seed = publishersSeed();
    const calls: unknown[][] = [];
    state.repository = new Proxy(inMemoryRepository(seed), {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === 'publishersByCity') return (...args: unknown[]) => { calls.push(args); return (value as (...a: unknown[]) => unknown).apply(target, args); };
        return value;
      },
    });
    await sectionOverview('publishers', { ...QUERY, city: 'Bangalore' }, NOW);
    expect(calls[0]![1]).toEqual({ city: 'Bangalore', cityId: 'city_bengaluru' });
    await sectionOverview('publishers', { ...QUERY, city: 'Rameswaram' }, NOW);
    expect(calls[1]![1]).toEqual({ city: 'Rameswaram', cityId: null });
    await sectionOverview('publishers', QUERY, NOW);
    expect(calls[2]![1]).toEqual({ city: undefined, cityId: undefined });
  });

  it('draws the rows typed under towns with no key as one "Other (typed)" bucket, the strings listed under it, with no link', async () => {
    const result = await read(QUERY, { ...publishersSeed(), typedCities: { strings: ['Blore', 'Rameswaram'], count: 2 } });
    const other = result.breakdowns.byCity.items.find((row) => row.key === 'other')!;
    expect(other).toEqual({ key: 'other', label: 'Other (typed)', href: null, cityId: null, typed: ['Blore', 'Rameswaram'], count: 2, listings: 4, gmv: '0.00' });
    expect(result.breakdowns.byCity.items.map((row) => row.key)).toEqual(['bengaluru', 'mumbai', 'other']);
  });
});

describe('the cache', () => {
  it('is a minute per section, window and city', async () => {
    await read({ ...QUERY, city: ' Bengaluru ' });
    expect(state.cache.readThrough).toHaveBeenCalledWith(
      sectionOverviewCacheKey('publishers', '2026-09-01', '2026-09-10', 'Bengaluru'),
      SECTION_OVERVIEW_CACHE_SECONDS,
      expect.any(Function),
    );
    expect(sectionOverviewCacheKey('publishers', '2026-09-01', '2026-09-10', 'Bengaluru')).toBe('section-overviews:publishers:2026-09-01:2026-09-10:bengaluru');
    expect(sectionOverviewCacheKey('publishers', '2026-09-01', '2026-09-10', undefined)).toBe('section-overviews:publishers:2026-09-01:2026-09-10:-');
    expect(SECTION_OVERVIEW_CACHE_SECONDS).toBe(60);
  });

  it('serves a hit without touching the repository', async () => {
    state.cache.readThrough.mockResolvedValue({ section: 'publishers', cached: true });
    const result = await read();
    expect(result).toEqual({ section: 'publishers', cached: true });
    expect(state.repository.calls).toEqual([]);
  });
});
