import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Closing an account — Lot A (Q21).
 *
 * The act, and the order it happens in: stop the work through `suspension`,
 * stamp the person closed, end the sessions, retire the spots, ask for the
 * last payout. Everything here is a consequence somebody would notice if it
 * silently stopped happening, so each one is pinned.
 */

const {
  repository,
  audit,
  auth,
  accessControl,
  agreements,
  campaigns,
  listings,
  milestones,
  notifications,
  orders,
  payouts,
  support,
  suspension,
  visits,
  wallets,
} = vi.hoisted(() => ({
  repository: {
    findParties: vi.fn(),
    closeUser: vi.fn(),
    createCase: vi.fn(),
    findCase: vi.fn(),
    findPendingCaseForUser: vi.fn(),
    setCaseTicket: vi.fn(),
    decideCase: vi.fn(),
    listCases: vi.fn(),
  },
  audit: { logActivity: vi.fn() },
  auth: { revokeSessions: vi.fn() },
  // Lot K2: the last-super-admin guard on close; resolves unless a test says otherwise.
  accessControl: { assertNotLastSuperAdmin: vi.fn(async () => undefined) },
  agreements: { countAcceptancesFor: vi.fn() },
  campaigns: { listOpenCampaignsForAdvertiser: vi.fn() },
  listings: { getListingsForPublisher: vi.fn(), retireListingsForPublisher: vi.fn() },
  milestones: { countDispatchedMilestones: vi.fn() },
  notifications: { createNotification: vi.fn() },
  orders: {
    countPendingAgentOffers: vi.fn(),
    findOpenOrdersForAdvertiserUser: vi.fn(),
    findOpenOrdersForListings: vi.fn(),
  },
  payouts: { listWithdrawals: vi.fn(), requestClosingWithdrawal: vi.fn() },
  support: { countOpenTicketsForUser: vi.fn(), raiseAccountTicket: vi.fn() },
  suspension: {
    suspendParty: vi.fn(),
    SCOPES_BY_PARTY: {
      LISTING: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL'],
      PUBLISHER: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
      ADVERTISER: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
      AGENT: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
    },
  },
  visits: { countOpenVisitsForAgent: vi.fn() },
  wallets: { findWalletFor: vi.fn(), snapshot: vi.fn() },
}));

vi.mock('../prisma-account-lifecycle.repository', () => ({
  prismaAccountLifecycleRepository: repository,
}));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../auth', () => auth);
vi.mock('../../access-control', () => accessControl);
vi.mock('../../agreements', () => agreements);
vi.mock('../../campaigns', () => campaigns);
vi.mock('../../listings', () => listings);
vi.mock('../../order-milestones', () => milestones);
vi.mock('../../notifications', () => notifications);
vi.mock('../../orders', () => orders);
vi.mock('../../payouts', () => payouts);
vi.mock('../../support', () => support);
vi.mock('../../suspension', () => suspension);
vi.mock('../../visits', () => visits);
vi.mock('../../wallets', () => wallets);

import {
  closeAccount,
  decideClosureCase,
  openClosureCase,
  requestOwnClosure,
} from '../closure/closure.service';

const USER = 'usr_1';
const ADMIN = 'usr_admin';
const REASON = 'Owner asked to leave the platform';

const parties = (over: Record<string, unknown> = {}) => ({
  userId: USER,
  name: 'Asha Rao',
  mobile: '+919876543210',
  email: null,
  isActive: true,
  closedAt: null,
  closeReason: null,
  publisherId: null,
  advertiserId: null,
  agentProfileId: null,
  ...over,
});

const snapshot = (balance: string) => ({
  walletId: 'wal_1',
  balance,
  goodwill: '0.00',
  spendable: balance,
  pendingClearance: '0.00',
  held: '0.00',
  openWithdrawals: '0.00',
  withdrawable: balance,
  lastActivityAt: null,
  frozenAt: null,
  frozenReason: null,
});

const caseRow = (over: Record<string, unknown> = {}) => ({
  id: 'acc_1',
  userId: USER,
  ticketId: null,
  reason: REASON,
  requestedById: USER,
  requestedAt: new Date('2026-09-01T00:00:00Z'),
  walletBalance: null,
  withdrawalsInFlight: 0,
  openOrders: 0,
  openWork: 0,
  lossNote: null,
  decision: 'PENDING',
  decidedById: null,
  decidedAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findParties.mockResolvedValue(parties());
  repository.closeUser.mockResolvedValue(undefined);
  repository.findPendingCaseForUser.mockResolvedValue(null);
  repository.createCase.mockImplementation(async (data: Record<string, unknown>) =>
    caseRow({ ...data }),
  );
  repository.setCaseTicket.mockImplementation(async (id: string, ticketId: string) =>
    caseRow({ id, ticketId }),
  );
  repository.decideCase.mockImplementation(async (id: string, patch: Record<string, unknown>) =>
    caseRow({ id, ...patch }),
  );
  audit.logActivity.mockResolvedValue(undefined);
  auth.revokeSessions.mockResolvedValue(undefined);
  agreements.countAcceptancesFor.mockResolvedValue(0);
  campaigns.listOpenCampaignsForAdvertiser.mockResolvedValue([]);
  listings.getListingsForPublisher.mockResolvedValue([]);
  listings.retireListingsForPublisher.mockResolvedValue([]);
  milestones.countDispatchedMilestones.mockResolvedValue(0);
  notifications.createNotification.mockResolvedValue({});
  orders.countPendingAgentOffers.mockResolvedValue(0);
  orders.findOpenOrdersForAdvertiserUser.mockResolvedValue([]);
  orders.findOpenOrdersForListings.mockResolvedValue([]);
  payouts.listWithdrawals.mockResolvedValue([]);
  payouts.requestClosingWithdrawal.mockResolvedValue({
    withdrawal: { reference: 'WDR-2026-000200' },
    amount: '1200.00',
    reason: 'REQUESTED',
  });
  support.countOpenTicketsForUser.mockResolvedValue(0);
  support.raiseAccountTicket.mockResolvedValue({ id: 'tkt_1', displayId: 'TKT-0001' });
  suspension.suspendParty.mockResolvedValue({});
  visits.countOpenVisitsForAgent.mockResolvedValue(0);
  wallets.findWalletFor.mockResolvedValue(null);
  wallets.snapshot.mockResolvedValue(snapshot('0.00'));
});

describe('raising a case', () => {
  it('records the four numbers that were true when it was raised', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1', agentProfileId: 'agt_1' }));
    wallets.findWalletFor.mockImplementation(async (owner: { kind: string }) =>
      owner.kind === 'PUBLISHER' ? { id: 'wal_1' } : null,
    );
    wallets.snapshot.mockResolvedValue(snapshot('1200.00'));
    orders.countPendingAgentOffers.mockResolvedValue(2);

    await openClosureCase(USER, { reason: REASON, requestedById: ADMIN });

    expect(repository.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        reason: REASON,
        requestedById: ADMIN,
        withdrawalsInFlight: 0,
        openOrders: 0,
        openWork: 2,
      }),
    );
    const written = repository.createCase.mock.calls[0]![0] as { walletBalance: { toString(): string } };
    expect(written.walletBalance.toString()).toBe('1200');
  });

  it('returns the pending case rather than stacking a second one', async () => {
    repository.findPendingCaseForUser.mockResolvedValue(caseRow());
    const result = await openClosureCase(USER, { reason: REASON });
    expect(result.created).toBe(false);
    expect(repository.createCase).not.toHaveBeenCalled();
  });

  it('raises the ordinary ACCOUNT ticket and links it, when the person asks', async () => {
    const result = await requestOwnClosure(USER, REASON);
    expect(support.raiseAccountTicket).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, title: 'Account closure requested' }),
    );
    expect(repository.setCaseTicket).toHaveBeenCalledWith('acc_1', 'tkt_1');
    expect(result.case.ticketId).toBe('tkt_1');
  });

  it('keeps the case when the ticket cannot be raised', async () => {
    support.raiseAccountTicket.mockRejectedValue(new Error('support is down'));
    const result = await requestOwnClosure(USER, REASON);
    expect(result.created).toBe(true);
    expect(result.case.id).toBe('acc_1');
  });
});

describe('closeAccount', () => {
  it('refuses with the blockers when money is still in flight', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    wallets.findWalletFor.mockResolvedValue({ id: 'wal_1' });
    wallets.snapshot.mockResolvedValue(snapshot('900.00'));
    payouts.listWithdrawals.mockResolvedValue([
      { id: 'wdr_1', reference: 'WDR-2026-000118', status: 'APPROVED' },
    ]);

    await expect(closeAccount(USER, REASON, ADMIN)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CLOSURE_BLOCKED',
    });
    expect(repository.closeUser).not.toHaveBeenCalled();
    expect(suspension.suspendParty).not.toHaveBeenCalled();
  });

  it('refuses an account that is already closed', async () => {
    repository.findParties.mockResolvedValue(parties({ closedAt: new Date() }));
    await expect(closeAccount(USER, REASON, ADMIN)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("Lot K2: refuses the last active super admin before it touches anything, with access-control's own code", async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    accessControl.assertNotLastSuperAdmin.mockRejectedValueOnce(
      Object.assign(new Error('last'), { statusCode: 409, code: 'LAST_SUPER_ADMIN' }),
    );
    await expect(closeAccount(USER, REASON, ADMIN)).rejects.toMatchObject({ statusCode: 409, code: 'LAST_SUPER_ADMIN' });
    expect(accessControl.assertNotLastSuperAdmin).toHaveBeenCalledWith(USER, 'CLOSE');
    expect(repository.closeUser).not.toHaveBeenCalled();
    expect(suspension.suspendParty).not.toHaveBeenCalled();
  });

  it('suspends every profile on the four closure scopes the party admits', async () => {
    repository.findParties.mockResolvedValue(
      parties({ publisherId: 'pub_1', advertiserId: 'adv_1', agentProfileId: 'agt_1' }),
    );

    await closeAccount(USER, REASON, ADMIN);

    expect(suspension.suspendParty).toHaveBeenCalledTimes(3);
    expect(suspension.suspendParty).toHaveBeenCalledWith('PUBLISHER', 'pub_1', {
      scopes: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'FREEZE_WALLET', 'BLOCK_SIGNIN'],
      reason: `Account closed: ${REASON}`,
      byUserId: ADMIN,
    });
    // STOP_ACCRUAL is not one of the closure scopes even though a publisher
    // admits it: the closure stops new work and the money, not the earning on
    // spots that are already coming down.
    const scopes = suspension.suspendParty.mock.calls.map((call) => call[2].scopes);
    expect(scopes.every((list: string[]) => !list.includes('STOP_ACCRUAL'))).toBe(true);
  });

  it('stamps the person, ends the sessions and retires the spots', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    listings.retireListingsForPublisher.mockResolvedValue(['lst_1', 'lst_2']);

    const outcome = await closeAccount(USER, REASON, ADMIN);

    expect(repository.closeUser).toHaveBeenCalledWith(USER, {
      reason: REASON,
      byUserId: ADMIN,
      at: outcome.closedAt,
    });
    expect(auth.revokeSessions).toHaveBeenCalledWith(USER, 'ACCOUNT_CLOSED');
    expect(listings.retireListingsForPublisher).toHaveBeenCalledWith('pub_1');
    expect(outcome.listingsRetired).toEqual(['lst_1', 'lst_2']);
  });

  it('asks for the last payout when there is money left', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    wallets.findWalletFor.mockResolvedValue({ id: 'wal_1' });
    wallets.snapshot.mockResolvedValue(snapshot('1200.00'));

    const outcome = await closeAccount(USER, REASON, ADMIN);

    expect(payouts.requestClosingWithdrawal).toHaveBeenCalledWith('wal_1', { userId: USER });
    expect(outcome.payouts).toEqual([
      {
        walletId: 'wal_1',
        amount: '1200.00',
        reference: 'WDR-2026-000200',
        outcome: 'REQUESTED',
      },
    ]);
    expect(outcome.note).toBeNull();
  });

  it('leaves the balance frozen and says so when no verified method exists', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    wallets.findWalletFor.mockResolvedValue({ id: 'wal_1' });
    wallets.snapshot.mockResolvedValue(snapshot('1200.00'));
    payouts.requestClosingWithdrawal.mockResolvedValue({
      withdrawal: null,
      amount: '1200.00',
      reason: 'NO_VERIFIED_METHOD',
    });

    const outcome = await closeAccount(USER, REASON, ADMIN);
    expect(outcome.payouts[0]).toMatchObject({ outcome: 'NO_VERIFIED_METHOD', reference: null });
    expect(outcome.note).toContain('no verified payout method');
  });

  it('raises no payout when a loss has been written off', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    wallets.findWalletFor.mockResolvedValue({ id: 'wal_1' });
    wallets.snapshot.mockResolvedValue(snapshot('1200.00'));

    const outcome = await closeAccount(USER, REASON, ADMIN, 'Written off against a chargeback');
    expect(payouts.requestClosingWithdrawal).not.toHaveBeenCalled();
    expect(outcome.note).toContain('a loss was recorded');
  });

  it('audits against the person and tells them', async () => {
    await closeAccount(USER, REASON, ADMIN);
    expect(audit.logActivity).toHaveBeenCalledWith(
      ADMIN,
      'ACCOUNT_CLOSED',
      expect.objectContaining({ targetType: 'User', targetId: USER, module: 'account-lifecycle' }),
    );
    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, type: 'SYSTEM' }),
    );
  });
});

describe('deciding a case', () => {
  it('closes the account and records the decision', async () => {
    repository.findCase.mockResolvedValue(caseRow());
    const result = await decideClosureCase('acc_1', { decision: 'CLOSED' }, ADMIN);

    expect(repository.closeUser).toHaveBeenCalled();
    expect(repository.decideCase).toHaveBeenCalledWith(
      'acc_1',
      expect.objectContaining({ decision: 'CLOSED', decidedById: ADMIN }),
    );
    expect(result.outcome).not.toBeNull();
  });

  it('leaves the case open when the closure is blocked', async () => {
    repository.findCase.mockResolvedValue(caseRow());
    repository.findParties.mockResolvedValue(parties({ advertiserId: 'adv_1' }));
    campaigns.listOpenCampaignsForAdvertiser.mockResolvedValue([
      { id: 'cmp_1', reference: 'CMP-1', status: 'LIVE' },
    ]);

    await expect(decideClosureCase('acc_1', { decision: 'CLOSED' }, ADMIN)).rejects.toMatchObject({
      code: 'CLOSURE_BLOCKED',
    });
    expect(repository.decideCase).not.toHaveBeenCalled();
  });

  it('refuses without touching the account', async () => {
    repository.findCase.mockResolvedValue(caseRow());
    const result = await decideClosureCase(
      'acc_1',
      { decision: 'REFUSED', lossNote: 'Still owes for two campaigns' },
      ADMIN,
    );
    expect(repository.closeUser).not.toHaveBeenCalled();
    expect(result.outcome).toBeNull();
    expect(repository.decideCase).toHaveBeenCalledWith(
      'acc_1',
      expect.objectContaining({ decision: 'REFUSED', lossNote: 'Still owes for two campaigns' }),
    );
  });

  it('refuses to decide a case twice', async () => {
    repository.findCase.mockResolvedValue(caseRow({ decision: 'CLOSED' }));
    await expect(decideClosureCase('acc_1', { decision: 'REFUSED' }, ADMIN)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
