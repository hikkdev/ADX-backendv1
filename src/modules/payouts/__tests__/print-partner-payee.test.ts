import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Print partners as payees — Lot B (Q50/B4b), owner decisions 50 and 122.
 *
 * A partner cannot sign in, so its settlement starts at the desk: ops names
 * the wallet and the amount, and everything after that is the ordinary
 * withdrawal — the VERIFIED default method, the minimum, the cap, the cleared
 * balance. The batch preflight then treats the partner as what it is: no KYC
 * record to check, and the partner's own switch instead of the account's.
 */

const { repository, wallets, ledger, ifsc, appConfig, uploads } = vi.hoisted(() => ({
  repository: {
    findPartyContext: vi.fn(),
    findWalletForUser: vi.fn(),
    findPublisherIdForUser: vi.fn(),
    findMethodsForUser: vi.fn(),
    findMethod: vi.fn(),
    countMethodsForUser: vi.fn(),
    createMethod: vi.fn(),
    updateMethod: vi.fn(),
    removeMethod: vi.fn(),
    setDefaultMethod: vi.fn(),
    listMethodsByStatus: vi.fn(),
    listLimits: vi.fn(),
    upsertLimit: vi.fn(),
    findTaxRate: vi.fn(),
    listTaxRates: vi.fn(),
    createTaxRate: vi.fn(),
    closeTaxRate: vi.fn(),
    createWithdrawal: vi.fn(),
    findWithdrawal: vi.fn(),
    updateWithdrawal: vi.fn(),
    listWithdrawals: vi.fn(),
    findWithdrawals: vi.fn(),
    withdrawalSummary: vi.fn(),
    findWithdrawalByRailReference: vi.fn(),
    findWithdrawalByReference: vi.fn(),
    referenceExists: vi.fn(),
    countForYear: vi.fn(),
    findBatch: vi.fn(),
    sumOpen: vi.fn(),
    sumForDay: vi.fn(),
  },
  wallets: { ensureWallet: vi.fn(), move: vi.fn(), snapshot: vi.fn() },
  ledger: { platformAccount: vi.fn(), post: vi.fn(), verifyLedger: vi.fn() },
  ifsc: { lookupIfsc: vi.fn(), normaliseIfsc: (code: string) => code.trim().toUpperCase() },
  appConfig: {
    getPlatformSettings: vi.fn(async () => ({
      finance: { primaryRail: 'MANUAL_NEFT', railFallbackOrder: ['RAZORPAY_X', 'CASHFREE', 'MANUAL_NEFT'], payoutEtaHours: 48, clearingDays: 7 },
    })),
  },
  uploads: { storeGeneratedFile: vi.fn() },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ledger);
vi.mock('../../../shared/integrations', () => ifsc);
vi.mock('../../app-config', () => appConfig);
vi.mock('../../uploads', () => uploads);
// Lot E1/F: the dispatcher behind the payout-paid and incentive notices — never the wire in a unit test.
vi.mock('../../notifications', () => ({ notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })), createNotification: vi.fn(async () => ({ id: 'ntf' })) }));

import { requestWithdrawalOnBehalf } from '../payouts.service';
import { preflightBatch } from '../batches.service';
import { DEFAULT_LIMITS, DEFAULT_TAX_RATES, resetRulesCache } from '../rules.service';
import { partyOfWithdrawal } from '../payouts.repository';

const NOW = new Date('2026-09-12T10:00:00Z');

const limitRows = DEFAULT_LIMITS.map((limit, i) => ({
  id: `lim_${i}`,
  band: limit.band,
  minMonths: limit.minMonths,
  dailyCap: new Decimal(limit.dailyCap),
  createdAt: NOW,
  updatedAt: NOW,
}));

const method = (over: Record<string, unknown> = {}) => ({
  id: 'pm_prt',
  userId: 'usr_prt',
  type: 'BANK',
  accountHolder: 'Rapid Prints',
  bankName: 'HDFC',
  accountNumber: '000123453310',
  ifscCode: 'HDFC0001234',
  upiVpa: null,
  isDefault: true,
  status: 'VERIFIED',
  createdAt: NOW,
  ...over,
});

/** The context `findPartyContext` builds for a print partner's wallet. */
const partnerParty = (over: Record<string, unknown> = {}) => ({
  kind: 'PRINT_PARTNER',
  entityId: 'prt_1',
  walletId: 'wal_prt',
  userId: 'usr_prt',
  name: 'Rapid Prints',
  onboardedAt: new Date('2026-09-01T00:00:00Z'),
  sizeBand: 'SMALL_AGENCY',
  tier: null,
  kycStatus: null,
  userActive: true,
  email: null,
  mobile: '+919876543210',
  ...over,
});

const balances = (over: Record<string, unknown> = {}) => ({
  walletId: 'wal_prt',
  balance: '12000.00',
  goodwill: '0.00',
  spendable: '12000.00',
  pendingClearance: '0.00',
  held: '0.00',
  openWithdrawals: '0.00',
  withdrawable: '12000.00',
  lastActivityAt: NOW,
  frozenAt: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRulesCache();
  repository.listLimits.mockResolvedValue(limitRows);
  repository.listTaxRates.mockResolvedValue([{ id: 't1' }]);
  repository.findTaxRate.mockResolvedValue(null);
  repository.findPartyContext.mockResolvedValue(partnerParty());
  repository.findMethodsForUser.mockResolvedValue([method({ id: 'pm_old', isDefault: false, status: 'REJECTED' }), method()]);
  repository.findMethod.mockImplementation(async (id: string) => (id === 'pm_prt' ? method() : null));
  repository.sumForDay.mockResolvedValue(new Decimal(0));
  repository.countForYear.mockResolvedValue(3);
  repository.referenceExists.mockResolvedValue(false);
  repository.createWithdrawal.mockImplementation(async (data: Record<string, unknown>) => ({
    ...data,
    id: 'wdr_prt',
    status: 'REQUESTED',
    payoutMethod: method(),
    wallet: { id: 'wal_prt', printPartnerId: 'prt_1', printPartner: { name: 'Rapid Prints' } },
  }));
  wallets.snapshot.mockResolvedValue(balances());
  ledger.verifyLedger.mockResolvedValue({ healthy: true });
});

describe('a withdrawal raised on the partner’s behalf', () => {
  it('uses the partner’s verified default method and the ordinary rules', async () => {
    const row = await requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '12000.00' }, NOW);
    expect(row.status).toBe('REQUESTED');
    expect(repository.createWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({
        walletId: 'wal_prt',
        payoutMethodId: 'pm_prt',
        reference: 'WDR-2026-000004',
        taxWithheld: new Decimal(0),
      })
    );
    expect(new Decimal(row.amount as never).toFixed(2)).toBe('12000.00');
    // The partner sits on the small-agency rung, so ₹12,000 clears a new
    // partner's daily cap where the individual rung's ₹5,000 would not.
    expect(partyOfWithdrawal(row as never)).toEqual({ kind: 'PRINT_PARTNER', name: 'Rapid Prints' });
  });

  it('takes a named method, checked as the partner’s own', async () => {
    await requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '1000.00', payoutMethodId: 'pm_prt' }, NOW);
    expect(repository.createWithdrawal).toHaveBeenCalledWith(expect.objectContaining({ payoutMethodId: 'pm_prt' }));
    repository.findMethod.mockResolvedValue(method({ id: 'pm_other', userId: 'usr_someone_else' }));
    await expect(
      requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '1000.00', payoutMethodId: 'pm_other' }, NOW)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses without a verified method, and names the fix', async () => {
    repository.findMethodsForUser.mockResolvedValue([method({ status: 'PENDING_VERIFICATION' })]);
    await expect(requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '1000.00' }, NOW)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('POST /finance/payout-methods'),
    });
    expect(repository.createWithdrawal).not.toHaveBeenCalled();
  });

  it('keeps every ordinary rule — the cleared balance, the minimum, the freeze', async () => {
    await expect(requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '20000.00' }, NOW)).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '100.00' }, NOW)).rejects.toMatchObject({
      statusCode: 400,
    });
    wallets.snapshot.mockResolvedValue(balances({ frozenAt: NOW }));
    await expect(requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '1000.00' }, NOW)).rejects.toMatchObject({
      statusCode: 409,
      code: 'WALLET_FROZEN',
    });
    expect(repository.createWithdrawal).not.toHaveBeenCalled();
  });

  it('answers 404 for a wallet that is not there', async () => {
    repository.findPartyContext.mockResolvedValue(null);
    await expect(requestWithdrawalOnBehalf({ walletId: 'wal_none', amount: '1000.00' }, NOW)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('the batch preflight for a partner line', () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: 'wdr_prt',
    reference: 'WDR-2026-000004',
    walletId: 'wal_prt',
    status: 'APPROVED',
    amount: new Decimal('1000.00'),
    netAmount: new Decimal('1000.00'),
    payoutMethod: method(),
    wallet: { id: 'wal_prt', printPartnerId: 'prt_1' },
    ...over,
  });

  beforeEach(() => {
    repository.findBatch.mockResolvedValue({
      id: 'bat_1',
      reference: 'BATCH-2026-000001',
      status: 'APPROVED',
      rail: 'MANUAL_NEFT',
      lines: [line()],
      bankAccount: null,
    });
  });

  it('asks for no KYC — ops vetted the partner at the desk — and reads the partner’s own switch', async () => {
    const result = await preflightBatch('bat_1', NOW);
    expect(result.lines[0]!.problems).toEqual([]);
    expect(result.ok).toBe(true);

    repository.findPartyContext.mockResolvedValue(partnerParty({ userActive: false }));
    const off = await preflightBatch('bat_1', NOW);
    expect(off.lines[0]!.problems).toEqual(['PARTNER_INACTIVE']);
  });

  it('still asks every other party for KYC', async () => {
    repository.findPartyContext.mockResolvedValue(partnerParty({ kind: 'PUBLISHER', kycStatus: 'PENDING' }));
    const result = await preflightBatch('bat_1', NOW);
    expect(result.lines[0]!.problems).toEqual(['KYC_NOT_VERIFIED']);
  });
});

describe('the tax rate table', () => {
  it('seeds a 194C row for partners beside the publisher and agent rows', () => {
    const partner = DEFAULT_TAX_RATES.find((rate) => rate.appliesTo === 'PARTNER');
    expect(partner).toMatchObject({ section: '194C', ratePct: '0.00' });
  });
});
