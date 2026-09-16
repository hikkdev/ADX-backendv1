import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What each scope actually does — Lot A (Q40/Q48/Q52).
 *
 * The suspension is only worth the consequences it has, so each one is pinned
 * here against the module it reaches into: the listing status and the
 * publisher cascade, the orders that stop and the ONE refund request per
 * campaign that follows, the agent's work handed back, the wallet frozen, the
 * sign-in blocked. And the two restores that are not symmetrical: a listing
 * comes back ACTIVE only if it can, and an agent who was ON_LEAVE comes back
 * ON_LEAVE.
 */

const {
  repository,
  audit,
  advertisers,
  auth,
  campaigns,
  notifications,
  orders,
  milestones,
  visits,
  wallets,
} = vi.hoisted(() => ({
  repository: {
    findParty: vi.fn(),
    setScopes: vi.fn(),
    setListingStatus: vi.fn(),
    setAgentStatus: vi.fn(),
    setUserActive: vi.fn(),
    listingsForPublisher: vi.fn(),
    createEvent: vi.fn(),
    listEvents: vi.fn(),
  },
  audit: { logActivity: vi.fn(), findActivity: vi.fn() },
  advertisers: { requestRefund: vi.fn() },
  auth: { revokeSessions: vi.fn() },
  campaigns: { cancelSpotsForOrders: vi.fn(), cancelAdvertiserCampaigns: vi.fn() },
  notifications: { createNotification: vi.fn() },
  orders: { cancelOrder: vi.fn(), findOpenOrdersForListings: vi.fn(), releaseAgentOffers: vi.fn() },
  milestones: { releaseAgentMilestones: vi.fn() },
  visits: { cancelAgentVisits: vi.fn() },
  wallets: { freezeWallet: vi.fn(), unfreezeWallet: vi.fn() },
}));

vi.mock('../prisma-suspension.repository', () => ({ prismaSuspensionRepository: repository }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../auth', () => auth);
vi.mock('../../campaigns', () => campaigns);
vi.mock('../../notifications', () => notifications);
vi.mock('../../orders', () => orders);
vi.mock('../../order-milestones', () => milestones);
vi.mock('../../visits', () => visits);
vi.mock('../../wallets', () => wallets);
vi.mock('../../users', () => ({ findUserLabels: vi.fn(async () => new Map()) }));

import { reinstateParty, suspendParty } from '../suspension.service';

const ADMIN = 'usr_admin';
const REASON = 'Fraud review';

const party = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  scopes: [],
  suspendedAt: null,
  suspensionReason: null,
  suspendedById: null,
  userId: 'usr_pub',
  status: 'ACTIVE',
  publisherId: 'pub_1',
  publishedAt: new Date('2026-01-01T00:00:00Z'),
  verificationExpiresAt: new Date('2027-01-01T00:00:00Z'),
  name: 'Lift lobby panel',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findParty.mockResolvedValue(party());
  repository.setScopes.mockResolvedValue(undefined);
  repository.listingsForPublisher.mockResolvedValue([]);
  repository.createEvent.mockResolvedValue({ id: 'evt_1' });
  repository.listEvents.mockResolvedValue([]);
  audit.logActivity.mockResolvedValue(undefined);
  audit.findActivity.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 1, counts: {} });
  notifications.createNotification.mockResolvedValue({});
  orders.findOpenOrdersForListings.mockResolvedValue([]);
  orders.cancelOrder.mockResolvedValue({});
  orders.releaseAgentOffers.mockResolvedValue([]);
  visits.cancelAgentVisits.mockResolvedValue([]);
  milestones.releaseAgentMilestones.mockResolvedValue([]);
  campaigns.cancelSpotsForOrders.mockResolvedValue([]);
  campaigns.cancelAdvertiserCampaigns.mockResolvedValue([]);
  advertisers.requestRefund.mockResolvedValue({ id: 'ref_1' });
  wallets.freezeWallet.mockResolvedValue({ id: 'wal_1' });
  wallets.unfreezeWallet.mockResolvedValue({ id: 'wal_1' });
});

describe('BLOCK_NEW on a listing', () => {
  it('takes the spot off the market by setting it SUSPENDED', async () => {
    await suspendParty('LISTING', 'lst_1', { scopes: ['BLOCK_NEW'], reason: REASON, byUserId: ADMIN });
    expect(repository.setListingStatus).toHaveBeenCalledWith('lst_1', 'SUSPENDED');
  });

  it('does not rewrite a status that is already SUSPENDED, so the prior status is recorded once', async () => {
    repository.findParty.mockResolvedValue(party({ status: 'SUSPENDED', scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN }));
    await suspendParty('LISTING', 'lst_1', { scopes: ['BLOCK_NEW'], reason: REASON, byUserId: ADMIN });
    expect(repository.setListingStatus).not.toHaveBeenCalled();
  });

  it('comes back ACTIVE when the spot was published and its verification is current', async () => {
    repository.findParty.mockResolvedValue(party({ status: 'SUSPENDED', scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN }));
    await reinstateParty('LISTING', 'lst_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(repository.setListingStatus).toHaveBeenCalledWith('lst_1', 'ACTIVE');
  });

  it('stays SUSPENDED when the verification lapsed while it was suspended', async () => {
    repository.findParty.mockResolvedValue(
      party({
        status: 'SUSPENDED',
        scopes: ['BLOCK_NEW'],
        suspendedAt: new Date(),
        suspensionReason: 'r',
        suspendedById: ADMIN,
        verificationExpiresAt: new Date('2020-01-01T00:00:00Z'),
      }),
    );
    await reinstateParty('LISTING', 'lst_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(repository.setListingStatus).not.toHaveBeenCalled();
  });

  it('stays SUSPENDED when the spot was never published', async () => {
    repository.findParty.mockResolvedValue(
      party({ status: 'SUSPENDED', scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN, publishedAt: null }),
    );
    await reinstateParty('LISTING', 'lst_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(repository.setListingStatus).not.toHaveBeenCalled();
  });
});

describe('BLOCK_NEW on a publisher', () => {
  it('cascades onto every listing, each with its own event marked as a cascade', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'pub_1', status: null, publisherId: null }));
    repository.listingsForPublisher.mockResolvedValue([
      { id: 'lst_1', title: 'A', status: 'ACTIVE', scopes: [] },
      { id: 'lst_2', title: 'B', status: 'SUSPENDED', scopes: ['BLOCK_NEW'] },
    ]);

    const result = await suspendParty('PUBLISHER', 'pub_1', { scopes: ['BLOCK_NEW'], reason: REASON, byUserId: ADMIN });

    // lst_2 already carries it — nothing to add, so nothing is written for it.
    expect(result.effects.cascadedListingIds).toEqual(['lst_1']);
    expect(repository.setScopes).toHaveBeenCalledWith('LISTING', 'lst_1', expect.objectContaining({ scopes: ['BLOCK_NEW'] }));
    expect(repository.setListingStatus).toHaveBeenCalledWith('lst_1', 'SUSPENDED');
    expect(repository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ partyType: 'LISTING', partyId: 'lst_1', reason: expect.stringContaining('Cascade') }),
    );
  });

  it('cascades STOP_ACCRUAL too, so the accrual run only ever has to read a listing', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'pub_1', status: null }));
    repository.listingsForPublisher.mockResolvedValue([{ id: 'lst_1', title: 'A', status: 'ACTIVE', scopes: [] }]);

    await suspendParty('PUBLISHER', 'pub_1', { scopes: ['STOP_ACCRUAL'], reason: REASON, byUserId: ADMIN });

    expect(repository.setScopes).toHaveBeenCalledWith('LISTING', 'lst_1', expect.objectContaining({ scopes: ['STOP_ACCRUAL'] }));
    // Not a booking block, so the spot stays on the market.
    expect(repository.setListingStatus).not.toHaveBeenCalled();
  });

  it('lifts the cascade again on reinstatement', async () => {
    repository.findParty
      .mockResolvedValueOnce(party({ id: 'pub_1', status: null, scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN }))
      .mockResolvedValue(party({ id: 'lst_1', status: 'SUSPENDED', scopes: [] }));
    repository.listingsForPublisher.mockResolvedValue([{ id: 'lst_1', title: 'A', status: 'SUSPENDED', scopes: ['BLOCK_NEW'] }]);

    await reinstateParty('PUBLISHER', 'pub_1', { reason: 'Cleared', byUserId: ADMIN });

    expect(repository.setScopes).toHaveBeenCalledWith('LISTING', 'lst_1', expect.objectContaining({ scopes: [] }));
    expect(repository.setListingStatus).toHaveBeenCalledWith('lst_1', 'ACTIVE');
  });
});

describe('STOP_OPEN_WORK on a listing', () => {
  it('cancels every open order through the order lane and raises ONE refund request per campaign', async () => {
    orders.findOpenOrdersForListings.mockResolvedValue([
      { id: 'ord_1', listingId: 'lst_1', advertiserId: 'adv_1', status: 'IN_PROGRESS' },
      { id: 'ord_2', listingId: 'lst_1', advertiserId: 'adv_1', status: 'PENDING_AGENT' },
    ]);
    campaigns.cancelSpotsForOrders.mockResolvedValue([
      { campaignId: 'cmp_1', reference: 'CMP-1', advertiserId: 'adv_1', amount: '4500.00', spotIds: ['spt_1', 'spt_2'], refundNeeded: true },
    ]);

    const result = await suspendParty('LISTING', 'lst_1', { scopes: ['STOP_OPEN_WORK'], reason: REASON, byUserId: ADMIN });

    expect(orders.cancelOrder).toHaveBeenCalledTimes(2);
    expect(orders.cancelOrder).toHaveBeenCalledWith('ord_1', expect.stringContaining(REASON));
    expect(campaigns.cancelSpotsForOrders).toHaveBeenCalledWith(['ord_1', 'ord_2']);
    expect(advertisers.requestRefund).toHaveBeenCalledTimes(1);
    expect(advertisers.requestRefund).toHaveBeenCalledWith(
      'adv_1',
      expect.objectContaining({ amount: '4500.00', reason: 'PUBLISHER_WITHDREW' }),
      ADMIN,
    );
    expect(result.effects.refunds).toEqual([{ campaignId: 'cmp_1', amount: '4500.00', requested: true }]);
  });

  it('asks for nothing when the money was only held — the cancel releases it', async () => {
    orders.findOpenOrdersForListings.mockResolvedValue([{ id: 'ord_1', listingId: 'lst_1', advertiserId: 'adv_1', status: 'PENDING_AGENT' }]);
    campaigns.cancelSpotsForOrders.mockResolvedValue([
      { campaignId: 'cmp_1', reference: 'CMP-1', advertiserId: 'adv_1', amount: '4500.00', spotIds: ['spt_1'], refundNeeded: false },
    ]);

    const result = await suspendParty('LISTING', 'lst_1', { scopes: ['STOP_OPEN_WORK'], reason: REASON, byUserId: ADMIN });

    expect(advertisers.requestRefund).not.toHaveBeenCalled();
    expect(result.effects.refunds[0]).toMatchObject({ requested: false, note: expect.stringContaining('released') });
  });

  it('records a refund the desk refused rather than swallowing it', async () => {
    orders.findOpenOrdersForListings.mockResolvedValue([{ id: 'ord_1', listingId: 'lst_1', advertiserId: 'adv_1', status: 'LIVE' }]);
    campaigns.cancelSpotsForOrders.mockResolvedValue([
      { campaignId: 'cmp_1', reference: 'CMP-1', advertiserId: 'adv_1', amount: '4500.00', spotIds: ['spt_1'], refundNeeded: true },
    ]);
    advertisers.requestRefund.mockRejectedValue(new Error('This wallet already has a refund request open'));

    const result = await suspendParty('LISTING', 'lst_1', { scopes: ['STOP_OPEN_WORK'], reason: REASON, byUserId: ADMIN });

    expect(result.effects.refunds[0]).toMatchObject({ requested: false });
    // The suspension itself stands: the work stopped whether or not the money moved.
    expect(result.scopes).toEqual([]);
    expect(repository.setScopes).toHaveBeenCalledWith('LISTING', 'lst_1', expect.objectContaining({ scopes: ['STOP_OPEN_WORK'] }));
  });
});

describe('STOP_OPEN_WORK on an advertiser', () => {
  it('cancels their scheduled and live campaigns and asks for the unused days back', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'adv_1', status: null, publisherId: null, userId: 'usr_adv' }));
    campaigns.cancelAdvertiserCampaigns.mockResolvedValue([
      { campaignId: 'cmp_1', reference: 'CMP-1', advertiserId: 'adv_1', amount: '1200.00', spotIds: ['spt_1'], refundNeeded: true },
    ]);

    const result = await suspendParty('ADVERTISER', 'adv_1', { scopes: ['STOP_OPEN_WORK'], reason: REASON, byUserId: ADMIN });

    expect(campaigns.cancelAdvertiserCampaigns).toHaveBeenCalledWith('adv_1', expect.stringContaining(REASON));
    expect(result.effects.cancelledCampaignIds).toEqual(['cmp_1']);
    expect(advertisers.requestRefund).toHaveBeenCalledWith(
      'adv_1',
      expect.objectContaining({ amount: '1200.00', reason: 'OTHER' }),
      ADMIN,
    );
  });
});

describe('an agent', () => {
  const agent = (over: Record<string, unknown> = {}) =>
    party({ id: 'agt_1', status: 'ACTIVE', publisherId: null, publishedAt: null, verificationExpiresAt: null, userId: 'usr_agt', ...over });

  it('BLOCK_NEW sets the profile SUSPENDED, which is what every dispatch point reads', async () => {
    repository.findParty.mockResolvedValue(agent());
    await suspendParty('AGENT', 'agt_1', { scopes: ['BLOCK_NEW'], reason: REASON, byUserId: ADMIN });
    expect(repository.setAgentStatus).toHaveBeenCalledWith('agt_1', 'SUSPENDED');
  });

  it('STOP_OPEN_WORK hands back the offers, the visits and the milestones', async () => {
    repository.findParty.mockResolvedValue(agent());
    orders.releaseAgentOffers.mockResolvedValue(['ord_1']);
    visits.cancelAgentVisits.mockResolvedValue(['vst_1', 'vst_2']);
    milestones.releaseAgentMilestones.mockResolvedValue(['ms_1']);

    const result = await suspendParty('AGENT', 'agt_1', { scopes: ['STOP_OPEN_WORK'], reason: REASON, byUserId: ADMIN });

    expect(orders.releaseAgentOffers).toHaveBeenCalledWith('agt_1', 'SUSPENDED');
    expect(visits.cancelAgentVisits).toHaveBeenCalledWith('agt_1', 'SUSPENDED');
    expect(milestones.releaseAgentMilestones).toHaveBeenCalledWith('agt_1', 'SUSPENDED');
    expect(result.effects).toMatchObject({
      releasedOrderIds: ['ord_1'],
      cancelledVisitIds: ['vst_1', 'vst_2'],
      releasedMilestoneIds: ['ms_1'],
    });
  });

  it('records the status they had, so reinstating an agent who was ON_LEAVE puts them back ON_LEAVE', async () => {
    repository.findParty.mockResolvedValue(agent({ status: 'ON_LEAVE' }));
    await suspendParty('AGENT', 'agt_1', { scopes: ['BLOCK_NEW'], reason: REASON, byUserId: ADMIN });
    expect(audit.logActivity).toHaveBeenCalledWith(
      ADMIN,
      'AGENT_SUSPENDED',
      expect.objectContaining({ metadata: expect.objectContaining({ priorStatus: 'ON_LEAVE' }) }),
    );

    vi.clearAllMocks();
    repository.findParty.mockResolvedValue(agent({ status: 'SUSPENDED', scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN }));
    repository.listEvents.mockResolvedValue([]);
    audit.findActivity.mockResolvedValue({
      items: [{ metadata: { priorStatus: 'ON_LEAVE' } }],
      total: 1,
      page: 1,
      pageSize: 1,
      counts: {},
    });

    await reinstateParty('AGENT', 'agt_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(repository.setAgentStatus).toHaveBeenCalledWith('agt_1', 'ON_LEAVE');
  });

  it('comes back ACTIVE when nothing says they were away', async () => {
    repository.findParty.mockResolvedValue(agent({ status: 'SUSPENDED', scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN }));
    await reinstateParty('AGENT', 'agt_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(repository.setAgentStatus).toHaveBeenCalledWith('agt_1', 'ACTIVE');
  });
});

describe('FREEZE_WALLET', () => {
  it('freezes the party’s own wallet, with the reason and the admin on it', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'pub_1', status: null }));
    const result = await suspendParty('PUBLISHER', 'pub_1', { scopes: ['FREEZE_WALLET'], reason: REASON, byUserId: ADMIN });

    expect(wallets.freezeWallet).toHaveBeenCalledWith(
      { kind: 'PUBLISHER', id: 'pub_1' },
      expect.objectContaining({ reason: REASON, byUserId: ADMIN }),
    );
    expect(result.effects.walletFrozen).toBe(true);
  });

  it('is not an error for a party who never opened one', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'agt_1', status: 'ACTIVE' }));
    wallets.freezeWallet.mockResolvedValue(null);
    const result = await suspendParty('AGENT', 'agt_1', { scopes: ['FREEZE_WALLET'], reason: REASON, byUserId: ADMIN });
    expect(result.effects.walletFrozen).toBe(false);
  });

  it('thaws it again on reinstatement', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'adv_1', status: null, scopes: ['FREEZE_WALLET'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN }));
    await reinstateParty('ADVERTISER', 'adv_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(wallets.unfreezeWallet).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_1' });
  });
});

describe('BLOCK_SIGNIN', () => {
  it('deactivates the account and ends the sessions behind it', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'pub_1', status: null, userId: 'usr_pub' }));
    const result = await suspendParty('PUBLISHER', 'pub_1', { scopes: ['BLOCK_SIGNIN'], reason: REASON, byUserId: ADMIN });

    expect(repository.setUserActive).toHaveBeenCalledWith('usr_pub', false);
    expect(auth.revokeSessions).toHaveBeenCalledWith('usr_pub', 'SUSPENDED');
    expect(result.effects.signinBlocked).toBe(true);
  });

  it('lets them back in on reinstatement', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'pub_1', status: null, scopes: ['BLOCK_SIGNIN'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN }));
    await reinstateParty('PUBLISHER', 'pub_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(repository.setUserActive).toHaveBeenCalledWith('usr_pub', true);
  });

  it('does nothing for a party with no account behind it', async () => {
    repository.findParty.mockResolvedValue(party({ id: 'pub_1', status: null, userId: null }));
    const result = await suspendParty('PUBLISHER', 'pub_1', { scopes: ['BLOCK_SIGNIN'], reason: REASON, byUserId: ADMIN });
    expect(repository.setUserActive).not.toHaveBeenCalled();
    expect(result.effects.signinBlocked).toBe(false);
  });
});
