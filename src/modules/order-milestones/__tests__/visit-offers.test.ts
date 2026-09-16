import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A12 — a dispatched visit is an offer (DR 01 3424:26829, 3458:28301, 3424:26873).
 *
 * What is pinned: accepting works inside the window and is refused after it;
 * declining takes one of the five coded reasons, sends the visit back to ops
 * unassigned with the reason kept, and tells the admins; the bands offered
 * come from the order lane's derived slots minus the order's other visits,
 * and only one of them can be confirmed, on an accepted visit; an unaccepted
 * offer cannot be started; the sweep expires what the clock ran out on.
 */

const { repository, orders, logger } = vi.hoisted(() => ({
  repository: {
    findWithOrderStatus: vi.fn(),
    findDetail: vi.fn(),
    accept: vi.fn(),
    reject: vi.fn(),
    schedule: vi.fn(),
    start: vi.fn(),
    findOfferExpired: vi.fn(),
    findScheduledStartsForOrder: vi.fn(),
  },
  orders: {
    getAgentOrderIdsAwaitingWork: vi.fn(),
    getOrderSummary: vi.fn(),
    OFFER_EXPIRED_REASON: 'EXPIRED',
    rejectionText: (reason: string, note?: string) => (reason === 'OTHER' ? `OTHER: ${note}` : reason),
    shortId: (id: string) => id.slice(-6).toUpperCase(),
    notifyAdmins: vi.fn(),
    notifyAgent: vi.fn(),
    slotCandidates: vi.fn(),
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../prisma-order-milestones.repository', () => ({ prismaOrderMilestonesRepository: repository }));
vi.mock('../../orders', () => orders);
vi.mock('../../../shared/logging', () => ({ logger }));

import {
  acceptMilestone,
  expireMilestoneOffers,
  milestoneSlotCandidates,
  rejectMilestone,
  scheduleMilestone,
  startMilestone,
} from '../agent/agent-execution.service';

const NOW = new Date('2026-09-10T10:00:00.000Z');
const AGENT = 'agt_adv';

const offer = {
  id: 'ms_1',
  orderId: 'ord_0000000901',
  assignedAgentId: AGENT,
  status: 'DISPATCHED',
  offeredAt: new Date(NOW.getTime() - 5 * 60 * 1000),
  offerExpiresAt: new Date(NOW.getTime() + 20 * 60 * 1000),
  acceptedAt: null,
  template: { title: 'Advertiser visit', requirements: [] },
  orderRecord: { status: 'IN_PROGRESS', agentId: 'agt_pub', startDate: null, endDate: null },
};

const bands = [
  { start: '2026-09-10T11:30:00.000Z', end: '2026-09-10T13:30:00.000Z', label: 'Today' },
  { start: '2026-09-11T04:30:00.000Z', end: '2026-09-11T06:30:00.000Z', label: 'Tomorrow' },
];

beforeEach(() => {
  vi.clearAllMocks();
  repository.findWithOrderStatus.mockResolvedValue(offer);
  repository.findDetail.mockResolvedValue({ ...offer, acceptedAt: NOW });
  repository.accept.mockImplementation(async (id: string, at: Date) => ({ ...offer, id, acceptedAt: at }));
  repository.reject.mockImplementation(async (id: string, reason: string) => ({ ...offer, id, status: 'PENDING', assignedAgentId: null, rejectionReason: reason }));
  repository.schedule.mockImplementation(async (id: string, start: Date, end: Date) => ({ ...offer, id, scheduledStart: start, scheduledEnd: end, dueDate: start }));
  repository.start.mockResolvedValue({ ...offer, status: 'IN_PROGRESS' });
  repository.findScheduledStartsForOrder.mockResolvedValue([]);
  repository.findOfferExpired.mockResolvedValue([]);
  orders.slotCandidates.mockReturnValue(bands);
});

describe('accepting the offer', () => {
  it('takes it inside the window, and reads it back a second time', async () => {
    const accepted = await acceptMilestone('ms_1', AGENT, NOW);
    expect(repository.accept).toHaveBeenCalledWith('ms_1', NOW);
    expect(accepted).toMatchObject({ acceptedAt: NOW });

    repository.findWithOrderStatus.mockResolvedValue({ ...offer, acceptedAt: NOW });
    await acceptMilestone('ms_1', AGENT, NOW);
    expect(repository.accept).toHaveBeenCalledTimes(1);
  });

  it('is refused once the clock has run out', async () => {
    const late = new Date(offer.offerExpiresAt.getTime() + 1000);
    await expect(acceptMilestone('ms_1', AGENT, late)).rejects.toMatchObject({ statusCode: 410, code: 'OFFER_EXPIRED' });
    expect(repository.accept).not.toHaveBeenCalled();
  });

  it('is somebody else’s to answer if it is not assigned to the caller', async () => {
    await expect(acceptMilestone('ms_1', 'agt_other', NOW)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('declining it', () => {
  it('sends the visit back to ops with the coded reason, unassigned, and tells the admins', async () => {
    const declined = await rejectMilestone('ms_1', AGENT, { reason: 'TOO_FAR' });
    expect(repository.reject).toHaveBeenCalledWith('ms_1', 'TOO_FAR');
    expect(declined).toMatchObject({ status: 'PENDING', assignedAgentId: null, rejectionReason: 'TOO_FAR' });
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Visit needs an agent', expect.stringContaining('000901'), 'ord_0000000901');
  });

  it('keeps the note behind OTHER', async () => {
    await rejectMilestone('ms_1', AGENT, { reason: 'OTHER', note: 'Site is closed for renovation' });
    expect(repository.reject).toHaveBeenCalledWith('ms_1', 'OTHER: Site is closed for renovation');
  });
});

describe('the bands and the schedule', () => {
  it('offers the order lane’s derived bands inside the order’s dates, minus the order’s other visits', async () => {
    const from = new Date('2026-09-10T00:00:00.000Z');
    const to = new Date('2026-09-20T00:00:00.000Z');
    const taken = [new Date('2026-09-10T11:30:00.000Z')];
    repository.findWithOrderStatus.mockResolvedValue({ ...offer, acceptedAt: NOW, orderRecord: { ...offer.orderRecord, startDate: from, endDate: to } });
    repository.findScheduledStartsForOrder.mockResolvedValue(taken);

    const offered = await milestoneSlotCandidates('ms_1', AGENT, NOW);
    expect(orders.slotCandidates).toHaveBeenCalledWith({ now: NOW, from, to, taken });
    expect(repository.findScheduledStartsForOrder).toHaveBeenCalledWith('ord_0000000901', 'ms_1');
    expect(offered).toEqual(bands);
  });

  it('confirms one of the offered bands on an accepted visit, and sets the due date', async () => {
    repository.findWithOrderStatus.mockResolvedValue({ ...offer, acceptedAt: NOW });
    const scheduled = await scheduleMilestone('ms_1', AGENT, new Date(bands[1]!.start), NOW);
    expect(repository.schedule).toHaveBeenCalledWith('ms_1', new Date(bands[1]!.start), new Date(bands[1]!.end));
    expect(scheduled).toMatchObject({ dueDate: new Date(bands[1]!.start) });
  });

  it('refuses a time that was not offered, and a visit not yet accepted', async () => {
    repository.findWithOrderStatus.mockResolvedValue({ ...offer, acceptedAt: NOW });
    await expect(scheduleMilestone('ms_1', AGENT, new Date('2026-09-10T20:00:00.000Z'), NOW)).rejects.toMatchObject({ statusCode: 400 });
    repository.findWithOrderStatus.mockResolvedValue(offer);
    await expect(scheduleMilestone('ms_1', AGENT, new Date(bands[0]!.start), NOW)).rejects.toMatchObject({ statusCode: 400 });
    expect(repository.schedule).not.toHaveBeenCalled();
  });
});

describe('starting', () => {
  it('waits for the answer: an unaccepted offer cannot be started', async () => {
    await expect(startMilestone('ms_1', AGENT)).rejects.toMatchObject({ statusCode: 400 });
    repository.findWithOrderStatus.mockResolvedValue({ ...offer, acceptedAt: NOW });
    await startMilestone('ms_1', AGENT);
    expect(repository.start).toHaveBeenCalledWith('ms_1');
  });
});

describe('the sweep', () => {
  it('expires what the clock ran out on, unassigns it, and tells both sides', async () => {
    repository.findOfferExpired.mockResolvedValue([{ id: 'ms_1', orderId: 'ord_0000000901', assignedAgentId: AGENT }]);
    const windowStart = new Date(NOW.getTime() - 60 * 1000);
    const expired = await expireMilestoneOffers(windowStart, NOW);
    expect(repository.findOfferExpired).toHaveBeenCalledWith(windowStart, NOW);
    expect(repository.reject).toHaveBeenCalledWith('ms_1', 'EXPIRED');
    expect(orders.notifyAgent).toHaveBeenCalledWith(AGENT, 'Visit offer expired', expect.any(String), 'ord_0000000901');
    expect(orders.notifyAdmins).toHaveBeenCalledWith('Visit offer expired', expect.any(String), 'ord_0000000901');
    expect(expired).toHaveLength(1);
  });
});
