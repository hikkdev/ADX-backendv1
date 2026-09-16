import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G12-B — position sharing on a visit milestone.
 *
 * `POST /agent/milestones/:milestoneId/update-location` is the same ping the
 * order lane takes on `POST /orders/:id/update-location`, for the agent on
 * their way to a milestone visit. A milestone has no location column and is
 * a step on one order, so the ping lands on that order's agent-location
 * columns — the store the order route writes and the publisher's
 * `GET /orders/:id/agent-location` reads. Only the milestone's assigned
 * agent may send it; a milestone that is nobody's, or somebody else's, is
 * 404 / 403 like every other agent verb here.
 */

const { repository, orders, logger } = vi.hoisted(() => ({
  repository: {
    findWithOrderStatus: vi.fn(),
  },
  orders: {
    getAgentOrderIdsAwaitingWork: vi.fn(),
    getOrderSummary: vi.fn(),
    updateAgentLocation: vi.fn(),
    OFFER_EXPIRED_REASON: 'EXPIRED',
    rejectionText: (reason: string) => reason,
    shortId: (id: string) => id.slice(-6).toUpperCase(),
    notifyAdmins: vi.fn(),
    notifyAgent: vi.fn(),
    slotCandidates: vi.fn(),
    AGENT_REJECTION_REASONS: ['NOT_AVAILABLE', 'TOO_FAR', 'OTHER'],
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../prisma-order-milestones.repository', () => ({ prismaOrderMilestonesRepository: repository }));
vi.mock('../../orders', () => orders);
vi.mock('../../../shared/logging', () => ({ logger }));

import { shareMilestoneLocation } from '../agent/agent-execution.service';
import { milestoneLocationSchema } from '../order-milestones.schema';

const AGENT = 'agt_adv';
const milestone = {
  id: 'ms_1',
  orderId: 'ord_0000000901',
  assignedAgentId: AGENT,
  status: 'DISPATCHED',
  acceptedAt: new Date('2026-09-10T09:00:00.000Z'),
  offerExpiresAt: null,
  template: { title: 'Advertiser visit', requirements: [] },
  orderRecord: { status: 'IN_PROGRESS', agentId: 'agt_pub', startDate: null, endDate: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithOrderStatus.mockResolvedValue(milestone);
  orders.updateAgentLocation.mockResolvedValue(undefined);
});

describe('the body', () => {
  it('is the order lane’s: latitude and longitude, numbers, both required', () => {
    expect(milestoneLocationSchema.parse({ latitude: 12.97, longitude: 77.6 })).toEqual({ latitude: 12.97, longitude: 77.6 });
    expect(milestoneLocationSchema.safeParse({ latitude: 12.97 }).success).toBe(false);
    expect(milestoneLocationSchema.safeParse({ latitude: '12.97', longitude: '77.6' }).success).toBe(false);
  });
});

describe('POST /agent/milestones/:milestoneId/update-location', () => {
  it('writes the ping onto the milestone’s order — the store the order route uses', async () => {
    await shareMilestoneLocation('ms_1', AGENT, { latitude: 12.97, longitude: 77.6 });
    expect(repository.findWithOrderStatus).toHaveBeenCalledWith('ms_1');
    expect(orders.updateAgentLocation).toHaveBeenCalledWith('ord_0000000901', { latitude: 12.97, longitude: 77.6 });
  });

  it('is the assigned agent’s only: 403 for anyone else, 404 for no such milestone', async () => {
    await expect(shareMilestoneLocation('ms_1', 'agt_other', { latitude: 1, longitude: 2 })).rejects.toMatchObject({ statusCode: 403 });
    repository.findWithOrderStatus.mockResolvedValue({ ...milestone, assignedAgentId: null });
    await expect(shareMilestoneLocation('ms_1', AGENT, { latitude: 1, longitude: 2 })).rejects.toMatchObject({ statusCode: 403 });
    repository.findWithOrderStatus.mockResolvedValue(null);
    await expect(shareMilestoneLocation('ms_missing', AGENT, { latitude: 1, longitude: 2 })).rejects.toMatchObject({ statusCode: 404 });
    expect(orders.updateAgentLocation).not.toHaveBeenCalled();
  });

  it('is a ping, not a state change: a milestone on a finalised order still takes it', async () => {
    repository.findWithOrderStatus.mockResolvedValue({ ...milestone, orderRecord: { ...milestone.orderRecord, status: 'COMPLETED' } });
    await expect(shareMilestoneLocation('ms_1', AGENT, { latitude: 1, longitude: 2 })).resolves.toBeUndefined();
    expect(orders.updateAgentLocation).toHaveBeenCalledOnce();
  });
});
