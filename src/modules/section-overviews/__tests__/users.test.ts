import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, QUERY, usersSeed } from './fixtures';
import { inMemoryRepository } from './in-memory.repository';

/** O-B: the users overview — accounts by role, sign-ups and sign-ins by day, the shares as percentages, the city filter and the cache key. */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
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

vi.mock('../../supply', () => ({}));
vi.mock('../../advertisers', () => ({}));
vi.mock('../../publishers', () => ({}));
vi.mock('../../agents', () => ({}));
vi.mock('../../employees', () => ({}));
vi.mock('../../print-partners', () => ({}));

import { SECTION_OVERVIEW_CACHE_SECONDS, sectionOverview, sectionOverviewCacheKey, type UsersOverview } from '../section-overviews.service';

const read = (query: { from?: string; to?: string; city?: string } = QUERY) => {
  state.repository = inMemoryRepository(usersSeed());
  return sectionOverview('users', query, NOW) as Promise<UsersOverview>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
});

describe('the users overview', () => {
  it('counts accounts, newcomers and sign-ins against the previous window', async () => {
    const { tiles } = await read();
    expect(tiles.total).toEqual({ value: 9, previous: 6, delta: 3 });
    expect(tiles.newInWindow).toEqual({ value: 3, previous: 5, delta: -2 });
    expect(tiles.active).toEqual({ value: 3, previous: 2, delta: 1 });
    expect(tiles.closed).toEqual({ value: 2, previous: null, delta: null });
    expect(tiles.closedInWindow).toEqual({ value: 1, previous: 0, delta: 1 });
    expect(tiles.erasureRequestsOpen).toEqual({ value: 2, previous: null, delta: null });
  });

  it('folds the roles into the six the console prints, and the shares into percentages', async () => {
    const { tiles } = await read();
    expect(tiles.byRole).toEqual({ publisher: 10, advertiser: 8, agent: 5, printPartner: 4, admin: 4, none: 1 });
    expect(tiles.twoFactor).toEqual({ admins: 4, enrolled: 3, sharePct: '75.00' });
    expect(tiles.contactsVerified).toEqual({ verified: 30, total: 40, sharePct: '75.00' });
  });

  it('answers sign-ups and sign-ins by day on the seam', async () => {
    const { series } = await read();
    expect(series.signUps.days[0]).toEqual({ day: '2026-09-01', value: 1 });
    expect(series.signUps.total).toEqual({ value: 3, previous: 5, delta: -2 });
    expect(series.signIns.days[0]).toEqual({ day: '2026-09-01', value: 1 });
    expect(series.signIns.days[3]).toEqual({ day: '2026-09-04', value: 2 });
    expect(series.signIns.previous[9]).toEqual({ day: '2026-08-31', value: 1 });
    expect(series.signIns.total).toEqual({ value: 3, previous: 2, delta: 1 });
  });

  it('answers the breakdowns on the list contract with the role labels', async () => {
    const { breakdowns } = await read();
    expect(breakdowns.byRole).toMatchObject({ total: 6, page: 1, pageSize: 100, counts: {} });
    expect(breakdowns.byRole.items[2]).toEqual({ key: 'AGENT_PUBLISHER', label: 'Publisher agent', href: '/users?role=AGENT_PUBLISHER', count: 3 });
    expect(breakdowns.byLanguage.items.map((row) => [row.key, row.count])).toEqual([['en', 9], ['kn', 3]]);
    expect(breakdowns.byCity.items[0]).toEqual({ key: 'bengaluru', label: 'Bengaluru', href: '/users?city=bengaluru', cityId: 'city_bengaluru', typed: [], count: 12 });
  });

  it('narrows to the city a party gives', async () => {
    const result = await read({ ...QUERY, city: 'mumbai' });
    expect(result.tiles.newInWindow).toEqual({ value: 1, previous: 2, delta: -1 });
    expect(result.tiles.active).toEqual({ value: 1, previous: 1, delta: 0 });
    expect(result.breakdowns.byCity.items.map((row) => row.key)).toEqual(['mumbai']);
  });

  it('is cached a minute per section, window and city', async () => {
    await read();
    expect(state.cache.readThrough).toHaveBeenCalledWith(sectionOverviewCacheKey('users', '2026-09-01', '2026-09-10', undefined), SECTION_OVERVIEW_CACHE_SECONDS, expect.any(Function));
    expect(sectionOverviewCacheKey('users', '2026-09-01', '2026-09-10', undefined)).toBe('section-overviews:users:2026-09-01:2026-09-10:-');
  });
});
