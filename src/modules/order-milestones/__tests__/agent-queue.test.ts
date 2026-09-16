import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the agent's checklist comes from.
 *
 * The whole verification lane was built and routed against `OrderMilestone`
 * rows that nothing created: `autoAssignMilestones` had no callers, so an agent
 * opened their visits list and found it empty unless ops had hand-created and
 * dispatched every step. Reading the queue now issues the plans the agent's
 * live jobs are owed, which is the first moment they are needed.
 */

const { repository, orders, listings, appConfig, agents, logger } = vi.hoisted(() => ({
  repository: {
    findForAgent: vi.fn(),
    countForOrder: vi.fn(),
    findPlanWithItems: vi.fn(),
    createManyForOrder: vi.fn(),
  },
  orders: { getAgentOrderIdsAwaitingWork: vi.fn(), getOrderSummary: vi.fn() },
  listings: { getListingById: vi.fn() },
  appConfig: { getCategoryPlanId: vi.fn() },
  agents: { agentExists: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../prisma-order-milestones.repository', () => ({
  prismaOrderMilestonesRepository: repository,
}));
vi.mock('../../orders', () => orders);
vi.mock('../../listings', () => listings);
vi.mock('../../app-config', () => appConfig);
vi.mock('../../agents', () => agents);
vi.mock('../../../shared/logging', () => ({ logger }));

import { getAgentMilestones } from '../agent/agent-execution.service';

const AGENT = 'agt_1';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findForAgent.mockResolvedValue(['milestone']);
  repository.countForOrder.mockResolvedValue(0);
  repository.createManyForOrder.mockResolvedValue({ count: 2 });
  repository.findPlanWithItems.mockResolvedValue({
    id: 'pln_1',
    isActive: true,
    items: [
      { templateId: 'tpl_1', order: 1, isOptional: false },
      { templateId: 'tpl_2', order: 2, isOptional: true },
    ],
  });
  orders.getAgentOrderIdsAwaitingWork.mockResolvedValue([{ id: 'ord_1' }]);
  orders.getOrderSummary.mockResolvedValue({
    id: 'ord_1',
    status: 'SLOT_CONFIRMED',
    agentId: AGENT,
    listingId: 'lst_1',
  });
  listings.getListingById.mockResolvedValue({ id: 'lst_1', planId: 'pln_1', category: 'OUTDOOR' });
  appConfig.getCategoryPlanId.mockResolvedValue(null);
});

describe('reading the queue issues the plans the agent’s jobs are owed', () => {
  it('materialises the listing’s plan against the agent who holds the job', async () => {
    await getAgentMilestones(AGENT);
    expect(repository.createManyForOrder).toHaveBeenCalledWith([
      { orderId: 'ord_1', templateId: 'tpl_1', planId: 'pln_1', order: 1, isOptional: false, assignedAgentId: AGENT },
      { orderId: 'ord_1', templateId: 'tpl_2', planId: 'pln_1', order: 2, isOptional: true, assignedAgentId: AGENT },
    ]);
  });

  it('falls back to the category default when the listing names no plan', async () => {
    listings.getListingById.mockResolvedValue({ id: 'lst_1', planId: null, category: 'INDOOR' });
    appConfig.getCategoryPlanId.mockResolvedValue('pln_default');
    await getAgentMilestones(AGENT);
    expect(appConfig.getCategoryPlanId).toHaveBeenCalledWith('INDOOR');
    expect(repository.findPlanWithItems).toHaveBeenCalledWith('pln_default');
  });

  /* Idempotent — the app polls this list. */
  it('issues nothing a second time', async () => {
    repository.countForOrder.mockResolvedValue(2);
    await getAgentMilestones(AGENT);
    expect(repository.createManyForOrder).not.toHaveBeenCalled();
  });

  it('answers with the queue itself', async () => {
    await expect(getAgentMilestones(AGENT)).resolves.toEqual(['milestone']);
    expect(repository.findForAgent).toHaveBeenCalledWith(AGENT);
  });
});

describe('issuing is never a gate on seeing the queue', () => {
  it('still answers when one job’s plan cannot be issued', async () => {
    repository.createManyForOrder.mockRejectedValue(new Error('unique violation'));
    await expect(getAgentMilestones(AGENT)).resolves.toEqual(['milestone']);
    expect(logger.error).toHaveBeenCalled();
  });

  it('still answers when the agent’s jobs cannot be read at all', async () => {
    orders.getAgentOrderIdsAwaitingWork.mockRejectedValue(new Error('database down'));
    await expect(getAgentMilestones(AGENT)).resolves.toEqual(['milestone']);
    expect(repository.createManyForOrder).not.toHaveBeenCalled();
  });
});
