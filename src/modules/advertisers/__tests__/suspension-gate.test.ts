import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot A on the demand side.
 *
 * BLOCK_NEW is checked ahead of the ordinary gates: an account ADX has
 * suspended is told so, rather than being sent to KYC or to top-up for a
 * problem it does not have. FREEZE_WALLET is checked separately again, because
 * the funds check would otherwise report a frozen wallet as merely short.
 */

const { repository, wallets } = vi.hoisted(() => ({
  repository: {
    findAdvertiserById: vi.fn(),
    findAcceptance: vi.fn(),
    // Lot D (Q55): the gate reads the live template beside the click.
    activeTemplate: vi.fn(),
    walletSnapshot: vi.fn(),
    placeHold: vi.fn(),
    ensureWallet: vi.fn(),
  },
  wallets: { move: vi.fn(), findWallet: vi.fn() },
}));

vi.mock('../prisma-advertisers.repository', () => ({ prismaAdvertisersRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn() }));
vi.mock('../../payouts', () => ({ findPayoutMethod: vi.fn() }));

import {
  assertCanBook,
  assertNotSuspended,
  bookingEligibility,
  holdForCampaign,
  payForPackage,
} from '../advertisers.service';

const advertiser = (over: Record<string, unknown> = {}) =>
  ({
    id: 'adv_1',
    name: 'Nilgiri Coffee',
    type: 'INDIVIDUAL',
    billingAddress: '12 Residency Road',
    city: 'Bengaluru',
    kycStatus: 'VERIFIED',
    suspensionScopes: [],
    ...over,
  }) as never;

const wallet = (over: Record<string, unknown> = {}) =>
  ({ balance: '50000.00', goodwill: '0.00', held: '0.00', spendable: '50000.00', currency: 'INR', frozenAt: null, ...over }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAdvertiserById.mockResolvedValue(advertiser());
  repository.findAcceptance.mockResolvedValue({ id: 'acc_1' });
  repository.activeTemplate.mockResolvedValue(null);
  repository.walletSnapshot.mockResolvedValue(wallet());
  repository.placeHold.mockResolvedValue({ id: 'hld_1' });
  repository.ensureWallet.mockResolvedValue({ id: 'wal_1', advertiserId: 'adv_1' });
  wallets.move.mockResolvedValue({ wallet: {}, entry: null, entries: [], ledgerTransactionId: 'ltx_1', created: true });
});

describe('BLOCK_NEW', () => {
  it('shows up as its own blocker on the eligibility read', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ suspensionScopes: ['BLOCK_NEW'] }));
    const eligibility = await bookingEligibility('adv_1');
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockedBy).toContain('SUSPENDED');
  });

  it('refuses the booking with 409 ADVERTISER_SUSPENDED, ahead of KYC and funds', async () => {
    repository.findAdvertiserById.mockResolvedValue(
      advertiser({ suspensionScopes: ['BLOCK_NEW'], kycStatus: 'PENDING' }),
    );
    await expect(assertCanBook('adv_1', '1000.00')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ADVERTISER_SUSPENDED',
    });
  });

  it('refuses a campaign hold and a package purchase alike', async () => {
    repository.findAdvertiserById.mockResolvedValue(advertiser({ suspensionScopes: ['BLOCK_NEW'] }));
    await expect(holdForCampaign('adv_1', 'cmp_1', '1000.00')).rejects.toMatchObject({ code: 'ADVERTISER_SUSPENDED' });
    await expect(payForPackage('adv_1', 'sal_1', '1000.00', 'Plan')).rejects.toMatchObject({ code: 'ADVERTISER_SUSPENDED' });
    expect(repository.placeHold).not.toHaveBeenCalled();
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('is the whole check on its own, for a payment that arrived outside ADX', async () => {
    // No KYC, no agreement, no funds question — an offline transfer has none of
    // those to answer, and only the suspension should stop it.
    repository.findAdvertiserById.mockResolvedValue(
      advertiser({ kycStatus: 'PENDING', billingAddress: null, suspensionScopes: [] }),
    );
    await expect(assertNotSuspended('adv_1')).resolves.toBeUndefined();

    repository.findAdvertiserById.mockResolvedValue(advertiser({ suspensionScopes: ['BLOCK_NEW'] }));
    await expect(assertNotSuspended('adv_1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'ADVERTISER_SUSPENDED',
    });
  });

  it('leaves an unsuspended account exactly as it was', async () => {
    await expect(holdForCampaign('adv_1', 'cmp_1', '1000.00')).resolves.toEqual({ holdId: 'hld_1' });
  });
});

describe('FREEZE_WALLET', () => {
  it('refuses a hold with 409 WALLET_FROZEN rather than reporting a shortfall', async () => {
    repository.walletSnapshot.mockResolvedValue(wallet({ frozenAt: new Date('2026-09-12T00:00:00Z') }));
    await expect(holdForCampaign('adv_1', 'cmp_1', '1000.00')).rejects.toMatchObject({
      statusCode: 409,
      code: 'WALLET_FROZEN',
    });
    expect(repository.placeHold).not.toHaveBeenCalled();
  });

  it('refuses a package debit the same way', async () => {
    repository.walletSnapshot.mockResolvedValue(wallet({ frozenAt: new Date('2026-09-12T00:00:00Z') }));
    await expect(payForPackage('adv_1', 'sal_1', '1000.00', 'Plan')).rejects.toMatchObject({ code: 'WALLET_FROZEN' });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  // Lot B: the package debit is a movement through the wallets service,
  // keyed on the sale, spending goodwill first and checking the funds on the
  // row it debits — the same path the freeze is enforced on.
  it('debits a package through the wallets service, keyed on the sale', async () => {
    await expect(payForPackage('adv_1', 'sal_1', '1000.00', 'Plan')).resolves.toEqual({ paid: true });
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal_1',
        amount: '-1000.00',
        entryType: 'PACKAGE_DEBIT',
        ledgerKind: 'PACKAGE_SPEND',
        idempotencyKey: 'package-debit:sal_1',
        spendGoodwillFirst: true,
        requireFunds: true,
        reference: 'sal_1',
        counterLegs: [expect.objectContaining({ accountCode: 'platform:revenue', amount: '1000.00' })],
      })
    );
  });
});
