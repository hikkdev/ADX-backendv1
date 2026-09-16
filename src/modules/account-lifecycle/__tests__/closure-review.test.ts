import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What stops a closure, and what only gets reported — Lot A (Q21).
 *
 * The review is the whole feature's judgement in one place: three things are
 * ADX's money or ADX's promise and refuse the close, everything else is a
 * number on a screen. Each is pinned here against the module it comes from.
 */

const {
  repository,
  agreements,
  campaigns,
  listings,
  milestones,
  orders,
  payouts,
  support,
  visits,
  wallets,
} = vi.hoisted(() => ({
  repository: { findParties: vi.fn() },
  agreements: { countAcceptancesFor: vi.fn() },
  campaigns: { listOpenCampaignsForAdvertiser: vi.fn() },
  listings: { getListingsForPublisher: vi.fn(), retireListingsForPublisher: vi.fn() },
  milestones: { countDispatchedMilestones: vi.fn() },
  orders: {
    countPendingAgentOffers: vi.fn(),
    findOpenOrdersForAdvertiserUser: vi.fn(),
    findOpenOrdersForListings: vi.fn(),
  },
  payouts: { listWithdrawals: vi.fn(), requestClosingWithdrawal: vi.fn() },
  support: { countOpenTicketsForUser: vi.fn(), raiseAccountTicket: vi.fn() },
  visits: { countOpenVisitsForAgent: vi.fn() },
  wallets: { findWalletFor: vi.fn(), snapshot: vi.fn() },
}));

vi.mock('../prisma-account-lifecycle.repository', () => ({
  prismaAccountLifecycleRepository: repository,
}));
vi.mock('../../agreements', () => agreements);
vi.mock('../../campaigns', () => campaigns);
vi.mock('../../listings', () => listings);
vi.mock('../../order-milestones', () => milestones);
vi.mock('../../orders', () => orders);
vi.mock('../../payouts', () => payouts);
vi.mock('../../support', () => support);
vi.mock('../../visits', () => visits);
vi.mock('../../wallets', () => wallets);

import { blockingOf, closureReview } from '../closure/closure-review';

const USER = 'usr_1';

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

const snapshot = (balance: string, withdrawable = balance) => ({
  walletId: 'wal_1',
  balance,
  goodwill: '0.00',
  spendable: balance,
  pendingClearance: '0.00',
  held: '0.00',
  openWithdrawals: '0.00',
  withdrawable,
  lastActivityAt: null,
  frozenAt: null,
  frozenReason: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findParties.mockResolvedValue(parties());
  agreements.countAcceptancesFor.mockResolvedValue(0);
  campaigns.listOpenCampaignsForAdvertiser.mockResolvedValue([]);
  listings.getListingsForPublisher.mockResolvedValue([]);
  milestones.countDispatchedMilestones.mockResolvedValue(0);
  orders.countPendingAgentOffers.mockResolvedValue(0);
  orders.findOpenOrdersForAdvertiserUser.mockResolvedValue([]);
  orders.findOpenOrdersForListings.mockResolvedValue([]);
  payouts.listWithdrawals.mockResolvedValue([]);
  support.countOpenTicketsForUser.mockResolvedValue(0);
  visits.countOpenVisitsForAgent.mockResolvedValue(0);
  wallets.findWalletFor.mockResolvedValue(null);
  wallets.snapshot.mockResolvedValue(snapshot('0.00'));
});

describe('closureReview', () => {
  it('404s on an account that is not there', async () => {
    repository.findParties.mockResolvedValue(null);
    await expect(closureReview(USER)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('clears an account with nothing behind it', async () => {
    const review = await closureReview(USER);
    expect(review.blockers).toEqual([]);
    expect(review.summary.canClose).toBe(true);
    expect(review.summary.walletBalance).toBe('0.00');
  });

  it('adds up every wallet the account s profiles own', async () => {
    repository.findParties.mockResolvedValue(
      parties({ publisherId: 'pub_1', advertiserId: 'adv_1', agentProfileId: 'agt_1' }),
    );
    wallets.findWalletFor.mockImplementation(async (owner: { kind: string }) => ({
      id: `wal_${owner.kind}`,
    }));
    wallets.snapshot.mockImplementation(async (walletId: string) =>
      walletId === 'wal_PUBLISHER' ? snapshot('1200.00') : snapshot('50.50'),
    );

    const review = await closureReview(USER);
    expect(review.wallets).toHaveLength(3);
    expect(review.summary.walletBalance).toBe('1301.00');
    // Money in a wallet is reported, never a blocker: the closure pays it out.
    expect(blockingOf(review)).toEqual([]);
  });

  it('refuses while a withdrawal ADX already promised is in flight', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    wallets.findWalletFor.mockResolvedValue({ id: 'wal_1' });
    wallets.snapshot.mockResolvedValue(snapshot('900.00'));
    payouts.listWithdrawals.mockResolvedValue([
      { id: 'wdr_1', reference: 'WDR-2026-000118', status: 'APPROVED' },
    ]);

    const review = await closureReview(USER);
    expect(review.summary.canClose).toBe(false);
    expect(blockingOf(review).map((blocker) => blocker.kind)).toContain('WITHDRAWALS_IN_FLIGHT');
    expect(payouts.listWithdrawals).toHaveBeenCalledWith({
      walletId: 'wal_1',
      status: ['REQUESTED', 'APPROVED', 'PROCESSING'],
      limit: 200,
    });
  });

  it('counts an order once when the account is on both sides of it', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    listings.getListingsForPublisher.mockResolvedValue([{ id: 'lst_1' }]);
    orders.findOpenOrdersForListings.mockResolvedValue([{ id: 'ord_1' }]);
    orders.findOpenOrdersForAdvertiserUser.mockResolvedValue([{ id: 'ord_1' }, { id: 'ord_2' }]);

    const review = await closureReview(USER);
    expect(review.summary.openOrders).toBe(2);
    expect(blockingOf(review).map((blocker) => blocker.kind)).toContain('OPEN_ORDERS');
  });

  it('refuses while inventory is bought and running', async () => {
    repository.findParties.mockResolvedValue(parties({ advertiserId: 'adv_1' }));
    campaigns.listOpenCampaignsForAdvertiser.mockResolvedValue([
      { id: 'cmp_1', reference: 'CMP-2026-0007', status: 'LIVE' },
    ]);

    const review = await closureReview(USER);
    expect(blockingOf(review).map((blocker) => blocker.kind)).toEqual(['OPEN_CAMPAIGNS']);
  });

  it('reports agent work without refusing on it — STOP_OPEN_WORK hands it back', async () => {
    repository.findParties.mockResolvedValue(parties({ agentProfileId: 'agt_1' }));
    orders.countPendingAgentOffers.mockResolvedValue(2);
    visits.countOpenVisitsForAgent.mockResolvedValue(1);
    milestones.countDispatchedMilestones.mockResolvedValue(3);

    const review = await closureReview(USER);
    expect(review.summary.openWork).toBe(6);
    expect(review.summary.canClose).toBe(true);
    const work = review.blockers.find((blocker) => blocker.kind === 'OPEN_AGENT_WORK');
    expect(work).toMatchObject({ blocking: false, detail: { offers: 2, visits: 1, milestones: 3 } });
  });

  it('reports agreements and tickets without refusing on either', async () => {
    repository.findParties.mockResolvedValue(parties({ publisherId: 'pub_1' }));
    agreements.countAcceptancesFor.mockResolvedValue(4);
    support.countOpenTicketsForUser.mockResolvedValue(2);

    const review = await closureReview(USER);
    expect(review.summary.openAgreements).toBe(4);
    expect(review.summary.openTickets).toBe(2);
    expect(review.summary.canClose).toBe(true);
  });

  it('asks nothing of a side the account does not have', async () => {
    await closureReview(USER);
    expect(listings.getListingsForPublisher).not.toHaveBeenCalled();
    expect(campaigns.listOpenCampaignsForAdvertiser).not.toHaveBeenCalled();
    expect(orders.countPendingAgentOffers).not.toHaveBeenCalled();
  });
});
