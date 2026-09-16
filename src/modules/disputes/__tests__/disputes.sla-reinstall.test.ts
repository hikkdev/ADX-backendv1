import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q53/Q54/Q91/Q92) on disputes.
 *
 * The SLA clock pauses while a case is AWAITING_RESPONSE — the same pause a
 * support ticket takes while WAITING — and the party's next message restarts
 * it with the pause banked; breach is derived on read. A REINSTALL outcome
 * raises an INSTALLATION visit on the order through `order-milestones`,
 * offered to the order's agent by default, and the case reads "resolved —
 * re-install pending" until that visit completes. A case names the open
 * fraud case that cites it.
 */

const { repository, identifiers, users, notifications, wallets, milestones, fraud } = vi.hoisted(() => ({
  repository: {
    findManyForUser: vi.fn(),
    findById: vi.fn(),
    findSummaryById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    addMessage: vi.fn(),
    addEvidence: vi.fn(),
    findQueue: vi.fn(),
    summary: vi.fn(),
    findOrderParties: vi.fn(),
    partyIdsForUser: vi.fn(),
  },
  identifiers: { allocateIdentifier: vi.fn() },
  users: { getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() },
  notifications: { createNotification: vi.fn() },
  wallets: { ensureWallet: vi.fn(), move: vi.fn() },
  milestones: { raiseReinstallMilestone: vi.fn(), findMilestoneStatuses: vi.fn() },
  fraud: { findOpenFraudCasesForDisputes: vi.fn() },
}));

vi.mock('../prisma-disputes.repository', () => ({ prismaDisputesRepository: repository }));
vi.mock('../../identifiers', () => identifiers);
vi.mock('../../users', () => users);
vi.mock('../../notifications', () => notifications);
vi.mock('../../wallets', () => wallets);
vi.mock('../../order-milestones', () => milestones);
vi.mock('../../fraud', () => fraud);

import { addMessage, getVisibleDispute, resolve, setStatus, slaOf } from '../disputes.service';
import { pickPartyRecord, registerPartyLookupPort, resetPartyLookupPort } from '../party-lookup.port';

type Clock = Parameters<typeof slaOf>[0];

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-09-12T09:00:00.000Z');
const admin = { sub: 'usr_admin', roles: ['ADMIN'] };
const advertiser = { sub: 'usr_adv', roles: ['ADVERTISER'] };

const base = (over: Record<string, unknown> = {}) => ({
  id: 'dsp_1',
  displayId: 'DSP-1209-2601',
  raisedByUserId: 'usr_adv',
  raisedAs: 'ADVERTISER',
  againstParty: 'PUBLISHER',
  againstUserId: 'usr_pub',
  orderId: 'ord_1',
  listingId: 'lst_1',
  reason: 'PROOF_REJECTED',
  detail: 'The after photo shows the wrong wall.',
  amountClaimed: null,
  status: 'UNDER_REVIEW',
  slaDueAt: new Date(now.getTime() + 48 * HOUR),
  slaPausedAt: null,
  slaPausedMs: 0,
  reinstallMilestoneId: null,
  reviewStartedAt: now,
  resolvedAt: null,
  creditedAmount: null,
  creditStatus: 'NONE',
  reopenUntil: null,
  createdAt: new Date(now.getTime() - 24 * HOUR),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  users.listAdminUserIds.mockResolvedValue(['usr_admin']);
  users.getUserDisplayName.mockResolvedValue('Meera S');
  // T-B: a desk write answers the detail view, re-read after the update.
  repository.update.mockImplementation(async (id: string, data: Record<string, unknown>) => {
    const row = { ...base(), id, ...data };
    repository.findById.mockResolvedValue({ ...row, order: null, raisedBy: { id: 'usr_adv', name: 'Meera' }, messages: [], evidence: [] });
    return row;
  });
  repository.addMessage.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'dm_1', ...data }));
  repository.findSummaryById.mockResolvedValue(base());
  milestones.raiseReinstallMilestone.mockResolvedValue({ id: 'ms_re', status: 'DISPATCHED' });
  milestones.findMilestoneStatuses.mockResolvedValue([]);
  fraud.findOpenFraudCasesForDisputes.mockResolvedValue([]);
});

describe('the paused clock', () => {
  it('AWAITING_RESPONSE stamps the pause; the party’s next message lifts it and moves the due date by the wait', async () => {
    await setStatus('dsp_1', admin, 'AWAITING_RESPONSE', 'Send the before photo', now);
    expect(repository.update).toHaveBeenCalledWith('dsp_1', expect.objectContaining({ status: 'AWAITING_RESPONSE', slaPausedAt: now }));

    vi.clearAllMocks();
    repository.findSummaryById.mockResolvedValue(base({ status: 'AWAITING_RESPONSE', slaPausedAt: now }));
    await addMessage('dsp_1', advertiser, 'Here it is', new Date(now.getTime() + 6 * HOUR));

    expect(repository.update).toHaveBeenCalledWith('dsp_1', {
      status: 'UNDER_REVIEW',
      slaPausedAt: null,
      slaPausedMs: 6 * HOUR,
      slaDueAt: new Date(now.getTime() + 48 * HOUR + 6 * HOUR),
    });
  });

  it('an ops message on a paused case does not lift the pause; ops moving it elsewhere does', async () => {
    repository.findSummaryById.mockResolvedValue(base({ status: 'AWAITING_RESPONSE', slaPausedAt: now }));
    await addMessage('dsp_1', admin, 'Still waiting', new Date(now.getTime() + HOUR));
    expect(repository.update).not.toHaveBeenCalled();

    await setStatus('dsp_1', admin, 'ESCALATED', 'Taking this up', new Date(now.getTime() + 2 * HOUR));
    expect(repository.update).toHaveBeenCalledWith('dsp_1', expect.objectContaining({ status: 'ESCALATED', slaPausedAt: null, slaPausedMs: 2 * HOUR }));
  });

  it('breach is derived on read and never advances while paused', () => {
    expect(slaOf(base() as Clock, new Date(now.getTime() + 49 * HOUR))).toMatchObject({ breached: true });
    expect(slaOf(base() as Clock, now)).toMatchObject({ breached: false, paused: false });
    const paused = slaOf(base({ status: 'AWAITING_RESPONSE', slaPausedAt: now }) as Clock, new Date(now.getTime() + 60 * HOUR));
    expect(paused).toMatchObject({ breached: false, paused: true });
    expect(paused.dueAt!.getTime()).toBe(now.getTime() + 48 * HOUR + 60 * HOUR);
    expect(slaOf(base({ status: 'RESOLVED', resolvedAt: now }) as Clock, new Date(now.getTime() + 100 * HOUR))).toMatchObject({ breached: false });
  });
});

describe('REINSTALL', () => {
  it('raises the visit on the order through order-milestones, stores it on the case, and reads as pending until it completes', async () => {
    const updated = await resolve('dsp_1', admin, { outcome: 'REINSTALL', note: 'The agent will put it up again.' }, now);

    expect(milestones.raiseReinstallMilestone).toHaveBeenCalledWith({ orderId: 'ord_1', disputeId: 'dsp_1', agentId: undefined });
    expect(repository.update).toHaveBeenCalledWith('dsp_1', expect.objectContaining({ status: 'RESOLVED', outcome: 'REINSTALL', reinstallMilestoneId: 'ms_re' }));
    expect(updated).toMatchObject({ reinstallMilestoneId: 'ms_re' });

    repository.findById.mockResolvedValue({ ...base({ status: 'RESOLVED', outcome: 'REINSTALL', reinstallMilestoneId: 'ms_re' }), order: null, raisedBy: { id: 'usr_adv', name: 'Meera' }, messages: [], evidence: [] });
    milestones.findMilestoneStatuses.mockResolvedValue([{ id: 'ms_re', status: 'DISPATCHED' }]);
    expect(await getVisibleDispute('dsp_1', admin)).toMatchObject({ reinstallPending: true, reinstallStatus: 'DISPATCHED' });

    milestones.findMilestoneStatuses.mockResolvedValue([{ id: 'ms_re', status: 'COMPLETED' }]);
    expect(await getVisibleDispute('dsp_1', admin)).toMatchObject({ reinstallPending: false });
  });

  it('lets ops name the agent, and refuses a case with no order', async () => {
    await resolve('dsp_1', admin, { outcome: 'REINSTALL', note: 'x', agentId: 'agt_2' }, now);
    expect(milestones.raiseReinstallMilestone).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agt_2' }));

    repository.findSummaryById.mockResolvedValue(base({ orderId: null }));
    await expect(resolve('dsp_1', admin, { outcome: 'REINSTALL', note: 'x' }, now)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the open fraud case', () => {
  it('rides on the read when one cites the dispute', async () => {
    repository.findById.mockResolvedValue({ ...base(), order: null, raisedBy: { id: 'usr_adv', name: 'Meera' }, messages: [], evidence: [] });
    fraud.findOpenFraudCasesForDisputes.mockResolvedValue([{ id: 'frd_1', displayId: 'FRD-26-0001', status: 'INVESTIGATING', disputeId: 'dsp_1' }]);
    expect(await getVisibleDispute('dsp_1', admin)).toMatchObject({ openFraudCase: { id: 'frd_1', displayId: 'FRD-26-0001', status: 'INVESTIGATING' } });
    expect(await getVisibleDispute('dsp_1', advertiser)).toMatchObject({ openFraudCase: null });
  });
});

describe('E7-3: the party the case is against', () => {
  const detail = () => ({ ...base(), order: null, raisedBy: { id: 'usr_adv', name: 'Meera' }, messages: [], evidence: [] });

  beforeEach(() => {
    fraud.findOpenFraudCasesForDisputes.mockResolvedValue([]);
    repository.findById.mockResolvedValue(detail());
  });

  it('names the publisher record on the ADMIN read, and nothing on a party read', async () => {
    const partiesForUsers = vi.fn(async () => new Map([['usr_pub', [{ type: 'PUBLISHER' as const, id: 'pub_1', displayId: 'PUB-1009-2601', name: 'Kumar Stores' }]]]));
    registerPartyLookupPort({ partiesForUsers });
    try {
      expect(await getVisibleDispute('dsp_1', admin)).toMatchObject({
        againstParty: 'PUBLISHER',
        against: { type: 'PUBLISHER', id: 'pub_1', displayId: 'PUB-1009-2601', name: 'Kumar Stores' },
      });
      expect(partiesForUsers).toHaveBeenCalledWith(['usr_pub']);
      expect(await getVisibleDispute('dsp_1', advertiser)).toMatchObject({ againstParty: 'PUBLISHER', against: null });
    } finally {
      resetPartyLookupPort();
    }
  });

  it('is null against ADX, when the login has no record, or with no port registered', async () => {
    resetPartyLookupPort();
    expect(await getVisibleDispute('dsp_1', admin)).toMatchObject({ against: null });

    registerPartyLookupPort({ partiesForUsers: vi.fn(async () => new Map()) });
    try {
      expect(await getVisibleDispute('dsp_1', admin)).toMatchObject({ against: null });
      repository.findById.mockResolvedValue({ ...detail(), againstParty: 'ADX', againstUserId: null });
      expect(await getVisibleDispute('dsp_1', admin)).toMatchObject({ againstParty: 'ADX', against: null });
    } finally {
      resetPartyLookupPort();
    }
  });

  it('picks the record of the type the case names when a login has several', () => {
    const agent = { type: 'AGENT' as const, id: 'agt_1', displayId: 'AGT-1', name: 'Ravi' };
    const publisher = { type: 'PUBLISHER' as const, id: 'pub_1', displayId: 'PUB-1', name: 'Ravi' };
    expect(pickPartyRecord([publisher, agent], 'AGENT')).toBe(agent);
    expect(pickPartyRecord([publisher, agent], 'ADVERTISER')).toBe(publisher);
    expect(pickPartyRecord(undefined, 'AGENT')).toBeNull();
  });
});
