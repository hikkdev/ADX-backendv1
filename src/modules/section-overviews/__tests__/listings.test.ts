import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, QUERY, labelsOf, listingsSeed } from './fixtures';
import { inMemoryRepository, type Seed } from './in-memory.repository';

/**
 * 2 Oct 2026: the Listings overview — the owner wanted an Overview tab first
 * on Listings, like every other section's.
 *
 * Pinned: the tiles against the previous window (total as at each close, new
 * and published in the window, bookings) and the three states (live,
 * awaiting review, suspended); the GMV as a money figure; the two series;
 * the three queues with the horizons their tabs read; the breakdowns by
 * status (in the lifecycle's order, each opening the directory on that
 * status), city (narrowing this overview), category (the directory on that
 * category) and publisher (labelled, the publisher's page); the city
 * filter; the cache key.
 */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  publishers: { findPublisherLabels: vi.fn() },
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
vi.mock('../../supply', () => ({ RISK_WINDOW_DAYS: { PERMANENT: 15, REMOVABLE: 7 } }));
vi.mock('../../publishers', () => state.publishers);
vi.mock('../../agents', () => ({}));
vi.mock('../../leads', () => ({}));
vi.mock('../../advertisers', () => ({}));
vi.mock('../../employees', () => ({}));
vi.mock('../../print-partners', () => ({}));
vi.mock('../../campaigns', () => ({ WAITING_REASONS: [], launchQueueSummary: async () => ({ total: 0, byReason: {} }) }));

import { SECTIONS, sectionOverview, sectionOverviewCacheKey, type ListingsOverview } from '../section-overviews.service';

const read = (query: { from?: string; to?: string; city?: string } = QUERY, seed: Seed = listingsSeed()) => {
  state.repository = inMemoryRepository(seed);
  return sectionOverview('listings', query, NOW) as Promise<ListingsOverview>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  state.publishers.findPublisherLabels.mockImplementation(labelsOf);
});

describe('the listings overview', () => {
  it('is a section of its own', () => {
    expect(SECTIONS).toContain('listings');
  });

  it('compares the window figures with the window before, and carries the states without a previous', async () => {
    const data = await read();
    expect(data.section).toBe('listings');
    expect(data.tiles.total).toEqual({ value: 9, previous: 6, delta: 3 });
    expect(data.tiles.newInWindow).toEqual({ value: 3, previous: 5, delta: -2 });
    expect(data.tiles.published).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(data.tiles.bookings).toEqual({ value: 3, previous: 1, delta: 2 });
    expect(data.tiles.live).toEqual({ value: 5, previous: null, delta: null });
    expect(data.tiles.awaitingReview).toEqual({ value: 2, previous: null, delta: null });
    expect(data.tiles.suspended).toEqual({ value: 2, previous: null, delta: null });
    expect(data.money.gmv).toEqual({ value: '2500.00', previous: '2000.00', delta: '500.00' });
  });

  it('draws a point for every day of the window, the previous window beside it', async () => {
    const data = await read();
    expect(data.series.newListings.days).toHaveLength(10);
    expect(data.series.newListings.previous).toHaveLength(10);
    expect(data.series.published.days.find((point) => point.day === '2026-09-02')?.value).toBe(1);
    expect(data.series.published.total).toEqual(data.tiles.published);
  });

  it('counts the three queues with the horizons their tabs read', async () => {
    const data = await read();
    expect(data.work).toEqual({
      renewals: { due: 4, lapsed: 1, horizonDays: 60 },
      claimsOpen: 3,
      verification: { due: 5, lapsed: 2, horizonDays: 15 },
    });
    expect(state.repository.calls).toContain('listingRenewalsDue');
    expect(state.repository.calls).toContain('listingVerificationsDue');
  });

  it('lists the statuses in the lifecycle order, each opening the directory on that status', async () => {
    const data = await read();
    expect(data.breakdowns.byStatus.items.map((row) => [row.key, row.label, row.count, row.href])).toEqual([
      ['DRAFT', 'Draft', 1, '/listings/directory?status=DRAFT'],
      ['PENDING_REVIEW', 'Pending review', 2, '/listings/directory?status=PENDING_REVIEW'],
      ['ACTIVE', 'Live', 5, '/listings/directory?status=ACTIVE'],
      ['SUSPENDED', 'Suspended', 1, '/listings/directory?status=SUSPENDED'],
    ]);
  });

  it('breaks the inventory down by city, category and publisher', async () => {
    const data = await read();
    const bengaluru = data.breakdowns.byCity.items.find((row) => row.key === 'bengaluru')!;
    expect(bengaluru).toMatchObject({ label: 'Bengaluru', href: '/listings?city=bengaluru', count: 6, live: 3, gmv: '1500.00' });
    expect(data.breakdowns.byCategory.items[0]).toEqual({ key: 'OUTDOOR', label: 'Outdoor', href: '/listings/directory?category=OUTDOOR', count: 6, live: 4, gmv: '2500.00' });
    expect(data.breakdowns.byPublisher.items[0]).toEqual({ key: 'pub_a', label: 'Name pub_a', displayId: 'D-pub_a', href: '/publishers/pub_a', count: 4, live: 1 });
  });

  it('narrows to a city, and caches per section, window and city', async () => {
    const data = await read({ ...QUERY, city: 'Bengaluru' });
    expect(data.city).toBe('Bengaluru');
    expect(data.tiles.newInWindow.value).toBe(2);
    expect(data.breakdowns.byCity.items.map((row) => row.key)).toEqual(['bengaluru']);
    expect(state.cache.readThrough).toHaveBeenCalledWith(sectionOverviewCacheKey('listings', '2026-09-01', '2026-09-10', 'Bengaluru'), 60, expect.any(Function));
  });
});
