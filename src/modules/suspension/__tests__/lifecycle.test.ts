import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026) — what a suspension now also does, and the
 * user deactivation that rides on it:
 *
 *  - BLOCK_NEW / BLOCK_SIGNIN close the doors: an agent's own live grants, or
 *    the grants ON a publisher's or advertiser's account, are revoked and the
 *    party's QR codes deactivated;
 *  - STOP_OPEN_WORK on an agent hands their open leads back to the pool;
 *  - lifting BLOCK_SIGNIN on a closed account is refused, 409 ACCOUNT_CLOSED;
 *  - a user Deactivate suspends each profile with BLOCK_NEW (cause on the
 *    event), and Reactivate lifts exactly that — never a block ops placed.
 */

const { repository, audit, auth, grants, qr, leads, prisma, orders, visits, milestones } = vi.hoisted(() => ({
  repository: {
    findParty: vi.fn(),
    setScopes: vi.fn(),
    setListingStatus: vi.fn(),
    setAgentStatus: vi.fn(),
    setUserActive: vi.fn(),
    listingsForPublisher: vi.fn(),
    createEvent: vi.fn(),
    listEvents: vi.fn(),
    partiesOfUser: vi.fn(),
  },
  audit: { logActivity: vi.fn(), findActivity: vi.fn() },
  auth: { revokeSessions: vi.fn() },
  grants: { revokeLiveGrantsForAgent: vi.fn(), revokeLiveGrantsOnParty: vi.fn() },
  qr: { deactivateQrsFor: vi.fn() },
  leads: { releaseLeadsHeldBy: vi.fn() },
  prisma: { user: { findUnique: vi.fn() } },
  orders: { cancelOrder: vi.fn(), findOpenOrdersForListings: vi.fn(async () => []), releaseAgentOffers: vi.fn(async () => []) },
  visits: { cancelAgentVisits: vi.fn(async () => []) },
  milestones: { releaseAgentMilestones: vi.fn(async () => []) },
}));

vi.mock('../prisma-suspension.repository', () => ({ prismaSuspensionRepository: repository }));
vi.mock('../../../shared/audit', () => audit);
vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
vi.mock('../../advertisers', () => ({ requestRefund: vi.fn() }));
vi.mock('../../auth', () => auth);
vi.mock('../../campaigns', () => ({ cancelSpotsForOrders: vi.fn(async () => []), cancelAdvertiserCampaigns: vi.fn(async () => []) }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(async () => ({})) }));
vi.mock('../../orders', () => orders);
vi.mock('../../order-milestones', () => milestones);
vi.mock('../../visits', () => visits);
vi.mock('../../wallets', () => ({ freezeWallet: vi.fn(), unfreezeWallet: vi.fn() }));
vi.mock('../../users', () => ({ findUserLabels: vi.fn(async () => new Map()) }));
vi.mock('../../access-grants', () => grants);
vi.mock('../../qr', () => qr);
vi.mock('../../leads', () => leads);

import { reinstateAfterUserReactivation, reinstateParty, suspendForUserDeactivation, suspendParty } from '../suspension.service';

const ADMIN = 'usr_admin';
const party = (over: Record<string, unknown> = {}) => ({
  id: 'pty_1',
  scopes: [],
  suspendedAt: null,
  suspensionReason: null,
  suspendedById: null,
  userId: 'usr_1',
  status: 'ACTIVE',
  publisherId: null,
  publishedAt: null,
  verificationExpiresAt: null,
  name: 'Party',
  ...over,
});
const suspended = (scopes: string[]) => party({ scopes, suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN });

beforeEach(() => {
  vi.clearAllMocks();
  repository.findParty.mockImplementation(async (_type: string, id: string) => party({ id }));
  repository.listingsForPublisher.mockResolvedValue([]);
  repository.createEvent.mockResolvedValue({ id: 'evt_1' });
  repository.listEvents.mockResolvedValue([]);
  repository.partiesOfUser.mockResolvedValue([]);
  audit.findActivity.mockResolvedValue({ items: [] });
  grants.revokeLiveGrantsForAgent.mockResolvedValue(2);
  grants.revokeLiveGrantsOnParty.mockResolvedValue(1);
  qr.deactivateQrsFor.mockResolvedValue(undefined);
  leads.releaseLeadsHeldBy.mockResolvedValue(['led_1']);
  prisma.user.findUnique.mockResolvedValue({ isActive: false, closedAt: null });
});

describe('BLOCK_NEW and BLOCK_SIGNIN close the doors', () => {
  it('an agent: their own live grants revoked, their QR codes deactivated', async () => {
    const { effects } = await suspendParty('AGENT', 'agt_1', { scopes: ['BLOCK_NEW'], reason: 'Review', byUserId: ADMIN });
    expect(grants.revokeLiveGrantsForAgent).toHaveBeenCalledWith('agt_1', ADMIN);
    expect(qr.deactivateQrsFor).toHaveBeenCalledWith('AGENT', 'agt_1');
    expect(effects).toMatchObject({ grantsRevoked: 2, qrDeactivated: true });
  });

  it('a publisher or an advertiser: the grants ON their account, and their codes', async () => {
    await suspendParty('PUBLISHER', 'pub_1', { scopes: ['BLOCK_SIGNIN'], reason: 'Review', byUserId: ADMIN });
    expect(grants.revokeLiveGrantsOnParty).toHaveBeenCalledWith({ publisherId: 'pub_1' }, ADMIN);
    expect(qr.deactivateQrsFor).toHaveBeenCalledWith('PUBLISHER', 'pub_1');
    await suspendParty('ADVERTISER', 'adv_1', { scopes: ['BLOCK_NEW'], reason: 'Review', byUserId: ADMIN });
    expect(grants.revokeLiveGrantsOnParty).toHaveBeenCalledWith({ advertiserId: 'adv_1' }, ADMIN);
    expect(qr.deactivateQrsFor).toHaveBeenCalledWith('ADVERTISER', 'adv_1');
  });

  it('a frozen wallet alone leaves the doors as they are; a listing has none', async () => {
    await suspendParty('PUBLISHER', 'pub_1', { scopes: ['FREEZE_WALLET'], reason: 'Review', byUserId: ADMIN });
    await suspendParty('LISTING', 'lst_1', { scopes: ['BLOCK_NEW'], reason: 'Review', byUserId: ADMIN });
    expect(grants.revokeLiveGrantsOnParty).not.toHaveBeenCalled();
    expect(qr.deactivateQrsFor).not.toHaveBeenCalled();
  });

  it('a door that will not close is logged, and the suspension still stands', async () => {
    grants.revokeLiveGrantsForAgent.mockRejectedValue(new Error('db down'));
    qr.deactivateQrsFor.mockRejectedValue(new Error('db down'));
    const result = await suspendParty('AGENT', 'agt_1', { scopes: ['BLOCK_NEW'], reason: 'Review', byUserId: ADMIN });
    expect(result.effects).toMatchObject({ grantsRevoked: 0, qrDeactivated: false });
    expect(repository.setScopes).toHaveBeenCalled();
  });
});

describe('STOP_OPEN_WORK on an agent', () => {
  it('hands their open leads back to the pool beside the offers, visits and milestones', async () => {
    const { effects } = await suspendParty('AGENT', 'agt_1', { scopes: ['STOP_OPEN_WORK'], reason: 'Review', byUserId: ADMIN });
    expect(leads.releaseLeadsHeldBy).toHaveBeenCalledWith('agt_1', 'Agent suspended: Review', expect.any(Date));
    expect(effects.releasedLeadIds).toEqual(['led_1']);
  });
});

describe('a closed account stays closed', () => {
  it('lifting BLOCK_SIGNIN is refused 409 ACCOUNT_CLOSED before anything is written', async () => {
    repository.findParty.mockResolvedValue(suspended(['BLOCK_NEW', 'BLOCK_SIGNIN']));
    prisma.user.findUnique.mockResolvedValue({ isActive: false, closedAt: new Date() });
    await expect(reinstateParty('PUBLISHER', 'pub_1', { reason: 'Mistake', byUserId: ADMIN })).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_CLOSED' });
    await expect(reinstateParty('PUBLISHER', 'pub_1', { scopes: ['BLOCK_SIGNIN'], reason: 'Mistake', byUserId: ADMIN })).rejects.toMatchObject({ code: 'ACCOUNT_CLOSED' });
    expect(repository.setScopes).not.toHaveBeenCalled();
    expect(repository.setUserActive).not.toHaveBeenCalled();
  });

  it('a scope that is not sign-in may still be lifted by name', async () => {
    repository.findParty.mockResolvedValue(suspended(['FREEZE_WALLET', 'BLOCK_SIGNIN']));
    prisma.user.findUnique.mockResolvedValue({ isActive: false, closedAt: new Date() });
    await reinstateParty('PUBLISHER', 'pub_1', { scopes: ['FREEZE_WALLET'], reason: 'Paid out', byUserId: ADMIN });
    expect(repository.setScopes).toHaveBeenCalled();
  });

  it('an open account lifts BLOCK_SIGNIN as before', async () => {
    repository.findParty.mockResolvedValue(suspended(['BLOCK_SIGNIN']));
    await reinstateParty('ADVERTISER', 'adv_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(repository.setUserActive).toHaveBeenCalledWith('usr_1', true);
  });
});

describe('a user Deactivate and its Reactivate', () => {
  beforeEach(() => {
    repository.partiesOfUser.mockResolvedValue([
      { partyType: 'PUBLISHER', partyId: 'pub_1' },
      { partyType: 'AGENT', partyId: 'agt_1' },
    ]);
  });

  it('suspends each profile with BLOCK_NEW, the cause on the event; one already blocked is left alone', async () => {
    repository.findParty.mockImplementation(async (type: string) => (type === 'AGENT' ? suspended(['BLOCK_NEW']) : party()));
    const done = await suspendForUserDeactivation('usr_1', ADMIN);
    expect(done).toEqual([{ partyType: 'PUBLISHER', partyId: 'pub_1' }]);
    expect(repository.createEvent).toHaveBeenCalledWith(expect.objectContaining({ partyType: 'PUBLISHER', action: 'SUSPEND', scopes: ['BLOCK_NEW'], metadata: { cause: 'USER_DEACTIVATED', added: ['BLOCK_NEW'] } }));
    expect(repository.createEvent).not.toHaveBeenCalledWith(expect.objectContaining({ partyType: 'AGENT' }));
  });

  it('Reactivate lifts BLOCK_NEW where the newest BLOCK_NEW step is the deactivation’s own', async () => {
    repository.findParty.mockResolvedValue(suspended(['BLOCK_NEW']));
    repository.listEvents.mockImplementation(async (type: string) =>
      type === 'PUBLISHER'
        ? [{ action: 'SUSPEND', scopes: ['BLOCK_NEW'], metadata: { cause: 'USER_DEACTIVATED' } }]
        : // The agent's block was placed by ops before the deactivation — theirs, and it stays.
          [{ action: 'SUSPEND', scopes: ['BLOCK_NEW', 'STOP_OPEN_WORK'], metadata: null }],
    );
    const done = await reinstateAfterUserReactivation('usr_1', ADMIN);
    expect(done).toEqual([{ partyType: 'PUBLISHER', partyId: 'pub_1' }]);
    expect(repository.createEvent).toHaveBeenCalledWith(expect.objectContaining({ partyType: 'PUBLISHER', action: 'REINSTATE', scopes: ['BLOCK_NEW'], metadata: { cause: 'USER_REACTIVATED' } }));
  });

  it('a block ops placed after the deactivation stays; one already lifted is not lifted twice', async () => {
    repository.findParty.mockResolvedValue(suspended(['BLOCK_NEW']));
    repository.listEvents.mockImplementation(async (type: string) =>
      type === 'PUBLISHER'
        ? [
            { action: 'SUSPEND', scopes: ['BLOCK_NEW'], metadata: null },
            { action: 'SUSPEND', scopes: ['BLOCK_NEW'], metadata: { cause: 'USER_DEACTIVATED' } },
          ]
        : [
            { action: 'REINSTATE', scopes: ['BLOCK_NEW'], metadata: null },
            { action: 'SUSPEND', scopes: ['BLOCK_NEW'], metadata: { cause: 'USER_DEACTIVATED' } },
          ],
    );
    expect(await reinstateAfterUserReactivation('usr_1', ADMIN)).toEqual([]);
    expect(repository.setScopes).not.toHaveBeenCalled();
  });
});
