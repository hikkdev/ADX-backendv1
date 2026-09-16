import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, QUERY, labelsOf, printPartnersSeed } from './fixtures';
import { inMemoryRepository } from './in-memory.repository';

/** O-B: the print partners overview — the quote and job series, the top ten by jobs, the turnaround and the awards share, the city filter and the cache key. */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  printPartners: { findPrintPartnerLabels: vi.fn() },
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

vi.mock('../../print-partners', () => state.printPartners);
vi.mock('../../supply', () => ({}));
vi.mock('../../advertisers', () => ({}));
vi.mock('../../publishers', () => ({}));
vi.mock('../../employees', () => ({}));
vi.mock('../../agents', () => ({}));

import { SECTION_OVERVIEW_CACHE_SECONDS, sectionOverview, sectionOverviewCacheKey, type PrintPartnersOverview } from '../section-overviews.service';

const read = (query: { from?: string; to?: string; city?: string } = QUERY) => {
  state.repository = inMemoryRepository(printPartnersSeed());
  return sectionOverview('print-partners', query, NOW) as Promise<PrintPartnersOverview>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  state.printPartners.findPrintPartnerLabels.mockImplementation(labelsOf);
});

describe('the print partners overview', () => {
  it('counts the population against the previous window and carries the states', async () => {
    const { tiles } = await read();
    expect(tiles.total).toEqual({ value: 9, previous: 6, delta: 3 });
    expect(tiles.newInWindow).toEqual({ value: 3, previous: 5, delta: -2 });
    expect(tiles.active).toEqual({ value: 8, previous: null, delta: null });
    expect(tiles.acceptingQuoteRequests).toEqual({ value: 5, previous: null, delta: null });
    expect(tiles.kyc).toEqual({ awaitingDocuments: 3, requested: 0, pending: 0, needsInfo: 0, rejected: 0, verified: 6 });
    expect(tiles.byCity.items.map((row) => [row.key, row.count])).toEqual([['bengaluru', 6], ['mumbai', 3]]);
  });

  it('answers quote requests, quotes received and jobs completed by day', async () => {
    const { series } = await read();
    expect(series.quoteRequestsSent.days[1]).toEqual({ day: '2026-09-02', value: 2 });
    expect(series.quoteRequestsSent.total).toEqual({ value: 3, previous: 1, delta: 2 });
    expect(series.quotesReceived.total).toEqual({ value: 4, previous: 1, delta: 3 });
    expect(series.jobsCompleted.days[8]).toEqual({ day: '2026-09-09', value: 2 });
    expect(series.jobsCompleted.total).toEqual({ value: 3, previous: 1, delta: 2 });
  });

  it('ranks the top ten by jobs with earnings as money and the partner\'s label', async () => {
    const { top } = await read();
    expect(top.byJobs).toMatchObject({ total: 2, page: 1, counts: {} });
    expect(top.byJobs.items[0]).toEqual({ key: 'prt_2', jobs: 1, earnings: '7000.00', label: 'Name prt_2', displayId: 'D-prt_2', href: '/print-partners/prt_2' });
    expect(top.byJobs.items[1]).toMatchObject({ key: 'prt_1', jobs: 2, earnings: '5000.00' });
  });

  it('answers the turnaround against the previous window and the awards share', async () => {
    const result = await read();
    expect(result.averageTurnaroundDays).toEqual({ value: 3.5, previous: 4.25, delta: -0.75 });
    expect(result.awardsWon).toEqual({ quotes: { value: 4, previous: 1, delta: 3 }, awarded: { value: 2, previous: 1, delta: 1 }, sharePct: '50.00' });
    expect(result.breakdowns.byCapability.items.map((row) => [row.key, row.count])).toEqual([['flex', 3], ['vinyl', 1]]);
  });

  it('narrows to a city', async () => {
    const result = await read({ ...QUERY, city: 'Mumbai' });
    expect(result.series.quoteRequestsSent.total).toEqual({ value: 1, previous: 0, delta: 1 });
    expect(result.awardsWon.sharePct).toBe('50.00');
    expect(result.top.byJobs.items.map((row) => row.key)).toEqual(['prt_2']);
    expect(result.breakdowns.byCity.items.map((row) => row.key)).toEqual(['mumbai']);
  });

  it('is cached a minute per section, window and city', async () => {
    await read({ ...QUERY, city: 'Mumbai' });
    expect(state.cache.readThrough).toHaveBeenCalledWith(sectionOverviewCacheKey('print-partners', '2026-09-01', '2026-09-10', 'Mumbai'), SECTION_OVERVIEW_CACHE_SECONDS, expect.any(Function));
    expect(sectionOverviewCacheKey('print-partners', '2026-09-01', '2026-09-10', 'Mumbai')).toBe('section-overviews:print-partners:2026-09-01:2026-09-10:mumbai');
  });
});
