import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-1: GET /fraud/cases/:id/linked carries, on every linked party, what
 * is at stake — `walletBalance` (the party's wallet balance as money, null
 * with no wallet) and `openBookings` (its non-terminal orders) — and the
 * read answers `valueAtRisk`: every balance plus every open order's value,
 * summed across the linked parties. Wallets and orders are read through
 * their indexes; an advertiser's orders hang off its login, so the index
 * resolves the party first.
 */

type AnyFn = (...args: any[]) => any;
const { repository, index, wallets, orders } = vi.hoisted(() => ({
  repository: { findSummaryById: vi.fn<AnyFn>(), update: vi.fn<AnyFn>(), create: vi.fn<AnyFn>(), findOpenForSubject: vi.fn<AnyFn>() },
  index: {
    resolveSubject: vi.fn<AnyFn>(),
    partiesWithPan: vi.fn<AnyFn>(async () => []),
    payoutHandlesFor: vi.fn<AnyFn>(async () => []),
    partiesWithPayoutHandle: vi.fn<AnyFn>(async () => []),
    signInSubnetsFor: vi.fn<AnyFn>(async () => []),
    partiesOnSubnets: vi.fn<AnyFn>(async () => []),
    partiesWithMobile: vi.fn<AnyFn>(async () => []),
    deviceTokensFor: vi.fn<AnyFn>(async () => []),
    partiesWithDeviceTokens: vi.fn<AnyFn>(async () => []),
    listingPhotosFor: vi.fn<AnyFn>(async () => []),
    listingPhotosOfOthers: vi.fn<AnyFn>(async () => []),
    proofPhotosFor: vi.fn<AnyFn>(async () => []),
    onboardedPublishersOf: vi.fn<AnyFn>(async () => []),
    bookingOutcomesFor: vi.fn<AnyFn>(async () => ({ bookings: 0, refunds: 0, disputes: 0 })),
    walletMovementsFor: vi.fn<AnyFn>(async () => ({ credits: [], withdrawals: [] })),
    listingCreatedAtFor: vi.fn<AnyFn>(async () => []),
    scanCandidates: vi.fn<AnyFn>(async () => []),
  },
  wallets: { findWalletFor: vi.fn<AnyFn>() },
  orders: { openOrderExposureFor: vi.fn<AnyFn>() },
}));

vi.mock('../prisma-fraud.repository', () => ({ prismaFraudRepository: repository }));
vi.mock('../prisma-fraud-signals.repository', () => ({ prismaFraudSignalsIndex: index }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ fraud: { scanThreshold: 0.6, scanLimitPerType: 500 } })) }));
vi.mock('../../users', () => ({ listAdminUserIds: vi.fn(async () => []), userExists: vi.fn(async () => true), findUserLabels: vi.fn(async () => new Map()) }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(async () => undefined) }));
vi.mock('../../../shared/audit', () => ({ logActivity: vi.fn(async () => undefined), auditDiff: vi.fn(() => ({})) }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn(async () => 'FRD-1409-0007') }));
vi.mock('../../kyc', () => ({ escalateKycForFraudLink: vi.fn(async () => null) }));
vi.mock('../../suspension', () => ({ suspensionOf: vi.fn(), suspendParty: vi.fn(), reinstateParty: vi.fn(), SCOPES_BY_PARTY: {} }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../orders', () => orders);

import { linkedAccounts } from '../fraud-signals.service';

const now = new Date('2026-09-14T02:30:00.000Z');
const subject = { type: 'PUBLISHER' as const, id: 'pub_1', userId: 'usr_pub', name: 'Ramesh Kumar', mobile: '+919999900001', pan: 'ABCDE1234F', kycStatus: 'PENDING', agentId: null, listingId: null };
const advertiser = { type: 'ADVERTISER' as const, id: 'adv_9', name: 'Suresh' };
const publisher = { type: 'PUBLISHER' as const, id: 'pub_2', name: null };
const agent = { type: 'AGENT' as const, id: 'agt_3', name: 'Meera' };

beforeEach(() => {
  vi.clearAllMocks();
  repository.findSummaryById.mockResolvedValue({ id: 'frd_1', subjectType: 'PUBLISHER', subjectId: 'pub_1', status: 'OPEN' });
  index.resolveSubject.mockImplementation(async (s: { type: string; id: string }) =>
    s.type === 'ADVERTISER' && s.id === 'adv_9' ? { ...subject, type: 'ADVERTISER', id: 'adv_9', userId: 'usr_adv9' } : s.id === 'pub_1' ? subject : null,
  );
  index.partiesWithPan.mockResolvedValue([advertiser]);
  index.payoutHandlesFor.mockResolvedValue([{ accountNumber: '1', upiVpa: null, accountHolder: null, nameMatchPct: null }]);
  index.partiesWithPayoutHandle.mockResolvedValue([advertiser, publisher]);
  index.partiesWithMobile.mockResolvedValue([agent]);
  wallets.findWalletFor.mockImplementation(async (owner: { kind: string; id: string }) =>
    owner.kind === 'ADVERTISER' ? { id: 'w_adv', balance: '2500.50' } : owner.kind === 'AGENT' ? { id: 'w_agt', balance: '100' } : null,
  );
  orders.openOrderExposureFor.mockImplementation(async (scope: Record<string, string>) =>
    'advertiserUserId' in scope ? { count: 2, value: '8000.00' } : 'publisherId' in scope ? { count: 1, value: '1500.00' } : { count: 0, value: '0.00' },
  );
});

describe('GET /fraud/cases/:id/linked — what is at stake', () => {
  it('carries walletBalance and openBookings per linked party and sums valueAtRisk', async () => {
    const result = await linkedAccounts('frd_1', now);
    expect(result.linked).toEqual([
      { party: advertiser, via: ['SHARED_PAN', 'SHARED_BANK', 'SELF_DEALING'], walletBalance: '2500.50', openBookings: 2 },
      { party: publisher, via: ['SHARED_BANK'], walletBalance: null, openBookings: 1 },
      { party: agent, via: ['SHARED_PHONE_ACROSS_ROLES'], walletBalance: '100.00', openBookings: 0 },
    ]);
    // 2500.50 + 100.00 in wallets, 8000.00 + 1500.00 + 0.00 in open orders.
    expect(result.valueAtRisk).toBe('12100.50');
    expect(result.computedAt).toEqual(now);
  });

  it('reads wallets by the party, publishers and agents by their own id, and an advertiser by its login', async () => {
    await linkedAccounts('frd_1', now);
    expect(wallets.findWalletFor).toHaveBeenCalledWith({ kind: 'ADVERTISER', id: 'adv_9' });
    expect(wallets.findWalletFor).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_2' });
    expect(wallets.findWalletFor).toHaveBeenCalledWith({ kind: 'AGENT', id: 'agt_3' });
    expect(orders.openOrderExposureFor).toHaveBeenCalledWith({ advertiserUserId: 'usr_adv9' });
    expect(orders.openOrderExposureFor).toHaveBeenCalledWith({ publisherId: 'pub_2' });
    expect(orders.openOrderExposureFor).toHaveBeenCalledWith({ agentId: 'agt_3' });
  });

  it('G13-B: answers the parties the last scoring compared without a link as evaluated { party, linked: false }', async () => {
    const seven = { type: 'PUBLISHER' as const, id: 'pub_7', name: 'Seven' };
    repository.findSummaryById.mockResolvedValue({
      id: 'frd_1',
      subjectType: 'PUBLISHER',
      subjectId: 'pub_1',
      status: 'OPEN',
      signals: [
        // pub_2 was a candidate here and is linked live through the bank — not clean.
        { key: 'DUPLICATE_LISTING_PHOTOS', weight: 0.3, value: 0, detail: 'none', candidates: [seven, publisher, { type: 'PUBLISHER', id: 'pub_1', name: null }] },
        { key: 'SHARED_PAN', weight: 0.35, value: 1, detail: 'x', links: [advertiser] },
      ],
    });
    const result = await linkedAccounts('frd_1', now);
    expect(result.linked.map((l) => l.party.id)).toEqual(expect.arrayContaining(['adv_9', 'pub_2', 'agt_3']));
    expect(result.evaluated).toEqual([{ party: seven, linked: false }]);
  });

  it('G13-B: a case never scored has nothing evaluated', async () => {
    expect((await linkedAccounts('frd_1', now)).evaluated).toEqual([]);
  });

  it('an advertiser with no login has no orders to count; nothing linked is nothing at risk', async () => {
    index.resolveSubject.mockImplementation(async (s: { id: string }) => (s.id === 'pub_1' ? subject : null));
    index.partiesWithPayoutHandle.mockResolvedValue([]);
    index.partiesWithMobile.mockResolvedValue([]);
    const result = await linkedAccounts('frd_1', now);
    expect(result.linked).toEqual([{ party: advertiser, via: ['SHARED_PAN', 'SELF_DEALING'], walletBalance: '2500.50', openBookings: 0 }]);
    expect(orders.openOrderExposureFor).not.toHaveBeenCalled();
    expect(result.valueAtRisk).toBe('2500.50');

    index.partiesWithPan.mockResolvedValue([]);
    expect(await linkedAccounts('frd_1', now)).toMatchObject({ linked: [], valueAtRisk: '0.00' });
  });
});
