import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two things DR 07 promises about offers, now real.
 *
 * "Frequent rejections lower your offer priority" — the count behind that
 * sentence: every offer an agent has had, folded into accepted, declined by
 * coded reason, and expired, for the console's agent page. And "Auto-accept
 * in my zone" — a spot in the agent's own city and home zone is accepted for
 * them the moment it is offered, through the same rows an answered offer
 * leaves, so the history reads true.
 */

const { repository, notify, listings, agents, logger } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findPendingAssignment: vi.fn(),
    findAssignments: vi.fn(),
    findAssignmentsForAgent: vi.fn(),
    createAssignment: vi.fn(),
    acceptAssignment: vi.fn(),
    rejectAssignment: vi.fn(),
    update: vi.fn(),
  },
  notify: { notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (id: string) => id.slice(-6) },
  listings: { getListingWithPublisher: vi.fn() },
  agents: { findAssignableAgent: vi.fn(), getAgentWithUser: vi.fn(), agentExists: vi.fn(), getAgentZone: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', () => listings);
vi.mock('../../agents', () => agents);
// Lot B: the offer carries a quote; these tests are about the zone, so it is left unpriced.
vi.mock('../../payouts', () => ({ installationFeeFor: vi.fn().mockResolvedValue(null), recordIncentiveOnce: vi.fn() }));
vi.mock('../../../shared/logging', () => ({ logger }));

import { agentOfferHistory, autoAssignAgent, foldOffers, inZone } from '../assignment/assignment.service';

const at = (iso: string) => new Date(iso);

describe('the count behind "frequent rejections lower your priority"', () => {
  it('folds every offer into accepted, declined by coded reason, and expired', () => {
    const history = foldOffers([
      { orderId: 'o1', status: 'ACCEPTED', rejectionReason: null, assignedAt: at('2026-09-10T08:00:00.000Z'), respondedAt: at('2026-09-10T08:05:00.000Z') },
      { orderId: 'o2', status: 'REJECTED', rejectionReason: 'TOO_FAR', assignedAt: at('2026-09-09T08:00:00.000Z'), respondedAt: at('2026-09-09T08:01:00.000Z') },
      { orderId: 'o3', status: 'REJECTED', rejectionReason: 'OTHER: Site closed', assignedAt: at('2026-09-08T08:00:00.000Z'), respondedAt: at('2026-09-08T08:01:00.000Z') },
      { orderId: 'o4', status: 'REJECTED', rejectionReason: 'EXPIRED', assignedAt: at('2026-09-07T08:00:00.000Z'), respondedAt: at('2026-09-07T08:25:00.000Z') },
      { orderId: 'o5', status: 'REJECTED', rejectionReason: 'TOO_FAR', assignedAt: at('2026-09-06T08:00:00.000Z'), respondedAt: at('2026-09-06T08:01:00.000Z') },
      { orderId: 'o6', status: 'PENDING', rejectionReason: null, assignedAt: at('2026-09-10T09:00:00.000Z'), respondedAt: null },
    ], new Date('2026-09-10T12:00:00.000Z'));
    expect(history).toMatchObject({ offered: 6, accepted: 1, pending: 1, declined: 3, expired: 1, byReason: { TOO_FAR: 2, OTHER: 1 } });
    // DR 07's lane, over the window: six offers, four declined or expired — slowed.
    expect(history.priority).toMatchObject({ lane: 'SLOWED', offered: 6, declined: 4, windowDays: 30 });
    expect(history.priority.declineRate).toBeCloseTo(4 / 6);
    expect(history.recent[0]).toEqual({ orderId: 'o1', status: 'ACCEPTED', reason: null, assignedAt: '2026-09-10T08:00:00.000Z', respondedAt: '2026-09-10T08:05:00.000Z' });
  });

  it('reads the agent’s rows newest first', async () => {
    repository.findAssignmentsForAgent.mockResolvedValue([]);
    expect(await agentOfferHistory('agt_1')).toMatchObject({ offered: 0, byReason: {}, priority: { lane: 'FAST', declineRate: null } });
    expect(repository.findAssignmentsForAgent).toHaveBeenCalledWith('agt_1');
  });
});

describe('in my zone', () => {
  const zone = { autoAcceptInZone: true, city: 'Bengaluru', homeZone: 'Koramangala' };

  it('is the same city, and the home zone named in the address when one is set', () => {
    expect(inZone(zone, { city: 'Bengaluru', address: 'Koramangala 5th Block' })).toBe(true);
    expect(inZone(zone, { city: 'bengaluru', address: '80 Feet Road, KORAMANGALA' })).toBe(true);
    expect(inZone(zone, { city: 'Bengaluru', address: 'Whitefield Main Road' })).toBe(false);
    expect(inZone(zone, { city: 'Mysuru', address: 'Koramangala' })).toBe(false);
    expect(inZone({ ...zone, homeZone: null }, { city: 'Bengaluru', address: 'Anywhere' })).toBe(true);
    expect(inZone({ ...zone, city: null }, { city: 'Bengaluru', address: 'Koramangala' })).toBe(false);
  });
});

describe('auto-accept when the spot is in the zone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.findById.mockResolvedValue({ id: 'ord_1', listingId: 'lst_1', agentRejectionCount: 0, status: 'PENDING_AGENT' });
    repository.findAssignments.mockResolvedValue([]);
    repository.findPendingAssignment.mockResolvedValue({ id: 'asg_1', orderId: 'ord_1', agentId: 'agt_1' });
    listings.getListingWithPublisher.mockResolvedValue({ id: 'lst_1', city: 'Bengaluru', address: 'Koramangala 5th Block', publisher: { agentId: null } });
    agents.findAssignableAgent.mockResolvedValue({ id: 'agt_1' });
    agents.getAgentWithUser.mockResolvedValue({ id: 'agt_1', userId: 'usr_1' });
  });

  it('accepts the offer for the agent, through the same rows, and tells them', async () => {
    agents.getAgentZone.mockResolvedValue({ autoAcceptInZone: true, city: 'Bengaluru', homeZone: 'Koramangala' });
    await autoAssignAgent('ord_1');
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_1', null);
    expect(repository.acceptAssignment).toHaveBeenCalledWith('asg_1', 'ord_1', 'agt_1');
    expect(notify.notifyAgent).toHaveBeenCalledWith('agt_1', 'Order accepted for you', expect.stringContaining('in your zone'), 'ord_1');
  });

  it('leaves the offer on the sheet when the switch is off, or the spot is elsewhere', async () => {
    agents.getAgentZone.mockResolvedValue({ autoAcceptInZone: false, city: 'Bengaluru', homeZone: 'Koramangala' });
    await autoAssignAgent('ord_1');
    expect(repository.acceptAssignment).not.toHaveBeenCalled();
    expect(notify.notifyAgent).toHaveBeenCalledWith('agt_1', 'New order assigned', expect.any(String), 'ord_1');

    vi.clearAllMocks();
    repository.findById.mockResolvedValue({ id: 'ord_1', listingId: 'lst_1', agentRejectionCount: 0, status: 'PENDING_AGENT' });
    repository.findAssignments.mockResolvedValue([]);
    listings.getListingWithPublisher.mockResolvedValue({ id: 'lst_1', city: 'Mysuru', address: 'Some road', publisher: { agentId: null } });
    agents.findAssignableAgent.mockResolvedValue({ id: 'agt_1' });
    agents.getAgentWithUser.mockResolvedValue({ id: 'agt_1', userId: 'usr_1' });
    agents.getAgentZone.mockResolvedValue({ autoAcceptInZone: true, city: 'Bengaluru', homeZone: null });
    await autoAssignAgent('ord_1');
    expect(repository.acceptAssignment).not.toHaveBeenCalled();
  });
});
