import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1: `GET /suspension/:partyType/:partyId` names who suspended the
 * party — `suspendedBy { id, name } | null` beside `suspendedById` on the
 * current case, through the same `users.findUserLabels` call that names the
 * history's actors. Null when nobody has: a party in good standing has no
 * suspender.
 */

const { repository, users } = vi.hoisted(() => ({
  repository: { findParty: vi.fn(), listEvents: vi.fn() },
  users: {
    findUserLabels: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, { id, name: id === 'usr_admin' ? 'Priya' : null }]))),
  },
}));

vi.mock('../prisma-suspension.repository', () => ({ prismaSuspensionRepository: repository }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(), findActivity: vi.fn() }));
vi.mock('../../advertisers', () => ({ requestRefund: vi.fn() }));
vi.mock('../../auth', () => ({ revokeSessions: vi.fn() }));
vi.mock('../../campaigns', () => ({ cancelSpotsForOrders: vi.fn(), cancelAdvertiserCampaigns: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../orders', () => ({ cancelOrder: vi.fn(), findOpenOrdersForListings: vi.fn(), releaseAgentOffers: vi.fn() }));
vi.mock('../../order-milestones', () => ({ releaseAgentMilestones: vi.fn() }));
vi.mock('../../visits', () => ({ cancelAgentVisits: vi.fn() }));
vi.mock('../../wallets', () => ({ freezeWallet: vi.fn(), unfreezeWallet: vi.fn() }));
vi.mock('../../users', () => users);

import { suspensionOf } from '../suspension.service';

const party = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  name: 'Suraj Kumar Prints',
  scopes: [],
  suspendedAt: null,
  suspensionReason: null,
  suspendedById: null,
  userId: 'usr_pub',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.listEvents.mockResolvedValue([]);
});

describe('suspensionOf — who suspended them', () => {
  it('names the suspender on the current case, in the same lookup as the history', async () => {
    repository.findParty.mockResolvedValue(party({ scopes: ['BLOCK_NEW'], suspendedAt: new Date(), suspensionReason: 'Fraud case', suspendedById: 'usr_admin' }));
    repository.listEvents.mockResolvedValue([{ id: 'evt_1', action: 'SUSPEND', byUserId: 'usr_admin' }]);
    const view = await suspensionOf('PUBLISHER', 'pub_1');
    expect(view).toMatchObject({ suspendedById: 'usr_admin', suspendedBy: { id: 'usr_admin', name: 'Priya' } });
    expect(users.findUserLabels).toHaveBeenCalledTimes(1);
  });

  it('is null for a party nobody has suspended, and names null for an actor the platform no longer has', async () => {
    repository.findParty.mockResolvedValue(party());
    expect((await suspensionOf('PUBLISHER', 'pub_1')).suspendedBy).toBeNull();

    repository.findParty.mockResolvedValue(party({ scopes: ['BLOCK_NEW'], suspendedById: 'usr_gone' }));
    expect((await suspensionOf('PUBLISHER', 'pub_1')).suspendedBy).toEqual({ id: 'usr_gone', name: null });
  });
});
