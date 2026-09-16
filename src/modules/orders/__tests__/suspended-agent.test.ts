import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A on the order lane.
 *
 * Two things are pinned. The publisher's own agent keeps offer priority only
 * while they are being offered work at all — a suspended one falls through to
 * the ordinary sweep rather than being handed every job at their own
 * publisher's spots. And STOP_OPEN_WORK hands back what they are already
 * holding, through the same reject-and-re-offer a decline takes, so no order
 * is left sitting on a suspended agent.
 */

const { repository, notify, listings, agents, logging } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findPendingAssignment: vi.fn(),
    findPendingAssignmentsForAgent: vi.fn(),
    findAssignments: vi.fn(),
    createAssignment: vi.fn(),
    acceptAssignment: vi.fn(),
    rejectAssignment: vi.fn(),
    update: vi.fn(),
  },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (id: string) => id.slice(0, 6) },
  listings: { getListingWithPublisher: vi.fn() },
  agents: {
    findAssignableAgent: vi.fn(),
    getAgentWithUser: vi.fn(),
    agentExists: vi.fn(),
    getAgentZone: vi.fn(),
    agentAcceptsWork: vi.fn(),
    assertAgentAcceptsWork: vi.fn(),
  },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', () => listings);
vi.mock('../../agents', () => agents);
// Lot B: the offer carries a quote; these tests are about suspension, so it is left unpriced.
vi.mock('../../payouts', () => ({ installationFeeFor: vi.fn().mockResolvedValue(null), recordIncentiveOnce: vi.fn() }));
vi.mock('../../../shared/logging', () => logging);

import { autoAssignAgent, releaseAgentOffers } from '../assignment/assignment.service';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue({
    id: 'ord_1',
    status: 'PENDING_AGENT',
    listingId: 'lst_1',
    agentId: null,
    agentRejectionCount: 0,
  });
  repository.findAssignments.mockResolvedValue([]);
  repository.findPendingAssignmentsForAgent.mockResolvedValue([]);
  repository.createAssignment.mockResolvedValue({});
  repository.rejectAssignment.mockResolvedValue(undefined);
  repository.update.mockResolvedValue(undefined);
  listings.getListingWithPublisher.mockResolvedValue({
    id: 'lst_1',
    city: 'Bengaluru',
    address: '12 Residency Road',
    publisher: { agentId: 'agt_publisher' },
  });
  agents.agentAcceptsWork.mockResolvedValue(true);
  agents.findAssignableAgent.mockResolvedValue({ id: 'agt_sweep' });
  agents.getAgentZone.mockResolvedValue(null);
  agents.getAgentWithUser.mockResolvedValue({ id: 'agt_publisher', userId: 'usr_1' });
});

describe('the publisher-agent shortcut', () => {
  it('still goes to the agent who onboarded the publisher when they are taking work', async () => {
    await autoAssignAgent('ord_1');
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_publisher', null);
    expect(agents.findAssignableAgent).not.toHaveBeenCalled();
  });

  it('falls through to the sweep when that agent is suspended', async () => {
    agents.agentAcceptsWork.mockResolvedValue(false);

    await autoAssignAgent('ord_1');

    expect(agents.agentAcceptsWork).toHaveBeenCalledWith('agt_publisher');
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_sweep', null);
  });

  it('leaves the order unassigned when the sweep has nobody either', async () => {
    agents.agentAcceptsWork.mockResolvedValue(false);
    agents.findAssignableAgent.mockResolvedValue(null);

    await autoAssignAgent('ord_1');

    expect(repository.createAssignment).not.toHaveBeenCalled();
  });
});

describe('releaseAgentOffers', () => {
  it('rejects every unanswered offer with the reason and re-offers each order', async () => {
    repository.findPendingAssignmentsForAgent.mockResolvedValue([
      { id: 'asg_1', orderId: 'ord_1' },
      { id: 'asg_2', orderId: 'ord_2' },
    ]);

    const released = await releaseAgentOffers('agt_1', 'SUSPENDED');

    expect(released).toEqual(['ord_1', 'ord_2']);
    expect(repository.rejectAssignment).toHaveBeenCalledWith('asg_1', 'ord_1', 'SUSPENDED');
    expect(repository.rejectAssignment).toHaveBeenCalledWith('asg_2', 'ord_2', 'SUSPENDED');
    // Re-offered through the ordinary path, which finds the next agent.
    expect(repository.createAssignment).toHaveBeenCalled();
  });

  it('is a no-op for an agent holding no offers', async () => {
    await expect(releaseAgentOffers('agt_1', 'SUSPENDED')).resolves.toEqual([]);
    expect(repository.rejectAssignment).not.toHaveBeenCalled();
  });
});
