import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The offer an agent is holding: its clock, its answer, and what the sweep
 * does with silence.
 *
 * DR 01 draws "Expires in 25 Minutes" over the accept button; the server
 * kept 30 and nothing expired anything. Now one number lives in one place,
 * a late acceptance is refused rather than quietly honoured, a rejection has
 * to name one of the five drawn reasons (with words when it is "Other"), and
 * an offer nobody answered is recorded as such and re-offered.
 */

const { repository, notify, listings, agents, agreements } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findPendingAssignment: vi.fn(),
    findAssignments: vi.fn(),
    createAssignment: vi.fn(),
    acceptAssignment: vi.fn(),
    rejectAssignment: vi.fn(),
    update: vi.fn(),
    findAgentTimerExpired: vi.fn(),
  },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (id: string) => id.slice(0, 6) },
  listings: { getListingWithPublisher: vi.fn() },
  agents: { findAssignableAgent: vi.fn(), getAgentWithUser: vi.fn(), agentExists: vi.fn(), getAgentZone: vi.fn() },
  // Lot D (Q123): the tap records the agent's JOB_TERMS acceptance.
  agreements: { recordAcceptance: vi.fn() },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', () => listings);
vi.mock('../../agents', () => agents);
vi.mock('../../agreements', () => agreements);
// Lot B: the offer carries a quote; these tests are about the clock, so it is left unpriced.
vi.mock('../../payouts', () => ({ installationFeeFor: vi.fn().mockResolvedValue(null), recordIncentiveOnce: vi.fn() }));

import {
  AGENT_RESPONSE_WINDOW_MINUTES,
  AGENT_RESPONSE_WINDOW_MS,
  agentAcceptOrder,
  agentRejectOrder,
  expireAgentOffers,
} from '../assignment/assignment.service';
import { AGENT_REJECTION_REASONS, OFFER_EXPIRED_REASON, rejectionText } from '../assignment/rejection-reasons';
import { agentRejectSchema } from '../orders.schema';

const now = new Date('2026-09-10T09:00:00.000Z');
const inTenMinutes = new Date(now.getTime() + 10 * 60 * 1000);
const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'PENDING_AGENT',
  listingId: 'lst_1',
  agentId: 'agt_1',
  agentTimerExpiry: inTenMinutes,
  agentRejectionCount: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  repository.findPendingAssignment.mockResolvedValue({ id: 'asg_1', orderId: 'ord_1', agentId: 'agt_1' });
  repository.findById.mockResolvedValue(order());
  repository.findAssignments.mockResolvedValue([]);
  repository.acceptAssignment.mockResolvedValue(undefined);
  repository.rejectAssignment.mockResolvedValue(undefined);
  repository.update.mockResolvedValue(undefined);
  listings.getListingWithPublisher.mockResolvedValue({ id: 'lst_1', publisher: { agentId: null } });
  agents.findAssignableAgent.mockResolvedValue({ id: 'agt_2' });
  agents.getAgentWithUser.mockImplementation(async (id: string) => ({ id, userId: id === 'agt_1' ? 'usr_1' : 'usr_2' }));
  agreements.recordAcceptance.mockResolvedValue({ id: 'acc_1', templateVersion: 1 });
});

describe('the window', () => {
  it('is the twenty-five minutes the sheet draws, in one place', () => {
    expect(AGENT_RESPONSE_WINDOW_MINUTES).toBe(25);
    expect(AGENT_RESPONSE_WINDOW_MS).toBe(25 * 60 * 1000);
  });
});

describe('accepting', () => {
  it('takes the job while the clock is running', async () => {
    await agentAcceptOrder('ord_1', 'agt_1');
    expect(repository.acceptAssignment).toHaveBeenCalledWith('asg_1', 'ord_1', 'agt_1');
  });

  it('is refused once the clock has run out', async () => {
    repository.findById.mockResolvedValue(order({ agentTimerExpiry: tenMinutesAgo }));
    await expect(agentAcceptOrder('ord_1', 'agt_1')).rejects.toThrow('OFFER_EXPIRED');
    expect(repository.acceptAssignment).not.toHaveBeenCalled();
  });

  it('an offer placed by hand, with no clock, can always be taken', async () => {
    repository.findById.mockResolvedValue(order({ agentTimerExpiry: null }));
    await agentAcceptOrder('ord_1', 'agt_1');
    expect(repository.acceptAssignment).toHaveBeenCalled();
  });

  /* Lot D (Q123): the tap is the agent's own acceptance of the job terms —
     their profile, their user, this order — and it is recorded before the
     job changes hands, never on their behalf. */
  it('records the JOB_TERMS acceptance for the agent in the same tap', async () => {
    await agentAcceptOrder('ord_1', 'agt_1', { ipAddress: '10.0.0.1', userAgent: 'agent-app/2.0' });
    expect(agreements.recordAcceptance).toHaveBeenCalledWith({
      kind: 'JOB_TERMS',
      party: { agentId: 'agt_1' },
      anchor: { orderId: 'ord_1' },
      ctx: { acceptedByUserId: 'usr_1', ipAddress: '10.0.0.1', userAgent: 'agent-app/2.0' },
    });
    const [acceptanceCall] = agreements.recordAcceptance.mock.invocationCallOrder;
    const [acceptCall] = repository.acceptAssignment.mock.invocationCallOrder;
    expect(acceptanceCall).toBeLessThan(acceptCall!);
  });

  it('does not take the job when the terms cannot be recorded', async () => {
    agreements.recordAcceptance.mockRejectedValue(Object.assign(new Error('No agent job terms is published yet'), { code: 'NO_ACTIVE_TEMPLATE' }));
    await expect(agentAcceptOrder('ord_1', 'agt_1')).rejects.toMatchObject({ code: 'NO_ACTIVE_TEMPLATE' });
    expect(repository.acceptAssignment).not.toHaveBeenCalled();
  });
});

describe('declining', () => {
  it('the body must name one of the five reasons', () => {
    expect(AGENT_REJECTION_REASONS).toEqual(['TOO_FAR', 'NOT_AVAILABLE', 'NO_EXPERTISE', 'AT_CAPACITY', 'OTHER']);
    expect(agentRejectSchema.safeParse({ reason: 'TOO_FAR' }).success).toBe(true);
    expect(agentRejectSchema.safeParse({ reason: 'too_far' }).success).toBe(true);
    expect(agentRejectSchema.safeParse({}).success).toBe(false);
    expect(agentRejectSchema.safeParse({ reason: 'BUSY' }).success).toBe(false);
  });

  it('"Other" has to say what', () => {
    expect(agentRejectSchema.safeParse({ reason: 'OTHER' }).success).toBe(false);
    expect(agentRejectSchema.safeParse({ reason: 'OTHER', note: '   ' }).success).toBe(false);
    expect(agentRejectSchema.safeParse({ reason: 'OTHER', note: 'Vehicle in the shop' }).success).toBe(true);
  });

  it('records the code, and the words after it when there are any', () => {
    expect(rejectionText('TOO_FAR')).toBe('TOO_FAR');
    expect(rejectionText('OTHER', ' Vehicle in the shop ')).toBe('OTHER: Vehicle in the shop');
  });

  it('writes the reason on the assignment and re-offers the job', async () => {
    await agentRejectOrder('ord_1', 'agt_1', rejectionText('AT_CAPACITY'));
    expect(repository.rejectAssignment).toHaveBeenCalledWith('asg_1', 'ord_1', 'AT_CAPACITY');
  });
});

describe('the sweep', () => {
  it('records silence as EXPIRED and offers the job to the next agent', async () => {
    repository.findAgentTimerExpired.mockResolvedValue([{ id: 'ord_1', agentId: 'agt_1' }]);
    repository.findById.mockResolvedValue(order({ agentTimerExpiry: tenMinutesAgo }));

    const swept = await expireAgentOffers(new Date(now.getTime() - 60_000), now);

    expect(swept).toEqual(['ord_1']);
    expect(repository.rejectAssignment).toHaveBeenCalledWith('asg_1', 'ord_1', OFFER_EXPIRED_REASON);
    // The re-offer excludes the agent who let it lapse.
    expect(agents.findAssignableAgent).toHaveBeenCalled();
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_2', null);
  });

  it('leaves an offer alone when the agent answered in the meantime', async () => {
    repository.findAgentTimerExpired.mockResolvedValue([{ id: 'ord_1', agentId: 'agt_1' }]);
    repository.findPendingAssignment.mockResolvedValue(null);
    const swept = await expireAgentOffers(new Date(now.getTime() - 60_000), now);
    expect(swept).toEqual([]);
    expect(repository.rejectAssignment).not.toHaveBeenCalled();
  });
});
