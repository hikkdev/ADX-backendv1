import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q54/Q92) — the re-install a dispute resolution raises.
 *
 * A REINSTALL outcome puts an INSTALLATION milestone on the order the case
 * names, offered to the agent who did the work by default (ops may name
 * another), and stamped with the dispute it answers. The finalised-order
 * guard — COMPLETED and CANCELLED freeze their milestones — is relaxed for
 * exactly these rows and no others: the whole point is a visit on an order
 * that has already completed.
 */

const { repository, orders, agents, appConfig, listings, logger } = vi.hoisted(() => ({
  repository: {
    findWithOrderStatus: vi.fn(),
    updateMilestone: vi.fn(),
    findActiveTemplateByType: vi.fn(),
    findLastOrderIndex: vi.fn(),
    createReinstall: vi.fn(),
    findStatuses: vi.fn(),
    start: vi.fn(),
    findDetail: vi.fn(),
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

import { raiseReinstallMilestone, updateOrderMilestone } from '../order/order-milestones.service';
import { startMilestone } from '../agent/agent-execution.service';

const now = new Date('2026-09-12T09:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'COMPLETED', agentId: 'agt_1', listingId: 'lst_1' });
  repository.findActiveTemplateByType.mockResolvedValue({ id: 'tpl_install', title: 'Installation', type: 'INSTALLATION', isActive: true });
  repository.findLastOrderIndex.mockResolvedValue(3);
  repository.createReinstall.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'ms_re', ...data }));
  agents.agentExists.mockResolvedValue(true);
  agents.assertAgentAcceptsWork.mockResolvedValue(undefined);
  orders.notifyAgent.mockResolvedValue(undefined);
  orders.notifyAdmins.mockResolvedValue(undefined);
});

describe('raising the re-install', () => {
  it('offers an INSTALLATION milestone to the order’s own agent, stamped with the dispute', async () => {
    const created = await raiseReinstallMilestone({ orderId: 'ord_1', disputeId: 'dsp_1' });

    expect(repository.createReinstall).toHaveBeenCalledWith({
      orderId: 'ord_1',
      templateId: 'tpl_install',
      order: 4,
      assignedAgentId: 'agt_1',
      reinstallOfDisputeId: 'dsp_1',
      notes: 'Re-install ordered by dispute dsp_1',
      offeredAt: now,
      offerExpiresAt: new Date(now.getTime() + 25 * 60 * 1000),
    });
    expect(created).toMatchObject({ id: 'ms_re', assignedAgentId: 'agt_1' });
    expect(orders.notifyAgent).toHaveBeenCalledWith('agt_1', expect.stringContaining('Re-install'), expect.any(String), 'ord_1');
  });

  it('lets ops name another agent, who must be taking work', async () => {
    await raiseReinstallMilestone({ orderId: 'ord_1', disputeId: 'dsp_1', agentId: 'agt_2' });
    expect(agents.assertAgentAcceptsWork).toHaveBeenCalledWith('agt_2');
    expect(repository.createReinstall).toHaveBeenCalledWith(expect.objectContaining({ assignedAgentId: 'agt_2' }));
  });

  it('leaves the visit unassigned for ops when the order never had an agent', async () => {
    orders.getOrderSummary.mockResolvedValue({ id: 'ord_1', status: 'COMPLETED', agentId: null, listingId: 'lst_1' });
    await raiseReinstallMilestone({ orderId: 'ord_1', disputeId: 'dsp_1' });
    expect(repository.createReinstall).toHaveBeenCalledWith(expect.objectContaining({ assignedAgentId: null, offeredAt: null, offerExpiresAt: null }));
    expect(orders.notifyAdmins).toHaveBeenCalled();
  });

  it('refuses when no active INSTALLATION template exists', async () => {
    repository.findActiveTemplateByType.mockResolvedValue(null);
    await expect(raiseReinstallMilestone({ orderId: 'ord_1', disputeId: 'dsp_1' })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the finalised-order guard', () => {
  it('still freezes an ordinary milestone on a completed order', async () => {
    repository.findWithOrderStatus.mockResolvedValue({
      id: 'ms_1', status: 'PENDING', reinstallOfDisputeId: null, acceptedAt: null, offerExpiresAt: null,
      orderRecord: { status: 'COMPLETED', agentId: 'agt_1', startDate: null, endDate: null },
    });
    await expect(updateOrderMilestone('ms_1', { notes: 'x' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('lets a re-install milestone be worked on a completed order', async () => {
    repository.findWithOrderStatus.mockResolvedValue({
      id: 'ms_re', status: 'DISPATCHED', reinstallOfDisputeId: 'dsp_1', assignedAgentId: 'agt_1', acceptedAt: now, offerExpiresAt: null,
      orderRecord: { status: 'COMPLETED', agentId: 'agt_1', startDate: null, endDate: null },
    });
    repository.updateMilestone.mockResolvedValue({ id: 'ms_re' });
    repository.start.mockResolvedValue({ id: 'ms_re', status: 'IN_PROGRESS' });

    await expect(updateOrderMilestone('ms_re', { notes: 'x' })).resolves.toBeDefined();
    await expect(startMilestone('ms_re', 'agt_1')).resolves.toMatchObject({ status: 'IN_PROGRESS' });
  });
});
