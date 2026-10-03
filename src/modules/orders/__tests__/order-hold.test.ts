import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Order fraud screening (2 Oct 2026) — the hold, on the order's side.
 *
 * Pinned: a hold is a reversible pause, never a cancellation — only an open
 * order can be held, once; releasing it lets the order walk on (an order
 * that reached PENDING_AGENT while held is offered then, unless an offer is
 * already out). And each gate: no agent is offered a held job, none can
 * accept it (the agent hears the neutral line, never why), ADX cannot hand
 * it over or reassign it, and the sign-off that records the agent's
 * commission waits — 409 ORDER_ON_HOLD with the desk's sentence.
 */

const { repository, notify, listings, agents, payouts, agreements, logging, users } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findHold: vi.fn(),
    findRiskState: vi.fn(),
    holdIfOpen: vi.fn(),
    releaseIfHeld: vi.fn(),
    findPendingAssignment: vi.fn(),
    findAssignments: vi.fn(),
    findCurrentAssignment: vi.fn(),
    createAssignment: vi.fn(),
    acceptAssignment: vi.fn(),
    rejectAssignment: vi.fn(),
    reassignAssignment: vi.fn(),
    findWithPublisher: vi.fn(),
    update: vi.fn(),
  },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (id: string) => id.slice(0, 6) },
  listings: { getListingWithPublisher: vi.fn(), setListingAvailability: vi.fn() },
  agents: {
    findAssignableAgent: vi.fn(),
    getAgentWithUser: vi.fn(),
    getAgentZone: vi.fn(),
    agentAcceptsWork: vi.fn(),
    assertAgentAcceptsWork: vi.fn(),
    dispatchAskFor: vi.fn(async () => ({})),
    isBelowRequiredGrade: vi.fn(async () => false),
    findAgentTier: vi.fn(async () => 'BRONZE'),
    findAgentProfile: vi.fn(),
  },
  payouts: { installationFeeFor: vi.fn().mockResolvedValue(null), recordIncentiveOnce: vi.fn() },
  agreements: { recordAcceptance: vi.fn() },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  users: { findUserLabels: vi.fn(async () => new Map()) },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', () => listings);
vi.mock('../../agents', () => agents);
vi.mock('../../payouts', () => payouts);
vi.mock('../../agreements', () => agreements);
vi.mock('../../users', () => users);
vi.mock('../../../shared/logging', () => logging);

import { adminAssignAgent, agentAcceptOrder, autoAssignAgent, reassignAgent } from '../assignment/assignment.service';
import { approveOrder } from '../verification/verification.service';
import { holdOrder, releaseOrderHold } from '../risk/order-risk.service';
import { orderError } from '../orders.errors';
import { ORDER_REVIEW_NOTICE } from '../orders.redact';

const HELD = { heldAt: new Date('2026-10-02T09:00:00Z') };
const FREE = { heldAt: null };

const risk = (over: Record<string, unknown> = {}) => ({ id: 'ord_1', displayId: 'BKG-1', status: 'PENDING_AGENT', agentId: null, heldAt: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  repository.findById.mockResolvedValue({ id: 'ord_1', status: 'PENDING_AGENT', listingId: 'lst_1', agentId: 'agt_old', agentRejectionCount: 0, agentTimerExpiry: null, agentFeeAmount: null });
  repository.findHold.mockResolvedValue(FREE);
  repository.findAssignments.mockResolvedValue([]);
  repository.findPendingAssignment.mockResolvedValue({ id: 'asg_1' });
  repository.createAssignment.mockResolvedValue({});
  repository.update.mockResolvedValue({ id: 'ord_1' });
  listings.getListingWithPublisher.mockResolvedValue({ id: 'lst_1', city: 'Pune', address: 'x', publisher: { agentId: null, sizeBand: null } });
  agents.agentAcceptsWork.mockResolvedValue(true);
  agents.findAssignableAgent.mockResolvedValue({ id: 'agt_sweep' });
  agents.getAgentWithUser.mockResolvedValue({ id: 'agt_sweep', userId: 'usr_agent' });
  agents.getAgentZone.mockResolvedValue(null);
});

/** What the controller answers for a service's sentinel. */
const answered = async (work: Promise<unknown>) => {
  try {
    await work;
    return null;
  } catch (e) {
    try {
      orderError(e);
    } catch (api) {
      return api as { statusCode: number; code: string; message: string };
    }
  }
  return null;
};

describe('the hold gates', () => {
  it('offers a held order to nobody', async () => {
    repository.findHold.mockResolvedValue(HELD);
    await autoAssignAgent('ord_1');
    expect(repository.createAssignment).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    repository.findHold.mockResolvedValue(FREE);
    await autoAssignAgent('ord_1');
    expect(repository.createAssignment).toHaveBeenCalledTimes(1);
  });

  it('lets no agent accept a held job, and tells them only the neutral line', async () => {
    repository.findHold.mockResolvedValue(HELD);
    const error = await answered(agentAcceptOrder('ord_1', 'agt_sweep'));
    expect(error).toMatchObject({ statusCode: 409, code: 'ORDER_ON_HOLD', message: ORDER_REVIEW_NOTICE });
    expect(error!.message).not.toMatch(/fraud/i);
    expect(repository.acceptAssignment).not.toHaveBeenCalled();
  });

  it('refuses ADX handing a held order to an agent, or reassigning it', async () => {
    repository.findHold.mockResolvedValue(HELD);
    expect(await answered(adminAssignAgent('ord_1', 'agt_new'))).toMatchObject({ statusCode: 409, code: 'ORDER_ON_HOLD', message: expect.stringContaining('on hold for review') });
    repository.findById.mockResolvedValue({ id: 'ord_1', status: 'SLOT_PROPOSED', listingId: 'lst_1', agentId: 'agt_old', agentFeeAmount: null });
    expect(await answered(reassignAgent('ord_1', 'agt_new', 'ops move'))).toMatchObject({ statusCode: 409, code: 'ORDER_ON_HOLD' });
    expect(repository.createAssignment).not.toHaveBeenCalled();
  });

  it('holds back the sign-off that records the agent’s commission', async () => {
    repository.findWithPublisher.mockResolvedValue({ id: 'ord_1', status: 'PENDING_APPROVAL', listingId: 'lst_1', advertiserId: 'usr_adv', agentId: 'agt_1', agentFeeAmount: null, listing: { publisher: { userId: 'usr_pub' } } });
    repository.findHold.mockResolvedValue(HELD);
    expect(await answered(approveOrder('ord_1'))).toMatchObject({ statusCode: 409, code: 'ORDER_ON_HOLD' });
    expect(repository.update).not.toHaveBeenCalled();
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();
  });
});

describe('holding and releasing', () => {
  it('holds an open order once; a finished order or a held one is a 409; no order a 404', async () => {
    repository.findRiskState.mockResolvedValueOnce(risk()).mockResolvedValueOnce(risk({ heldAt: HELD.heldAt, holdReason: 'Same bank' }));
    repository.holdIfOpen.mockResolvedValue(true);
    const after = await holdOrder('ord_1', { byUserId: 'usr_admin', reason: 'Same bank', at: HELD.heldAt });
    expect(repository.holdIfOpen).toHaveBeenCalledWith('ord_1', { heldAt: HELD.heldAt, heldById: 'usr_admin', holdReason: 'Same bank' });
    expect(after.heldAt).toEqual(HELD.heldAt);
    // A hold is never a cancellation: the status is not written.
    expect(repository.update).not.toHaveBeenCalled();

    repository.findRiskState.mockResolvedValue(risk({ status: 'COMPLETED' }));
    await expect(holdOrder('ord_1', { byUserId: 'usr_admin', reason: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    repository.findRiskState.mockResolvedValue(risk({ heldAt: HELD.heldAt }));
    await expect(holdOrder('ord_1', { byUserId: 'usr_admin', reason: 'x' })).rejects.toMatchObject({ statusCode: 409 });
    repository.findRiskState.mockResolvedValue(null);
    await expect(holdOrder('nope', { byUserId: 'usr_admin', reason: 'x' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('loses a race for the hold as a 409, not a double hold', async () => {
    repository.findRiskState.mockResolvedValue(risk());
    repository.holdIfOpen.mockResolvedValue(false);
    await expect(holdOrder('ord_1', { byUserId: null, reason: 'auto' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('releases a held order and offers it when it waited at PENDING_AGENT with no offer out', async () => {
    repository.findRiskState.mockResolvedValueOnce(risk({ heldAt: HELD.heldAt })).mockResolvedValueOnce(risk());
    repository.releaseIfHeld.mockResolvedValue(true);
    await releaseOrderHold('ord_1');
    expect(repository.releaseIfHeld).toHaveBeenCalledWith('ord_1');
    await vi.waitFor(() => expect(repository.createAssignment).toHaveBeenCalled());
  });

  it('leaves an offer already out alone on release', async () => {
    repository.findRiskState.mockResolvedValueOnce(risk({ heldAt: HELD.heldAt })).mockResolvedValueOnce(risk({ agentId: 'agt_1' }));
    repository.findAssignments.mockResolvedValue([{ id: 'asg_1', status: 'PENDING', agentId: 'agt_1' }]);
    await releaseOrderHold('ord_1');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(repository.createAssignment).not.toHaveBeenCalled();
  });

  it('refuses to release an order that is not held', async () => {
    repository.findRiskState.mockResolvedValue(risk());
    await expect(releaseOrderHold('ord_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(repository.releaseIfHeld).not.toHaveBeenCalled();
  });
});
