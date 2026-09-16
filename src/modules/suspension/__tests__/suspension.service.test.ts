import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Modular suspension — Lot A (Q40/Q48/Q52).
 *
 * What is pinned here is the shape of the act: which scopes each party admits,
 * that suspending adds to what is already there and reinstating with no scopes
 * lifts everything, that every step writes a PartySuspensionEvent and an audit
 * row carrying the scope diff, that the party's person is told, and that the
 * three columns the table's CHECK ties together are always written as a set.
 *
 * The consequences of each scope — the cascade, the cancellations, the freeze,
 * the sign-in block — are pinned in scope-consequences.test.ts.
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
// E6: the history joins the actor's name through `users`.
vi.mock('../../users', () => ({
  findUserLabels: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, { id, name: id === 'usr_admin' ? 'Priya' : null }]))),
}));

import {
  isSuspended,
  reinstateParty,
  SCOPES_BY_PARTY,
  suspendParty,
  suspensionOf,
} from '../suspension.service';

const ADMIN = 'usr_admin';

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
  repository.createEvent.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'evt_1', ...input }));
  repository.listEvents.mockResolvedValue([]);
  audit.logActivity.mockResolvedValue(undefined);
  audit.findActivity.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 1, counts: {} });
  notifications.createNotification.mockResolvedValue({});
  orders.findOpenOrdersForListings.mockResolvedValue([]);
  orders.releaseAgentOffers.mockResolvedValue([]);
  visits.cancelAgentVisits.mockResolvedValue([]);
  milestones.releaseAgentMilestones.mockResolvedValue([]);
  campaigns.cancelSpotsForOrders.mockResolvedValue([]);
  campaigns.cancelAdvertiserCampaigns.mockResolvedValue([]);
  wallets.freezeWallet.mockResolvedValue({ id: 'wal_1' });
  wallets.unfreezeWallet.mockResolvedValue({ id: 'wal_1' });
});

describe('which scopes a party admits', () => {
  it('is the Lot A table: a listing takes the three about the spot, and never a wallet or a sign-in', () => {
    expect(SCOPES_BY_PARTY.LISTING).toEqual(['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL']);
    expect(SCOPES_BY_PARTY.PUBLISHER).toContain('FREEZE_WALLET');
    expect(SCOPES_BY_PARTY.PUBLISHER).toContain('STOP_ACCRUAL');
    // An advertiser earns nothing, so STOP_ACCRUAL would be a scope that did nothing.
    expect(SCOPES_BY_PARTY.ADVERTISER).not.toContain('STOP_ACCRUAL');
    expect(SCOPES_BY_PARTY.AGENT).not.toContain('STOP_ACCRUAL');
  });

  it('refuses a scope the party cannot carry, naming it and what is allowed', async () => {
    await expect(
      suspendParty('LISTING', 'lst_1', { scopes: ['FREEZE_WALLET'], reason: 'Fraud review', byUserId: ADMIN }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      details: { rejected: ['FREEZE_WALLET'] },
    });
    expect(repository.setScopes).not.toHaveBeenCalled();
  });

  it('refuses a suspension that names no section at all', async () => {
    await expect(
      suspendParty('LISTING', 'lst_1', { scopes: [], reason: 'Fraud review', byUserId: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('is 404 for a party that does not exist', async () => {
    repository.findParty.mockResolvedValue(null);
    await expect(
      suspendParty('AGENT', 'agt_nope', { scopes: ['BLOCK_NEW'], reason: 'Fraud review', byUserId: ADMIN }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('suspending', () => {
  it('adds to what is already there rather than replacing it, and keeps the original date and reason', async () => {
    const at = new Date('2026-09-01T00:00:00Z');
    repository.findParty.mockResolvedValue(
      party({ scopes: ['BLOCK_NEW'], suspendedAt: at, suspensionReason: 'First reason', suspendedById: 'usr_other', status: 'SUSPENDED' }),
    );

    await suspendParty('LISTING', 'lst_1', { scopes: ['STOP_ACCRUAL'], reason: 'Second reason', byUserId: ADMIN });

    expect(repository.setScopes).toHaveBeenCalledWith('LISTING', 'lst_1', {
      scopes: ['BLOCK_NEW', 'STOP_ACCRUAL'],
      suspendedAt: at,
      suspensionReason: 'First reason',
      suspendedById: 'usr_other',
    });
  });

  it('is idempotent: suspending a scope already present leaves the list as it was', async () => {
    repository.findParty.mockResolvedValue(
      party({ scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN, status: 'SUSPENDED' }),
    );
    await suspendParty('LISTING', 'lst_1', { scopes: ['BLOCK_NEW'], reason: 'Again', byUserId: ADMIN });
    expect(repository.setScopes.mock.calls[0]![2].scopes).toEqual(['BLOCK_NEW']);
  });

  it('writes one PartySuspensionEvent naming the scopes, the reason and who did it', async () => {
    await suspendParty('LISTING', 'lst_1', { scopes: ['BLOCK_NEW'], reason: 'Fraud review', byUserId: ADMIN });

    expect(repository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        partyType: 'LISTING',
        partyId: 'lst_1',
        action: 'SUSPEND',
        scopes: ['BLOCK_NEW'],
        reason: 'Fraud review',
        byUserId: ADMIN,
      }),
    );
  });

  it('audits the act against the record, with the scope diff', async () => {
    await suspendParty('PUBLISHER', 'pub_1', { scopes: ['FREEZE_WALLET'], reason: 'Fraud review', byUserId: ADMIN });

    expect(audit.logActivity).toHaveBeenCalledWith(
      ADMIN,
      'PUBLISHER_SUSPENDED',
      expect.objectContaining({
        targetType: 'Publisher',
        targetId: 'pub_1',
        module: 'suspension',
        diff: { suspensionScopes: { before: [], after: ['FREEZE_WALLET'] } },
      }),
    );
  });

  it('tells the party, through a SYSTEM notification carrying the reason', async () => {
    await suspendParty('PUBLISHER', 'pub_1', { scopes: ['BLOCK_NEW'], reason: 'Fraud review', byUserId: ADMIN });

    expect(notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_pub', type: 'SYSTEM', message: expect.stringContaining('Fraud review') }),
    );
  });

  it('says nothing to nobody: a party with no user is still suspended', async () => {
    repository.findParty.mockResolvedValue(party({ userId: null }));
    await expect(
      suspendParty('LISTING', 'lst_1', { scopes: ['BLOCK_NEW'], reason: 'Fraud review', byUserId: ADMIN }),
    ).resolves.toBeTruthy();
    expect(notifications.createNotification).not.toHaveBeenCalled();
  });
});

describe('reinstating', () => {
  it('with no scopes lifts everything, and clears the three columns the CHECK ties together', async () => {
    repository.findParty.mockResolvedValue(
      party({ scopes: ['BLOCK_NEW', 'STOP_ACCRUAL'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN, status: 'SUSPENDED' }),
    );

    const result = await reinstateParty('LISTING', 'lst_1', { reason: 'Cleared', byUserId: ADMIN });

    expect(result.lifted).toEqual(['BLOCK_NEW', 'STOP_ACCRUAL']);
    expect(repository.setScopes).toHaveBeenCalledWith('LISTING', 'lst_1', {
      scopes: [],
      suspendedAt: null,
      suspensionReason: null,
      suspendedById: null,
    });
  });

  it('with scopes lifts only those, and keeps the reason and date on what is left', async () => {
    const at = new Date('2026-09-01T00:00:00Z');
    repository.findParty.mockResolvedValue(
      party({ scopes: ['BLOCK_NEW', 'STOP_ACCRUAL'], suspendedAt: at, suspensionReason: 'r', suspendedById: ADMIN, status: 'SUSPENDED' }),
    );

    const result = await reinstateParty('LISTING', 'lst_1', { scopes: ['STOP_ACCRUAL'], reason: 'Partly cleared', byUserId: ADMIN });

    expect(result.lifted).toEqual(['STOP_ACCRUAL']);
    expect(repository.setScopes).toHaveBeenCalledWith('LISTING', 'lst_1', {
      scopes: ['BLOCK_NEW'],
      suspendedAt: at,
      suspensionReason: 'r',
      suspendedById: ADMIN,
    });
  });

  it('lifts nothing it was not carrying, and still records the act', async () => {
    repository.findParty.mockResolvedValue(party({ scopes: [] }));
    const result = await reinstateParty('LISTING', 'lst_1', { scopes: ['BLOCK_NEW'], reason: 'Cleared', byUserId: ADMIN });
    expect(result.lifted).toEqual([]);
    expect(repository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'REINSTATE', scopes: [] }),
    );
  });

  it('audits the reversal against the same record', async () => {
    repository.findParty.mockResolvedValue(
      party({ scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'r', suspendedById: ADMIN, status: 'SUSPENDED' }),
    );
    await reinstateParty('AGENT', 'agt_1', { reason: 'Cleared', byUserId: ADMIN });
    expect(audit.logActivity).toHaveBeenCalledWith(
      ADMIN,
      'AGENT_REINSTATED',
      expect.objectContaining({ targetType: 'AgentProfile', targetId: 'agt_1' }),
    );
  });
});

describe('reading one party', () => {
  it('answers the current scopes, what the party admits, and the history', async () => {
    repository.findParty.mockResolvedValue(party({ scopes: ['BLOCK_NEW'] }));
    repository.listEvents.mockResolvedValue([{ id: 'evt_1', action: 'SUSPEND', byUserId: 'usr_admin' }]);

    const view = await suspensionOf('LISTING', 'lst_1');

    expect(view).toMatchObject({
      partyType: 'LISTING',
      partyId: 'lst_1',
      scopes: ['BLOCK_NEW'],
      admits: ['BLOCK_NEW', 'STOP_OPEN_WORK', 'STOP_ACCRUAL'],
    });
    expect(view.events).toHaveLength(1);
    // E6: the actor joined by name.
    expect(view.events[0]).toMatchObject({ byUserId: 'usr_admin', byUser: { id: 'usr_admin', name: 'Priya' } });
  });

  it('isSuspended is the narrow yes-or-no, false for a party that is not there', async () => {
    repository.findParty.mockResolvedValue(party({ scopes: ['STOP_ACCRUAL'] }));
    await expect(isSuspended('LISTING', 'lst_1', 'STOP_ACCRUAL')).resolves.toBe(true);
    await expect(isSuspended('LISTING', 'lst_1', 'BLOCK_NEW')).resolves.toBe(false);

    repository.findParty.mockResolvedValue(null);
    await expect(isSuspended('LISTING', 'lst_gone', 'BLOCK_NEW')).resolves.toBe(false);
  });
});
