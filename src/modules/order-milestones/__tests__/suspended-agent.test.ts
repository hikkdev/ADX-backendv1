import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../shared/errors';

/**
 * Lot A on the fulfilment checklist.
 *
 * BLOCK_NEW: assigning a milestone to an agent dispatches it, and a dispatch
 * is new work, so a suspended agent is refused before anything is written.
 * Skipping a milestone is not a dispatch and is left alone.
 *
 * STOP_OPEN_WORK: what was dispatched to them goes back to PENDING and
 * unassigned, through the same reject the expiry sweep uses, so ADX can send
 * it to somebody else. Work already under way stays where it is.
 */

const { repository, orders, agents, appConfig, listings, logger } = vi.hoisted(() => ({
  repository: {
    findWithOrderStatus: vi.fn(),
    updateMilestone: vi.fn(),
    findDispatchedForAgent: vi.fn(),
    reject: vi.fn(),
  },
  orders: {
    getOrderSummary: vi.fn(),
    getAgentOrderIdsAwaitingWork: vi.fn(),
    AGENT_RESPONSE_WINDOW_MINUTES: 25,
    OFFER_EXPIRED_REASON: 'EXPIRED',
    rejectionText: (reason: string) => reason,
    shortId: (id: string) => id.slice(-6).toUpperCase(),
    notifyAdmins: vi.fn(),
    notifyAgent: vi.fn(),
    slotCandidates: vi.fn(),
  },
  agents: { agentExists: vi.fn(), assertAgentAcceptsWork: vi.fn() },
  appConfig: { getCategoryPlanId: vi.fn() },
  listings: { getListingById: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../prisma-order-milestones.repository', () => ({ prismaOrderMilestonesRepository: repository }));
vi.mock('../../orders', () => orders);
vi.mock('../../agents', () => agents);
vi.mock('../../app-config', () => appConfig);
vi.mock('../../listings', () => listings);
vi.mock('../../../shared/logging', () => ({ logger }));

import { releaseAgentMilestones } from '../agent/agent-execution.service';
import { updateOrderMilestone } from '../order/order-milestones.service';

const AGENT = 'agt_1';

const milestone = (over: Record<string, unknown> = {}) => ({
  id: 'ms_1',
  status: 'PENDING',
  orderRecord: { status: 'SLOT_CONFIRMED', agentId: 'agt_holder', startDate: null, endDate: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithOrderStatus.mockResolvedValue(milestone());
  repository.updateMilestone.mockResolvedValue({});
  repository.findDispatchedForAgent.mockResolvedValue([]);
  repository.reject.mockResolvedValue({});
  agents.agentExists.mockResolvedValue(true);
  agents.assertAgentAcceptsWork.mockResolvedValue(undefined);
  orders.notifyAdmins.mockResolvedValue(undefined);
});

describe('BLOCK_NEW', () => {
  it('refuses a dispatch to a suspended agent, before the milestone is written', async () => {
    agents.assertAgentAcceptsWork.mockRejectedValue(
      new ApiError(409, 'AGENT_SUSPENDED', 'That agent is not being offered work at the moment'),
    );

    await expect(updateOrderMilestone('ms_1', { assignedAgentId: AGENT })).rejects.toMatchObject({
      code: 'AGENT_SUSPENDED',
    });
    expect(repository.updateMilestone).not.toHaveBeenCalled();
  });

  it('dispatches as before when the agent is taking work', async () => {
    await updateOrderMilestone('ms_1', { assignedAgentId: AGENT });
    expect(agents.assertAgentAcceptsWork).toHaveBeenCalledWith(AGENT);
    expect(repository.updateMilestone).toHaveBeenCalledWith('ms_1', expect.objectContaining({ status: 'DISPATCHED' }));
  });

  it('does not ask when nobody is being assigned', async () => {
    await updateOrderMilestone('ms_1', { order: 2 });
    expect(agents.assertAgentAcceptsWork).not.toHaveBeenCalled();
  });

  it('does not ask on a skip, which assigns nobody', async () => {
    await updateOrderMilestone('ms_1', { assignedAgentId: AGENT, status: 'SKIPPED' });
    expect(agents.assertAgentAcceptsWork).not.toHaveBeenCalled();
    expect(repository.updateMilestone).toHaveBeenCalledWith('ms_1', expect.objectContaining({ status: 'SKIPPED' }));
  });
});

describe('STOP_OPEN_WORK', () => {
  it('sends every dispatched milestone back to ADX and tells the admins', async () => {
    repository.findDispatchedForAgent.mockResolvedValue([
      { id: 'ms_1', orderId: 'ord_1' },
      { id: 'ms_2', orderId: 'ord_2' },
    ]);

    const released = await releaseAgentMilestones(AGENT, 'SUSPENDED');

    expect(released).toEqual(['ms_1', 'ms_2']);
    expect(repository.reject).toHaveBeenCalledWith('ms_1', 'SUSPENDED');
    expect(orders.notifyAdmins).toHaveBeenCalledTimes(2);
  });

  it('asks only for the dispatched ones, so work under way is left alone', async () => {
    await releaseAgentMilestones(AGENT, 'SUSPENDED');
    expect(repository.findDispatchedForAgent).toHaveBeenCalledWith(AGENT);
    expect(repository.reject).not.toHaveBeenCalled();
  });
});
