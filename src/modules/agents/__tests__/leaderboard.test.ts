import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 05 — the leaderboard.
 *
 * Pinned: ranking is by earnings as Decimal, gaps are Decimal subtraction;
 * only the podium's three figures and the viewer's own leave the server
 * (decision 9); the delta is against the previous rolling window; below
 * MIN_COHORT there is no board; and there is no prize.
 */

const { repository, agents } = vi.hoisted(() => ({
  repository: { cohort: vi.fn(), earningsByAgent: vi.fn(), leadFiguresByAgent: vi.fn() },
  agents: { findByUserId: vi.fn() },
}));

vi.mock('../leaderboard/prisma-leaderboard.repository', () => ({ prismaLeaderboardRepository: repository }));
vi.mock('../prisma-agents.repository', () => ({ prismaAgentsRepository: agents }));
// Lot X-B: the cohort is keyed — the desk's `?city=` resolves through pricing; the agent's own key comes off the profile.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
}));

import { Decimal } from '../../../shared/money';
import { periodWindow, rank, viewFor } from '../leaderboard/leaderboard.rules';
import { getLeaderboardForCity, getMyLeaderboard } from '../leaderboard/leaderboard.service';
import { MIN_COHORT } from '../rating/rating.rules';

const NOW = new Date('2026-09-11T06:00:00.000Z');

const cohort = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    agentId: `agt_${i + 1}`,
    userId: `usr_${i + 1}`,
    name: `Agent ${String(i + 1).padStart(2, '0')}`,
    locality: i % 2 ? 'HSR Layout' : 'Indiranagar',
  }));

/** Agent k earns (n - k + 1) × 1000 this period, so agt_1 leads. */
const earnings = (n: number, shift = 0) =>
  new Map(Array.from({ length: n }, (_, i) => [`agt_${i + 1}`, new Decimal((n - i + shift) * 1000)]));

/** LH8: nothing from leads unless a test says so. */
const noLeads = { fromLeads: new Decimal(0), conversions: 0 };
const competitor = (over: Partial<{ agentId: string; name: string; locality: string | null; earnings: Decimal; fromLeads: Decimal; conversions: number }> & { agentId: string; name: string; earnings: Decimal }) => ({ locality: null, ...noLeads, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  agents.findByUserId.mockResolvedValue({ id: 'agt_12', city: 'Bengaluru' });
  repository.cohort.mockResolvedValue(cohort(13));
  repository.leadFiguresByAgent.mockResolvedValue(new Map());
});

describe('the rules', () => {
  it('rolls a week and a month back from now, and the previous window ends where this one starts', () => {
    const week = periodWindow('WEEK', NOW);
    expect(week.from?.toISOString()).toBe('2026-09-04T06:00:00.000Z');
    expect(week.previous).toEqual({ from: new Date('2026-08-28T06:00:00.000Z'), to: week.from });
    expect(periodWindow('ALL', NOW)).toEqual({ from: null, to: NOW, previous: null });
  });

  it('ranks by earnings as Decimal, then name', () => {
    const ranked = rank([
      competitor({ agentId: 'b', name: 'Bea', earnings: new Decimal('1000.50') }),
      competitor({ agentId: 'a', name: 'Al', earnings: new Decimal('1000.50') }),
      competitor({ agentId: 'c', name: 'Cy', earnings: new Decimal('1000.49') }),
    ]);
    expect(ranked.map((r) => `${r.rank}:${r.agentId}`)).toEqual(['1:a', '2:b', '3:c']);
  });

  it('shows the podium with figures, ranks 4–10 without, and the viewer\'s own gaps', () => {
    const ranked = rank(cohort(13).map((m, i) => ({ ...m, ...noLeads, earnings: new Decimal((13 - i) * 1000) })));
    const view = viewFor(ranked, 'agt_12', null);
    expect(view.top.map((r) => r.earnings)).toEqual(['13000.00', '12000.00', '11000.00']);
    expect(view.window.map((r) => r.rank)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(view.window[0]).not.toHaveProperty('earnings');
    expect(view.window[0]).not.toHaveProperty('fromLeads');
    expect(view.me).toEqual({
      rank: 12,
      earnings: '2000.00',
      fromLeads: '0.00',
      delta: null,
      behind: { rank: 11, gap: '1000.00' },
      ahead: { rank: 13, gap: '1000.00' },
    });
    expect(view.around.map((r) => `${r.rank}${r.you ? '*' : ''}`)).toEqual(['11', '12*', '13']);
  });

  it('draws no rows around a viewer already on the first page', () => {
    const ranked = rank(cohort(13).map((m, i) => ({ ...m, ...noLeads, earnings: new Decimal((13 - i) * 1000) })));
    const view = viewFor(ranked, 'agt_2', null);
    expect(view.around).toEqual([]);
    expect(view.top[1]?.you).toBe(true);
    expect(view.me?.behind).toEqual({ rank: 1, gap: '1000.00' });
  });
});

describe('the board', () => {
  it('is withheld below the cohort floor', async () => {
    repository.cohort.mockResolvedValue(cohort(MIN_COHORT - 1));
    const board = await getMyLeaderboard('usr_12', 'WEEK', NOW);
    expect(board.cohort).toEqual({ city: 'Bengaluru', size: MIN_COHORT - 1, minimum: MIN_COHORT, enough: false });
    expect(board.top).toEqual([]);
    expect(board.me).toBeNull();
    expect(repository.earningsByAgent).not.toHaveBeenCalled();
  });

  it('measures the delta against the previous window', async () => {
    // This week agt_12 is 12th; last week they were 9th (three ahead of them earned nothing then).
    repository.earningsByAgent.mockImplementation(async (_ids, window) => {
      if (window.from?.toISOString() === '2026-09-04T06:00:00.000Z') return earnings(13);
      const before = earnings(13);
      before.set('agt_9', new Decimal(0));
      before.set('agt_10', new Decimal(0));
      before.set('agt_11', new Decimal(0));
      return before;
    });
    const board = await getMyLeaderboard('usr_12', 'WEEK', NOW);
    expect(board.me?.rank).toBe(12);
    expect(board.me?.delta).toBe(-3);
    expect(board.prize).toBeNull();
  });

  it('has no delta on all time, and an agent with no city has no board', async () => {
    repository.earningsByAgent.mockResolvedValue(earnings(13));
    const all = await getMyLeaderboard('usr_12', 'ALL', NOW);
    expect(all.me?.delta).toBeNull();
    expect(repository.earningsByAgent).toHaveBeenCalledTimes(1);

    agents.findByUserId.mockResolvedValue({ id: 'agt_1', city: null });
    const none = await getMyLeaderboard('usr_1', 'WEEK', NOW);
    expect(none.cohort.enough).toBe(false);
  });

  it('serves the console a city with nobody\'s own row', async () => {
    repository.earningsByAgent.mockResolvedValue(earnings(13));
    const board = await getLeaderboardForCity('Bengaluru', 'MONTH', NOW);
    expect(board.me).toBeNull();
    expect(board.top).toHaveLength(3);
    // The desk sees the whole cohort ranked, not only 4–10.
    expect(board.window).toHaveLength(10);
    expect(board.window[board.window.length - 1]?.rank).toBe(13);
  });
});

describe('the "from leads" column (LH8)', () => {
  it('prints the hunt\'s share on the podium and the viewer\'s own row, and only a count of conversions on everyone else', async () => {
    repository.earningsByAgent.mockResolvedValue(earnings(13));
    repository.leadFiguresByAgent.mockResolvedValue(new Map([
      ['agt_1', { fromLeads: new Decimal('1200.00'), conversions: 4 }],
      ['agt_5', { fromLeads: new Decimal('300.00'), conversions: 2 }],
      ['agt_12', { fromLeads: new Decimal('100.00'), conversions: 1 }],
    ]));
    const board = await getMyLeaderboard('usr_12', 'MONTH', NOW);
    // Read once, for the current window only — the delta ranks on earnings alone.
    expect(repository.leadFiguresByAgent).toHaveBeenCalledTimes(1);
    expect(repository.leadFiguresByAgent.mock.calls[0]?.[1]).toEqual({ from: new Date('2026-08-12T06:00:00.000Z'), to: NOW });
    expect(board.top[0]).toMatchObject({ agentId: 'agt_1', earnings: '13000.00', fromLeads: '1200.00', conversions: 4 });
    expect(board.top[1]).toMatchObject({ fromLeads: '0.00', conversions: 0 });
    const fifth = board.window.find((row) => row.agentId === 'agt_5');
    expect(fifth).toMatchObject({ conversions: 2 });
    expect(fifth).not.toHaveProperty('fromLeads');
    expect(board.me).toMatchObject({ rank: 12, earnings: '2000.00', fromLeads: '100.00' });
  });

  it('the desk\'s board carries the count on every row too', async () => {
    repository.earningsByAgent.mockResolvedValue(earnings(13));
    repository.leadFiguresByAgent.mockResolvedValue(new Map([['agt_13', { fromLeads: new Decimal('100.00'), conversions: 1 }]]));
    const board = await getLeaderboardForCity('Bengaluru', 'WEEK', NOW);
    expect(board.window[board.window.length - 1]).toMatchObject({ rank: 13, conversions: 1 });
  });
});

describe('the cohort by city key (Lot X-B)', () => {
  it('the agent\'s own board is keyed off the profile; the desk\'s board resolves the slug or name it is given, the spelling riding as the fallback', async () => {
    agents.findByUserId.mockResolvedValue({ id: 'agt_12', city: 'Bangalore', cityId: 'city_bengaluru' });
    await getMyLeaderboard('usr_12', 'MONTH', NOW);
    expect(repository.cohort).toHaveBeenCalledWith({ cityId: 'city_bengaluru', spelling: 'Bangalore' });

    await getLeaderboardForCity('bengaluru', 'MONTH', NOW);
    expect(repository.cohort).toHaveBeenLastCalledWith({ cityId: 'city_bengaluru', spelling: 'bengaluru' });

    // A typed town nobody catalogued: the spelling alone.
    await getLeaderboardForCity('Rameswaram', 'MONTH', NOW);
    expect(repository.cohort).toHaveBeenLastCalledWith({ cityId: null, spelling: 'Rameswaram' });
  });

  it('a profile typed under a town with no key still finds its cohort by the spelling', async () => {
    agents.findByUserId.mockResolvedValue({ id: 'agt_12', city: 'Rameswaram', cityId: null });
    await getMyLeaderboard('usr_12', 'MONTH', NOW);
    expect(repository.cohort).toHaveBeenCalledWith({ cityId: null, spelling: 'Rameswaram' });
  });
});
