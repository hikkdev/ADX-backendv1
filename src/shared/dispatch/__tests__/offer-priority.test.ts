import { describe, expect, it } from 'vitest';

/**
 * DR 07's sentence to agents, as a rule: "Frequent rejections lower your
 * offer priority. Keep rejections under 10% to stay in the fast lane."
 *
 * What is pinned: the lane and the number behind it; too few offers to
 * judge is the fast lane; the sweep's order — fast lane, then the lower
 * decline rate, then the lighter load, then seniority — and that a full
 * agent is skipped however good their lane.
 */

import { pickAssignable, priorityOf, priorityWindowStart, rankCandidates } from '../offer-priority';

const offers = (declined: number, answered: number) => [
  ...Array.from({ length: declined }, () => ({ status: 'REJECTED' })),
  ...Array.from({ length: answered }, () => ({ status: 'ACCEPTED' })),
];

const agent = (id: string, over: Partial<Parameters<typeof rankCandidates>[0][number]> = {}) => ({
  id,
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  maxActiveOrders: null,
  activeOrders: 0,
  recentOffers: [],
  ...over,
});

describe('the lane', () => {
  it('is the fast lane at or under ten percent declined, slowed above it', () => {
    expect(priorityOf(offers(1, 9))).toMatchObject({ lane: 'FAST', offered: 10, declined: 1, declineRate: 0.1 });
    expect(priorityOf(offers(2, 8))).toMatchObject({ lane: 'SLOWED', declineRate: 0.2 });
  });

  it('is the fast lane with too few offers to judge, and says so with a null rate', () => {
    expect(priorityOf(offers(3, 1))).toMatchObject({ lane: 'FAST', offered: 4, declined: 3, declineRate: null, windowDays: 30 });
  });

  it('opens the window thirty days back', () => {
    expect(priorityWindowStart(new Date('2026-09-10T12:00:00.000Z')).toISOString()).toBe('2026-08-11T12:00:00.000Z');
  });
});

describe('the sweep’s order', () => {
  it('offers to the fast lane first, then the lower decline rate, then the lighter load, then seniority', () => {
    const ranked = rankCandidates([
      agent('slowed', { recentOffers: offers(3, 7) }),
      agent('busy', { activeOrders: 2 }),
      agent('junior', { createdAt: new Date('2026-08-01T00:00:00.000Z') }),
      agent('senior'),
      agent('fast-but-some', { recentOffers: offers(1, 19) }),
    ]).map((candidate) => candidate.id);
    expect(ranked).toEqual(['senior', 'junior', 'busy', 'fast-but-some', 'slowed']);
  });

  it('skips a full agent whatever their lane, and finds nobody when everyone is full', () => {
    const full = agent('full', { maxActiveOrders: 1, activeOrders: 1 });
    const slowed = agent('slowed', { recentOffers: offers(5, 5) });
    expect(pickAssignable([full, slowed])?.id).toBe('slowed');
    expect(pickAssignable([full])).toBeNull();
  });
});
