import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, QUERY, agentsSeed, labelsOf } from './fixtures';
import { inMemoryRepository } from './in-memory.repository';

/** O-B: the agents overview — activity, the three series, the top ten by commission, the leaderboard through agents' export, the city filter and the cache key. */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  agents: { findAgentLabels: vi.fn(), getLeaderboardForCity: vi.fn() },
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

vi.mock('../../agents', () => state.agents);
vi.mock('../../supply', () => ({}));
vi.mock('../../advertisers', () => ({}));
vi.mock('../../publishers', () => ({}));
vi.mock('../../employees', () => ({}));
vi.mock('../../print-partners', () => ({}));

import { SECTION_OVERVIEW_CACHE_SECONDS, sectionOverview, sectionOverviewCacheKey, type AgentsOverview } from '../section-overviews.service';

const BOARD = { period: 'MONTH', cohort: { city: 'Bengaluru', size: 12, minimum: 5, enough: true }, me: null, top: [{ rank: 1, agentId: 'agt_2', name: 'Two', locality: null, you: false, earnings: '1200.00' }], window: [], around: [], prize: null };

const read = (query: { from?: string; to?: string; city?: string } = QUERY) => {
  state.repository = inMemoryRepository(agentsSeed());
  return sectionOverview('agents', query, NOW) as Promise<AgentsOverview>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  state.agents.findAgentLabels.mockImplementation(labelsOf);
  state.agents.getLeaderboardForCity.mockResolvedValue(BOARD);
});

describe('the agents overview', () => {
  it('counts the population, the newcomers and the active against the previous window', async () => {
    const { tiles } = await read();
    expect(tiles.total).toEqual({ value: 9, previous: 6, delta: 3 });
    expect(tiles.newInWindow).toEqual({ value: 3, previous: 5, delta: -2 });
    // agt_1 and agt_2 had a job or a visit in the window; agt_3 and agt_4 in the one before.
    expect(tiles.active).toEqual({ value: 2, previous: 2, delta: 0 });
    expect(tiles.byRole).toEqual({ publisherAgents: 5, advertiserAgents: 3 });
    expect(tiles.byTier.items.map((row) => [row.key, row.label, row.count])).toEqual([['BRONZE', 'Bronze', 6], ['SILVER', 'Silver', 2]]);
    expect(tiles.kyc.verified).toBe(7);
    expect(tiles.suspended).toEqual({ value: 1, previous: null, delta: null });
  });

  it('answers onboardings, visits and jobs by day on the seam', async () => {
    const { series } = await read();
    expect(series.onboardingsDone.days[0]).toEqual({ day: '2026-09-01', value: 1 });
    expect(series.onboardingsDone.previous[9]).toEqual({ day: '2026-08-31', value: 1 });
    expect(series.onboardingsDone.total).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(series.visitsCompleted.total).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(series.jobsCompleted.total).toEqual({ value: 1, previous: 2, delta: -1 });
  });

  it('ranks the top ten by commission and sums the incentives paid as money', async () => {
    const { top, money } = await read();
    expect(top.byCommission.items.map((row) => [row.key, row.amount, row.label, row.href])).toEqual([
      ['agt_2', '1200.00', 'Name agt_2', '/agents/agt_2'],
      ['agt_1', '800.00', 'Name agt_1', '/agents/agt_1'],
    ]);
    expect(money.incentivesPaid).toEqual({ value: '2000.00', previous: '300.00', delta: '1700.00' });
  });

  it('carries the leaderboard only for a city, through the agents export', async () => {
    const without = await read();
    expect(without.top.leaderboard).toBeNull();
    expect(state.agents.getLeaderboardForCity).not.toHaveBeenCalled();

    const withCity = await read({ ...QUERY, city: 'Bengaluru' });
    expect(withCity.top.leaderboard).toEqual(BOARD);
    expect(state.agents.getLeaderboardForCity).toHaveBeenCalledWith('Bengaluru', 'MONTH', NOW);
  });

  it('narrows to a city and answers the breakdowns on the list contract', async () => {
    const result = await read({ ...QUERY, city: 'mumbai' });
    expect(result.tiles.newInWindow).toEqual({ value: 1, previous: 2, delta: -1 });
    expect(result.money.incentivesPaid).toEqual({ value: '0.00', previous: '300.00', delta: '-300.00' });
    expect(result.breakdowns.byCity).toMatchObject({ total: 1, page: 1, pageSize: 100, counts: {} });
    expect(result.breakdowns.byCity.items[0]).toEqual({ key: 'mumbai', label: 'Mumbai', href: '/agents?city=mumbai', cityId: 'city_mumbai', typed: [], count: 3 });
  });

  it('is cached a minute per section, window and city', async () => {
    await read();
    expect(state.cache.readThrough).toHaveBeenCalledWith(sectionOverviewCacheKey('agents', '2026-09-01', '2026-09-10', undefined), SECTION_OVERVIEW_CACHE_SECONDS, expect.any(Function));
    expect(sectionOverviewCacheKey('agents', '2026-09-01', '2026-09-10', undefined)).toBe('section-overviews:agents:2026-09-01:2026-09-10:-');
  });
});
