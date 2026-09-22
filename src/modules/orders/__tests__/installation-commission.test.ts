import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot B (Q102): the installation commission, from offer to sign-off.
 *
 * What is pinned. The figure the offer sheet shows is resolved when the offer
 * is made and copied onto the assignment (`quotedFee`), so a later change to
 * the rate or the mode cannot re-price a job somebody already accepted. Ops
 * may type a per-order figure at assign or print-ready, and it lands on
 * `Order.agentFeeAmount` for the resolver to read. At admin sign-off the
 * INSTALLATION incentive is recorded once, PENDING_VERIFICATION, at the
 * accepted assignment's quoted figure — and never for an order nobody
 * installed. The agent's list and the order detail print the quote.
 */

const { repository, notify, listings, agents, payouts, logger } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findWithPublisher: vi.fn(),
    findDetail: vi.fn(),
    findForAgent: vi.fn(),
    findPendingAssignment: vi.fn(),
    findAssignments: vi.fn(),
    createAssignment: vi.fn(),
    acceptAssignment: vi.fn(),
    rejectAssignment: vi.fn(),
    update: vi.fn(),
  },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (id: string) => id.slice(-6) },
  listings: { getListingWithPublisher: vi.fn(), setListingAvailability: vi.fn() },
  agents: {
    findAssignableAgent: vi.fn(),
    getAgentWithUser: vi.fn(),
    agentExists: vi.fn(),
    getAgentZone: vi.fn(),
    agentAcceptsWork: vi.fn(),
    findAgentTier: vi.fn(),
    dispatchAskFor: vi.fn(async () => ({})),
    isBelowRequiredGrade: vi.fn(async () => false),
    agentMeetsGrade: vi.fn(async () => true),
    getRoutingSettings: vi.fn(async () => ({ bands: { INDIVIDUAL: 'G1',
    SMALL_AGENCY: 'G2',
    LARGE_AGENCY: 'G3' },
    leadBands: { STANDARD: 'G1',
    KEY: 'G3',
    ENTERPRISE: 'G4' },
    enforce: true })),
    findAgentProfile: vi.fn(),
  },
  payouts: { installationFeeFor: vi.fn(), recordIncentiveOnce: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', () => listings);
vi.mock('../../agents', () => agents);
vi.mock('../../payouts', () => payouts);
vi.mock('../../../shared/logging', () => ({ logger }));

import { adminAssignAgent, autoAssignAgent } from '../assignment/assignment.service';
import { approveOrder } from '../verification/verification.service';
import { getOrderById, getOrdersForAgent } from '../orders.queries';
import { agentIdSchema, printReadySchema } from '../orders.schema';

const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'PENDING_AGENT',
  listingId: 'lst_1',
  advertiserId: 'usr_adv',
  agentId: null,
  agentFeeAmount: null,
  agentRejectionCount: 0,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  notify.notifyAgent.mockResolvedValue(undefined);
  notify.notifyUser.mockResolvedValue(undefined);
  notify.notifyAdmins.mockResolvedValue(undefined);
  repository.findById.mockResolvedValue(order());
  repository.findAssignments.mockResolvedValue([]);
  repository.createAssignment.mockResolvedValue({});
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...order(), id, ...patch }));
  listings.getListingWithPublisher.mockResolvedValue({ id: 'lst_1', city: 'Bengaluru', address: 'MG Road', publisher: { agentId: null } });
  agents.findAssignableAgent.mockResolvedValue({ id: 'agt_1' });
  agents.getAgentWithUser.mockResolvedValue({ id: 'agt_1', userId: 'usr_agent' });
  agents.getAgentZone.mockResolvedValue(null);
  agents.findAgentTier.mockResolvedValue('SILVER');
  payouts.installationFeeFor.mockResolvedValue('1450.00');
  payouts.recordIncentiveOnce.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 'inc_1',
    status: 'PENDING_VERIFICATION',
    amount: new Decimal((input['amount'] as string) ?? '1450.00'),
    ...input,
  }));
});

describe('the bodies ops types the figure into', () => {
  it('accept an optional decimal-string agentFee, and refuse a float', () => {
    expect(agentIdSchema.parse({ agentId: 'agt_1', agentFee: '1800.00' })).toEqual({ agentId: 'agt_1', agentFee: '1800.00' });
    expect(agentIdSchema.parse({ agentId: 'agt_1' })).toEqual({ agentId: 'agt_1' });
    expect(printReadySchema.parse({})).toEqual({});
    expect(printReadySchema.safeParse({ agentFee: 1800 }).success).toBe(false);
    expect(printReadySchema.safeParse({ agentFee: '-5' }).success).toBe(false);
  });
});

describe('the quote on the offer', () => {
  it('resolves the figure at the candidate’s tier and copies it onto the assignment', async () => {
    await autoAssignAgent('ord_1');
    expect(payouts.installationFeeFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'ord_1' }), 'SILVER');
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_1', new Decimal('1450.00'));
  });

  it('still offers the job when the figure cannot be priced', async () => {
    payouts.installationFeeFor.mockRejectedValue(new Error('settings down'));
    await autoAssignAgent('ord_1');
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_1', null);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('writes the typed figure onto the order before quoting a hand-placed offer', async () => {
    payouts.installationFeeFor.mockResolvedValue('1800.00');
    await adminAssignAgent('ord_1', 'agt_2', { agentFee: '1800.00' });
    expect(repository.update).toHaveBeenCalledWith('ord_1', { agentFeeAmount: new Decimal('1800.00') });
    expect(payouts.installationFeeFor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ord_1', agentFeeAmount: new Decimal('1800.00') }),
      'SILVER',
    );
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_2', new Decimal('1800.00'));
  });

  it('leaves the order’s figure alone when ops typed nothing', async () => {
    await adminAssignAgent('ord_1', 'agt_2');
    expect(repository.update).not.toHaveBeenCalledWith('ord_1', expect.objectContaining({ agentFeeAmount: expect.anything() }));
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_2', new Decimal('1450.00'));
  });
});

describe('the commission at sign-off', () => {
  const signedOff = (over: Record<string, unknown> = {}) => ({
    ...order({ status: 'PENDING_APPROVAL', agentId: 'agt_1' }),
    listing: { id: 'lst_1', publisher: { id: 'pub_1', userId: 'usr_pub' } },
    ...over,
  });

  beforeEach(() => {
    repository.findWithPublisher.mockResolvedValue(signedOff());
    repository.findAssignments.mockResolvedValue([
      { id: 'asg_0', agentId: 'agt_0', status: 'REJECTED', quotedFee: new Decimal('1450.00'), assignedAt: new Date('2026-09-10T08:00:00Z') },
      { id: 'asg_1', agentId: 'agt_1', status: 'ACCEPTED', quotedFee: new Decimal('1800.00'), assignedAt: new Date('2026-09-10T09:00:00Z') },
    ]);
  });

  it('records INSTALLATION for the installing agent at the accepted quote, PENDING_VERIFICATION', async () => {
    const result = await approveOrder('ord_1');
    expect(payouts.recordIncentiveOnce).toHaveBeenCalledWith(
      { agentId: 'agt_1', event: 'INSTALLATION', tier: 'SILVER', orderId: 'ord_1', amount: '1800.00', note: expect.stringContaining('ord_1'.slice(-6)) },
    );
    expect(result.incentive).toEqual({ id: 'inc_1', amount: '1800.00' });
    expect(notify.notifyAgent).toHaveBeenCalledWith('agt_1', 'Commission recorded', expect.stringContaining('ADX finance releases it'), 'ord_1');
  });

  it('prices from the resolver when the accepted assignment carried no quote', async () => {
    repository.findAssignments.mockResolvedValue([{ id: 'asg_1', agentId: 'agt_1', status: 'ACCEPTED', quotedFee: null, assignedAt: new Date() }]);
    await approveOrder('ord_1');
    expect(payouts.installationFeeFor).toHaveBeenCalledWith(expect.objectContaining({ id: 'ord_1' }), 'SILVER');
    expect(payouts.recordIncentiveOnce).toHaveBeenCalledWith(expect.objectContaining({ amount: '1450.00' }));
  });

  it('records nothing for an order nobody installed', async () => {
    repository.findWithPublisher.mockResolvedValue(signedOff({ agentId: null }));
    const result = await approveOrder('ord_1');
    expect(payouts.recordIncentiveOnce).not.toHaveBeenCalled();
    expect(result.incentive).toBeNull();
    expect(result.status).toBe('COMPLETED');
  });

  it('completes the order even when the commission cannot be recorded', async () => {
    payouts.recordIncentiveOnce.mockRejectedValue(new Error('no rate'));
    const result = await approveOrder('ord_1');
    expect(result.status).toBe('COMPLETED');
    expect(result.incentive).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('what the agent reads', () => {
  it('prints the accepted quote on the order detail', async () => {
    repository.findDetail.mockResolvedValue({
      id: 'ord_1',
      agentId: 'agt_1',
      agentAssignments: [
        { id: 'asg_1', agentId: 'agt_1', status: 'ACCEPTED', quotedFee: new Decimal('1800.00') },
        { id: 'asg_0', agentId: 'agt_0', status: 'REJECTED', quotedFee: new Decimal('1450.00') },
      ],
    });
    expect(await getOrderById('ord_1')).toMatchObject({ id: 'ord_1', quotedFee: '1800.00' });
  });

  it('prints null when no offer has been accepted yet', async () => {
    repository.findDetail.mockResolvedValue({ id: 'ord_1', agentAssignments: [{ status: 'PENDING', quotedFee: new Decimal('1450.00') }] });
    expect(await getOrderById('ord_1')).toMatchObject({ quotedFee: null });
  });

  it('carries the quote on every row of the agent’s list', async () => {
    repository.findForAgent.mockResolvedValue({
      items: [{ id: 'ord_1', status: 'SLOT_PROPOSED', quotedFee: new Decimal('1800') }, { id: 'ord_2', status: 'PENDING_AGENT', quotedFee: null }],
      total: 2,
      counts: {},
    });
    const page = await getOrdersForAgent('agt_1', { page: 1, pageSize: 20, sort: 'NEWEST' } as never);
    expect(page.items).toEqual([
      expect.objectContaining({ id: 'ord_1', quotedFee: '1800.00' }),
      expect.objectContaining({ id: 'ord_2', quotedFee: null }),
    ]);
  });
});
