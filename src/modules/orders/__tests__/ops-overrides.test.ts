import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q51/Q90) — ops moves on an order.
 *
 * Four overrides, each with a mandatory reason, each calling the ordinary
 * service so the order moves exactly as it would have if the party had acted:
 * accept-publisher after the 30-minute window (with a consent note),
 * confirm-slot after 24 hours unanswered, collect-prints only while the agent
 * is checked in, and reassign-agent from any pre-completion state. Never
 * check-in, photos or the OTP — those are the proof a person was there.
 *
 * Cancelling writes who, when and why on their own columns instead of
 * overwriting the notes.
 */

const { repository, notify, listings, agents, payouts, qr, logging } = vi.hoisted(() => ({
  repository: {
    findById: vi.fn(),
    findWithPublisher: vi.fn(),
    findCheckIn: vi.fn(),
    findCurrentAssignment: vi.fn(),
    reassignAssignment: vi.fn(),
    createAssignment: vi.fn(),
    findAssignments: vi.fn(),
    addPhotos: vi.fn(),
    update: vi.fn(),
  },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (id: string) => id.slice(0, 6) },
  listings: { getListingWithPublisher: vi.fn(), setListingAvailability: vi.fn() },
  agents: {
    findAgentTier: vi.fn(),
    agentExists: vi.fn(),
    assertAgentAcceptsWork: vi.fn(),
    agentAcceptsWork: vi.fn(),
    findAssignableAgent: vi.fn(),
    getAgentWithUser: vi.fn(),
    getAgentZone: vi.fn(),
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
  payouts: { installationFeeFor: vi.fn().mockResolvedValue(null), recordIncentiveOnce: vi.fn() },
  qr: {
    PICKUP_PURPOSE: 'PICKUP',
    assertQrForRef: vi.fn(),
    deactivateQrsFor: vi.fn(),
    findActiveQrFor: vi.fn(),
    generateQr: vi.fn(),
  },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', () => listings);
vi.mock('../../agents', () => agents);
vi.mock('../../payouts', () => payouts);
vi.mock('../../qr', () => qr);
vi.mock('../../../shared/logging', () => logging);

import { opsAcceptPublisher, opsCollectPrints, opsConfirmSlot } from '../ops/ops.service';
import { reassignAgent } from '../assignment/assignment.service';
import { cancelOrder } from '../verification/verification.service';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-09-12T10:00:00.000Z');

const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'PENDING_PUBLISHER',
  advertiserId: 'usr_adv',
  listingId: 'lst_1',
  agentId: null,
  agentRejectionCount: 0,
  agentFeeAmount: null,
  publisherTimerExpiry: new Date(now.getTime() - HOUR),
  slotTime: null,
  slotProposedAt: null,
  notes: 'keep me',
  listing: {
    id: 'lst_1',
    title: 'MG Road hoarding',
    latitude: null,
    longitude: null,
    qrToken: null,
    agentCanInstall: true,
    publisher: { id: 'pub_1', userId: 'usr_pub', address: '14 Residency Road', city: 'Bengaluru', state: 'Karnataka' },
  },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(now);
  repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  repository.findCheckIn.mockResolvedValue(null);
  repository.createAssignment.mockResolvedValue({});
  repository.reassignAssignment.mockResolvedValue(undefined);
  agents.assertAgentAcceptsWork.mockResolvedValue(undefined);
  agents.agentExists.mockResolvedValue(true);
  agents.findAgentTier.mockResolvedValue(null);
  notify.notifyUser.mockResolvedValue(undefined);
  notify.notifyAdmins.mockResolvedValue(undefined);
  notify.notifyAgent.mockResolvedValue(undefined);
  listings.setListingAvailability.mockResolvedValue(undefined);
});

describe('accept-publisher on the publisher’s behalf', () => {
  it('accepts through the ordinary service once the 30-minute window has passed', async () => {
    repository.findWithPublisher.mockResolvedValue(order());

    const updated = await opsAcceptPublisher('ord_1', { reason: 'Publisher confirmed on the phone', consentNote: 'Call at 09:40 with Ramesh' });

    expect(updated).toMatchObject({ status: 'PENDING_PRINT', meetingPlace: '14 Residency Road' });
    expect(repository.update).toHaveBeenCalledWith('ord_1', expect.objectContaining({ status: 'PENDING_PRINT' }));
  });

  it('refuses while the publisher still has time', async () => {
    repository.findWithPublisher.mockResolvedValue(order({ publisherTimerExpiry: new Date(now.getTime() + 5 * 60 * 1000) }));
    await expect(opsAcceptPublisher('ord_1', { reason: 'x', consentNote: 'y' })).rejects.toThrow('OPS_WINDOW_OPEN');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses an order that is not waiting on the publisher', async () => {
    repository.findWithPublisher.mockResolvedValue(order({ status: 'PENDING_PRINT' }));
    await expect(opsAcceptPublisher('ord_1', { reason: 'x', consentNote: 'y' })).rejects.toThrow('WRONG_STATUS');
  });
});

describe('confirm-slot on the publisher’s behalf', () => {
  it('confirms a slot the publisher has left unanswered for 24 hours', async () => {
    repository.findWithPublisher.mockResolvedValue(
      order({ status: 'SLOT_PROPOSED', agentId: 'agt_1', slotTime: new Date(now.getTime() + 48 * HOUR), slotProposedAt: new Date(now.getTime() - 25 * HOUR) }),
    );

    const updated = await opsConfirmSlot('ord_1', { reason: 'No answer in a day' });

    expect(updated).toMatchObject({ status: 'SLOT_CONFIRMED' });
    expect(listings.setListingAvailability).toHaveBeenCalledWith('lst_1', false);
    expect(notify.notifyAgent).toHaveBeenCalledWith('agt_1', expect.stringContaining('Slot confirmed'), expect.any(String), 'ord_1');
  });

  it('refuses inside the 24 hours, and with no slot proposed at all', async () => {
    repository.findWithPublisher.mockResolvedValue(
      order({ status: 'SLOT_PROPOSED', agentId: 'agt_1', slotTime: new Date(), slotProposedAt: new Date(now.getTime() - 2 * HOUR) }),
    );
    await expect(opsConfirmSlot('ord_1', { reason: 'x' })).rejects.toThrow('OPS_WINDOW_OPEN');

    repository.findWithPublisher.mockResolvedValue(order({ status: 'SLOT_PROPOSED', agentId: 'agt_1', slotTime: null, slotProposedAt: null }));
    await expect(opsConfirmSlot('ord_1', { reason: 'x' })).rejects.toThrow('OPS_WINDOW_OPEN');
  });
});

describe('collect-prints on the agent’s behalf', () => {
  it('records the collection only while the agent is checked in at the site', async () => {
    repository.findById.mockResolvedValue(order({ status: 'SLOT_CONFIRMED', agentId: 'agt_1' }));
    repository.findCheckIn.mockResolvedValue({ orderId: 'ord_1', checkedInAt: now });

    const updated = await opsCollectPrints('ord_1', { reason: 'Agent on site, app crashed' });

    expect(updated).toMatchObject({ status: 'IN_PROGRESS' });
  });

  it('refuses when there is no check-in', async () => {
    repository.findById.mockResolvedValue(order({ status: 'SLOT_CONFIRMED', agentId: 'agt_1' }));
    await expect(opsCollectPrints('ord_1', { reason: 'x' })).rejects.toThrow('OPS_NO_CHECKIN');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('refuses an order with no agent', async () => {
    repository.findById.mockResolvedValue(order({ status: 'SLOT_CONFIRMED', agentId: null }));
    await expect(opsCollectPrints('ord_1', { reason: 'x' })).rejects.toThrow('WRONG_STATUS');
  });
});

describe('reassign-agent', () => {
  beforeEach(() => {
    repository.findById.mockResolvedValue(order({ status: 'SLOT_CONFIRMED', agentId: 'agt_old', slotTime: new Date() }));
    repository.findCurrentAssignment.mockResolvedValue({ id: 'asg_old', agentId: 'agt_old', status: 'ACCEPTED' });
  });

  it('closes the current assignment as REASSIGNED and makes a fresh 25-minute offer to the new agent', async () => {
    await reassignAgent('ord_1', 'agt_new', 'Old agent unreachable');

    expect(agents.assertAgentAcceptsWork).toHaveBeenCalledWith('agt_new');
    expect(repository.reassignAssignment).toHaveBeenCalledWith('asg_old', 'Old agent unreachable');
    expect(repository.createAssignment).toHaveBeenCalledWith('ord_1', 'agt_new', null);
    const patch = repository.update.mock.calls.find(([id]) => id === 'ord_1')![1] as Record<string, unknown>;
    expect(patch).toMatchObject({ status: 'PENDING_AGENT', agentId: 'agt_new', agentEscalated: false, slotTime: null, slotProposedAt: null });
    expect((patch['agentTimerExpiry'] as Date).getTime()).toBe(now.getTime() + 25 * 60 * 1000);
    expect(notify.notifyAgent).toHaveBeenCalledWith('agt_old', expect.stringContaining('reassigned'), expect.any(String), 'ord_1');
    expect(notify.notifyAgent).toHaveBeenCalledWith('agt_new', 'New order assigned', expect.any(String), 'ord_1');
  });

  it('works from PENDING_AGENT with an unanswered offer, and refuses once the order is past IN_PROGRESS', async () => {
    repository.findById.mockResolvedValue(order({ status: 'PENDING_AGENT', agentId: 'agt_old' }));
    repository.findCurrentAssignment.mockResolvedValue({ id: 'asg_old', agentId: 'agt_old', status: 'PENDING' });
    await reassignAgent('ord_1', 'agt_new', 'Silent');
    expect(repository.reassignAssignment).toHaveBeenCalledWith('asg_old', 'Silent');

    repository.findById.mockResolvedValue(order({ status: 'PENDING_OTP', agentId: 'agt_old' }));
    await expect(reassignAgent('ord_1', 'agt_new', 'Too late')).rejects.toThrow('WRONG_STATUS');
  });

  it('refuses the agent already holding the job', async () => {
    await expect(reassignAgent('ord_1', 'agt_old', 'Same person')).rejects.toThrow('SAME_AGENT');
    expect(repository.createAssignment).not.toHaveBeenCalled();
  });
});

describe('cancelling', () => {
  it('writes who, when and why on their own columns, leaves the notes alone, and tells every party', async () => {
    repository.findWithPublisher.mockResolvedValue(order({ status: 'SLOT_CONFIRMED', agentId: 'agt_1' }));

    await cancelOrder('ord_1', 'Advertiser withdrew', 'usr_admin');

    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      status: 'CANCELLED',
      cancelledAt: now,
      cancelledByUserId: 'usr_admin',
      cancellationReason: 'Advertiser withdrew',
    });
    expect(listings.setListingAvailability).toHaveBeenCalledWith('lst_1', true);
    expect(notify.notifyUser).toHaveBeenCalledWith('usr_adv', 'Order cancelled', expect.stringContaining('Advertiser withdrew'), 'ord_1');
    expect(notify.notifyUser).toHaveBeenCalledWith('usr_pub', 'Order cancelled', expect.any(String), 'ord_1');
    expect(notify.notifyAgent).toHaveBeenCalledWith('agt_1', 'Order cancelled', expect.any(String), 'ord_1');
  });

  it('still refuses a completed order', async () => {
    repository.findWithPublisher.mockResolvedValue(order({ status: 'COMPLETED' }));
    await expect(cancelOrder('ord_1', 'x', 'usr_admin')).rejects.toThrow('ALREADY_COMPLETED');
  });
});
