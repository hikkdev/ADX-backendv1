import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Getting money out of ADX.
 *
 * The cases below are the rules that were decided rather than assumed: the
 * tiered daily caps, the clearing window, tax withheld at credit rather than at
 * withdrawal, and the absence of any auto-approval threshold anywhere.
 */

const { repository, wallets, ledger, ifsc, appConfig, notifications } = vi.hoisted(() => ({
  notifications: { notify: vi.fn(async () => ({ notificationId: 'ntf_1', templateKey: 'payout-paid', deliveries: [] })), createNotification: vi.fn() },
  repository: {
    findWithdrawals: vi.fn(),
    withdrawalSummary: vi.fn(),
    findWithdrawalByRailReference: vi.fn(),
    findWithdrawalByReference: vi.fn(),
    createBatch: vi.fn(),
    findBatch: vi.fn(),
    updateBatch: vi.fn(),
    listBatches: vi.fn(),
    batchReferenceExists: vi.fn(),
    countBatchesForYear: vi.fn(),
    setBatchLines: vi.fn(),
    recountBatch: vi.fn(),
    tallyBatchLines: vi.fn(),
    listBankAccounts: vi.fn(),
    findBankAccount: vi.fn(),
    createBankAccount: vi.fn(),
    updateBankAccount: vi.fn(),
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
    referenceExists: vi.fn(),
    countForYear: vi.fn(),
    sumOpen: vi.fn(),
    sumForDay: vi.fn(),
    findAccruableSpots: vi.fn(),
    findAccruedDates: vi.fn(),
    createAccrual: vi.fn(),
    sumAccruals: vi.fn(),
    listAccruals: vi.fn(),
    findIncentiveRate: vi.fn(),
    listIncentiveRates: vi.fn(),
    upsertIncentiveRate: vi.fn(),
    createIncentive: vi.fn(),
    findIncentive: vi.fn(),
    updateIncentive: vi.fn(),
    listIncentives: vi.fn(),
    sumIncentives: vi.fn(),
    countIncentivesByEvent: vi.fn(),
    findIncentiveRecipient: vi.fn(),
  },
  wallets: {
    ensureWallet: vi.fn(),
    move: vi.fn(),
    snapshot: vi.fn(),
  },
  ledger: { platformAccount: vi.fn(), post: vi.fn(), verifyLedger: vi.fn() },
  ifsc: { lookupIfsc: vi.fn(), normaliseIfsc: (code: string) => code.trim().toUpperCase() },
  appConfig: {
    getPlatformSettings: vi.fn(async () => ({
      finance: { primaryRail: 'MANUAL_NEFT', railFallbackOrder: ['RAZORPAY_X', 'CASHFREE', 'MANUAL_NEFT'], payoutEtaHours: 48, clearingDays: 7 },
    })),
  },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ledger);
vi.mock('../../../shared/integrations', () => ifsc);
vi.mock('../../app-config', () => appConfig);
vi.mock('../../notifications', () => notifications);

import {
  CLOSURE_WITHDRAWAL_MARKER,
  addMethod,
  approveWithdrawal,
  cancelWithdrawal,
  failWithdrawal,
  isClosureWithdrawal,
  markWithdrawalPaid,
  payoutMethodLabel,
  rejectWithdrawal,
  requestClosingWithdrawal,
  requestWithdrawal,
  walletForUserOrOpen,
  withdrawalAllowance,
} from '../payouts.service';
import {
  DEFAULT_LIMITS,
  dailyCapFor,
  monthsBetween,
  resetRulesCache,
  withholdingFor,
} from '../rules.service';
import { CLEARING_DAYS, elapsedDays, splitDay } from '../accrual.service';
import { creditIncentive, recordIncentive, resetIncentiveCache } from '../incentives.service';

const NOW = new Date('2026-09-09T10:00:00Z');

const limitRows = DEFAULT_LIMITS.map((limit, i) => ({
  id: `lim_${i}`,
  band: limit.band,
  minMonths: limit.minMonths,
  dailyCap: new Decimal(limit.dailyCap),
  createdAt: NOW,
  updatedAt: NOW,
}));

const method = (over: Record<string, unknown> = {}) => ({
  id: 'pm_1',
  userId: 'usr_1',
  type: 'BANK',
  accountHolder: 'Sharma Hoardings',
  bankName: 'HDFC',
  accountNumber: '000123453310',
  ifscCode: 'HDFC0001234',
  upiVpa: null,
  isDefault: true,
  status: 'VERIFIED',
  createdAt: NOW,
  ...over,
});

const party = (over: Record<string, unknown> = {}) => ({
  kind: 'PUBLISHER',
  entityId: 'pub_1',
  walletId: 'wal_1',
  userId: 'usr_1',
  name: 'Sharma Hoardings',
  onboardedAt: new Date('2026-01-09T00:00:00Z'),
  sizeBand: 'INDIVIDUAL',
  tier: null,
  ...over,
});

const balances = (over: Record<string, unknown> = {}) => ({
  walletId: 'wal_1',
  balance: '40000.00',
  goodwill: '0.00',
  spendable: '40000.00',
  pendingClearance: '5000.00',
  held: '0.00',
  openWithdrawals: '0.00',
  withdrawable: '35000.00',
  lastActivityAt: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRulesCache();
  resetIncentiveCache();
  repository.listLimits.mockResolvedValue(limitRows);
  repository.listTaxRates.mockResolvedValue([{ id: 't1' }]);
  repository.findTaxRate.mockResolvedValue(null);
  repository.findPartyContext.mockResolvedValue(party());
  repository.findMethod.mockResolvedValue(method());
  repository.sumForDay.mockResolvedValue(new Decimal(0));
  repository.countForYear.mockResolvedValue(117);
  repository.referenceExists.mockResolvedValue(false);
  repository.createWithdrawal.mockImplementation(async (data: Record<string, unknown>) => ({
    ...data,
    id: 'wdr_1',
    status: 'REQUESTED',
    payoutMethod: method(),
    wallet: { id: 'wal_1' },
  }));
  repository.updateWithdrawal.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
    id,
    reference: 'WDR-2026-000118',
    amount: new Decimal('10000.00'),
    netAmount: new Decimal('10000.00'),
    taxWithheld: new Decimal(0),
    payoutMethod: method(),
    wallet: { id: 'wal_1' },
    ...patch,
  }));
  wallets.snapshot.mockResolvedValue(balances());
  wallets.move.mockResolvedValue({ entry: { id: 'we_1' }, ledgerTransactionId: 'ltx_1', created: true });
  wallets.ensureWallet.mockResolvedValue({ id: 'wal_1' });
  ledger.platformAccount.mockImplementation(async (code: string) => ({ id: `acc_${code}` }));
  ledger.post.mockResolvedValue({ transaction: { id: 'ltx_paid' }, created: true });
  ifsc.lookupIfsc.mockResolvedValue(null);
  repository.countMethodsForUser.mockResolvedValue(0);
  repository.createMethod.mockImplementation(async (data: Record<string, unknown>) => ({ id: 'pm_new', ...data }));
});

describe('the withdrawal ladder', () => {
  it('counts whole months on the platform', () => {
    expect(monthsBetween(new Date('2026-01-09'), new Date('2026-09-09'))).toBe(8);
    // A day short of the anniversary is not the next month yet.
    expect(monthsBetween(new Date('2026-01-10'), new Date('2026-09-09'))).toBe(7);
    expect(monthsBetween(new Date('2026-09-09'), new Date('2026-09-09'))).toBe(0);
  });

  it('puts a new individual publisher on ₹5,000 a day', async () => {
    const cap = await dailyCapFor('INDIVIDUAL', new Date('2026-09-01'), NOW);
    expect(cap.cap).toBe('5000.00');
    expect(cap.nextRung).toEqual({ months: 3, cap: '10000.00' });
  });

  it('lifts an individual to ₹10,000 after three months and ₹50,000 after a year', async () => {
    expect((await dailyCapFor('INDIVIDUAL', new Date('2026-05-09'), NOW)).cap).toBe('10000.00');
    expect((await dailyCapFor('INDIVIDUAL', new Date('2025-09-09'), NOW)).cap).toBe('50000.00');
  });

  it('starts a smaller agency at ₹50,000 and a larger one at ₹1,00,000', async () => {
    expect((await dailyCapFor('SMALL_AGENCY', new Date('2026-09-01'), NOW)).cap).toBe('50000.00');
    expect((await dailyCapFor('LARGE_AGENCY', new Date('2026-09-01'), NOW)).cap).toBe('100000.00');
  });

  /* The large agency's middle rung is at six months, not three. It is the one
     asymmetry in the ladder and the easiest thing to get wrong. */
  it('lifts a larger agency at six months rather than three', async () => {
    expect((await dailyCapFor('LARGE_AGENCY', new Date('2026-06-09'), NOW)).cap).toBe('100000.00');
    expect((await dailyCapFor('LARGE_AGENCY', new Date('2026-03-09'), NOW)).cap).toBe('250000.00');
    expect((await dailyCapFor('LARGE_AGENCY', new Date('2025-09-09'), NOW)).cap).toBe('500000.00');
  });

  it('reports what is left of today rather than only the cap', async () => {
    repository.sumForDay.mockResolvedValue(new Decimal('3500.00'));
    const allowance = await withdrawalAllowance('wal_1', NOW);
    expect(allowance.dailyCap).toBe('10000.00');
    expect(allowance.usedToday).toBe('3500.00');
    expect(allowance.remainingToday).toBe('6500.00');
    // Bounded by both the cap and what has cleared.
    expect(allowance.maximum).toBe('6500.00');
  });

  it('never offers more than has cleared', async () => {
    wallets.snapshot.mockResolvedValue(balances({ withdrawable: '900.00' }));
    const allowance = await withdrawalAllowance('wal_1', NOW);
    expect(allowance.maximum).toBe('900.00');
  });
});

describe('requesting a withdrawal', () => {
  const input = { amount: '5000.00', payoutMethodId: 'pm_1', userId: 'usr_1' };

  it('creates one for an amount within the cap and the cleared balance', async () => {
    await requestWithdrawal('wal_1', input, NOW);
    const created = repository.createWithdrawal.mock.calls[0]![0];
    expect(created.reference).toBe('WDR-2026-000118');
    expect(created.amount).toEqual(new Decimal('5000.00'));
  });

  /* Tax was already taken when the earning was credited. Taking it again here
     would tax the same rupee twice. */
  it('withholds nothing, because the wallet already holds net-of-tax money', async () => {
    await requestWithdrawal('wal_1', input, NOW);
    const created = repository.createWithdrawal.mock.calls[0]![0];
    expect(created.taxWithheld).toEqual(new Decimal(0));
    expect(created.netAmount).toEqual(created.amount);
  });

  it('refuses a method ADX has not verified', async () => {
    repository.findMethod.mockResolvedValue(method({ status: 'PENDING_VERIFICATION' }));
    await expect(requestWithdrawal('wal_1', input, NOW)).rejects.toThrowError(/verified/i);
  });

  it('refuses somebody else’s payout method as if it were missing', async () => {
    repository.findMethod.mockResolvedValue(method({ userId: 'usr_other' }));
    await expect(requestWithdrawal('wal_1', input, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses less than the minimum', async () => {
    await expect(
      requestWithdrawal('wal_1', { ...input, amount: '100.00' }, NOW)
    ).rejects.toThrowError(/smallest withdrawal/i);
  });

  it('refuses more than today’s remaining cap, and says how much is left', async () => {
    repository.sumForDay.mockResolvedValue(new Decimal('9000.00'));
    await expect(
      requestWithdrawal('wal_1', { ...input, amount: '5000.00' }, NOW)
    ).rejects.toThrowError(/1000\.00 more today/);
  });

  /* The frame's Pending / Cleared split, enforced: money inside its clearing
     window is in the balance and cannot leave yet. */
  it('refuses money still inside its clearing window, and says how much', async () => {
    wallets.snapshot.mockResolvedValue(
      balances({ withdrawable: '1000.00', pendingClearance: '4000.00' })
    );
    await expect(
      requestWithdrawal('wal_1', { ...input, amount: '3000.00' }, NOW)
    ).rejects.toThrowError(/4000\.00 is still inside its clearing window/);
  });

  it('lets a party pull a request nobody has looked at', async () => {
    repository.findWithdrawal.mockResolvedValue({ id: 'wdr_1', walletId: 'wal_1', status: 'REQUESTED' });
    await cancelWithdrawal('wdr_1', 'usr_1');
    expect(repository.updateWithdrawal).toHaveBeenCalledWith('wdr_1', { status: 'CANCELLED' });
  });

  it('will not let a party pull one ADX has started on', async () => {
    repository.findWithdrawal.mockResolvedValue({ id: 'wdr_1', walletId: 'wal_1', status: 'APPROVED' });
    await expect(cancelWithdrawal('wdr_1', 'usr_1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('approval is always a person', () => {
  beforeEach(() => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      walletId: 'wal_1',
      status: 'REQUESTED',
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      rail: null,
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
  });

  /* There is no amount below which this is skipped. The absence of a threshold
     anywhere in the module is the decision, not an oversight.

     Lot B (Q140): approval RESERVES. The wallet is not debited and no PAYOUT
     legs are posted until the batch releases the line — a batch that fails
     half-way then has nothing to reverse. */
  it('reserves the money at approval and moves nothing', async () => {
    await approveWithdrawal('wdr_1', { byUserId: 'usr_admin' }, NOW);
    expect(wallets.move).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
    expect(repository.updateWithdrawal).toHaveBeenCalledWith(
      'wdr_1',
      expect.objectContaining({ status: 'APPROVED', reservedAt: NOW, rail: 'MANUAL_NEFT' })
    );
  });

  it('records who approved it', async () => {
    await approveWithdrawal('wdr_1', { byUserId: 'usr_admin', note: 'Checked' }, NOW);
    expect(repository.updateWithdrawal).toHaveBeenCalledWith(
      'wdr_1',
      expect.objectContaining({ decidedByUserId: 'usr_admin', decidedAt: NOW, decisionNote: 'Checked' })
    );
  });

  /* The reservation is what `snapshot.openWithdrawals` sums, so an approved
     line already counts against the balance; the check here adds it back
     because it is the one about to be paid. */
  it('checks the cleared balance covers it, counting its own reservation back in', async () => {
    wallets.snapshot.mockResolvedValue(balances({ balance: '5000.00', pendingClearance: '0.00', openWithdrawals: '5000.00', withdrawable: '0.00' }));
    await expect(approveWithdrawal('wdr_1', { byUserId: 'usr_admin' }, NOW)).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('un-reserves an approved line when it is rejected', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      walletId: 'wal_1',
      status: 'APPROVED',
      reservedAt: NOW,
      batchId: null,
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await rejectWithdrawal('wdr_1', { byUserId: 'usr_admin', reason: 'Duplicate' }, NOW);
    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.updateWithdrawal).toHaveBeenCalledWith(
      'wdr_1',
      expect.objectContaining({ status: 'REJECTED', reservedAt: null, batchId: null })
    );
  });

  it('takes a rejected line out of its draft batch, and refuses once the batch is signed off', async () => {
    const line = {
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      walletId: 'wal_1',
      status: 'APPROVED',
      reservedAt: NOW,
      batchId: 'bat_1',
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    };
    repository.findWithdrawal.mockResolvedValue(line);
    repository.findBatch.mockResolvedValue({ id: 'bat_1', status: 'IN_REVIEW', lines: [] });
    repository.recountBatch.mockResolvedValue({ id: 'bat_1' });
    await rejectWithdrawal('wdr_1', { byUserId: 'usr_admin', reason: 'Duplicate' }, NOW);
    expect(repository.recountBatch).toHaveBeenCalledWith('bat_1');

    repository.findBatch.mockResolvedValue({ id: 'bat_1', status: 'APPROVED', lines: [] });
    await expect(rejectWithdrawal('wdr_1', { byUserId: 'usr_admin', reason: 'Duplicate' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('will not fail a line that has not been released — there is nothing to reverse', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      status: 'APPROVED',
      walletId: 'wal_1',
      amount: new Decimal('1.00'),
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await expect(failWithdrawal('wdr_1', { reason: 'bounced', byUserId: 'a' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('returns a released line’s money with a fresh movement when it fails', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      status: 'PROCESSING',
      walletId: 'wal_1',
      batchId: null,
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await failWithdrawal('wdr_1', { reason: 'Account closed', byUserId: 'usr_finance' }, NOW);
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '5000.00', idempotencyKey: 'withdrawal-failed:wdr_1', entryType: 'ADJUSTMENT' })
    );
    expect(repository.updateWithdrawal).toHaveBeenCalledWith('wdr_1', expect.objectContaining({ status: 'FAILED', failureReason: 'Account closed' }));
  });

  /* The balance may have moved since the request. Approving a payout the wallet
     no longer covers is how an overdraft happens. */
  it('re-checks the balance at approval rather than trusting the request', async () => {
    wallets.snapshot.mockResolvedValue(balances({ withdrawable: '0.00' }));
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      walletId: 'wal_1',
      status: 'REQUESTED',
      amount: new Decimal('50000.00'),
      netAmount: new Decimal('50000.00'),
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await expect(approveWithdrawal('wdr_1', { byUserId: 'usr_admin' }, NOW)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('will not approve one that is already decided', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      status: 'PAID',
      walletId: 'wal_1',
      amount: new Decimal('1.00'),
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await expect(approveWithdrawal('wdr_1', { byUserId: 'a' }, NOW)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('moves no money when it is refused', async () => {
    await rejectWithdrawal('wdr_1', { byUserId: 'usr_admin', reason: 'KYC mismatch' }, NOW);
    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.updateWithdrawal).toHaveBeenCalledWith(
      'wdr_1',
      expect.objectContaining({ status: 'REJECTED', decisionNote: 'KYC mismatch' })
    );
  });

  it('refuses a rejection with no reason', async () => {
    await expect(
      rejectWithdrawal('wdr_1', { byUserId: 'a', reason: '  ' }, NOW)
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  /* A payout marked paid by software that did not pay anything is the worst
     bug available here, so the UTR is required. */
  it('will not mark a payment made without its transfer reference', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      status: 'APPROVED',
      walletId: 'wal_1',
      amount: new Decimal('1.00'),
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await expect(
      markWithdrawalPaid('wdr_1', { railReference: '', byUserId: 'a' }, NOW)
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(ledger.post).not.toHaveBeenCalled();
  });

  /* Lot B: cash enters the books when finance confirms the transfer left the
     bank — payables discharged, cash credited, keyed on the withdrawal. */
  it('marks paid by posting payables − / cash + for the net amount', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      status: 'PROCESSING',
      walletId: 'wal_1',
      batchId: null,
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      rail: 'MANUAL_NEFT',
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await markWithdrawalPaid('wdr_1', { railReference: 'UTR777', byUserId: 'usr_finance' }, NOW);

    expect(ledger.post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'PAYOUT',
        idempotencyKey: 'withdrawal-paid:wdr_1',
        legs: [
          expect.objectContaining({ accountId: 'acc_platform:payables', amount: '-5000.00', reference: 'WDR-2026-000118' }),
          expect.objectContaining({ accountId: 'acc_platform:cash', amount: '5000.00' }),
        ],
        createdByUserId: 'usr_finance',
      }),
      NOW
    );
    // No wallet leg: the wallet was debited when the batch released the line.
    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.updateWithdrawal).toHaveBeenCalledWith(
      'wdr_1',
      expect.objectContaining({ status: 'PAID', railReference: 'UTR777', paidAt: NOW })
    );
  });

  /* Lot E1/F: the person is told the transfer landed — one notify call, the
     in-app PAYOUT row plus the seeded payout-paid template's channels, the
     account number never whole. */
  it('tells the party through the dispatcher once the line is PAID, naming the amount, the method and the reference', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      status: 'PROCESSING',
      walletId: 'wal_1',
      batchId: null,
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('4900.00'),
      rail: 'MANUAL_NEFT',
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    repository.updateWithdrawal.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      reference: 'WDR-2026-000118',
      walletId: 'wal_1',
      batchId: null,
      netAmount: new Decimal('4900.00'),
      payoutMethod: method(),
      ...patch,
    }));
    await markWithdrawalPaid('wdr_1', { railReference: 'UTR777', byUserId: 'usr_finance' }, NOW);

    expect(notifications.notify).toHaveBeenCalledTimes(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      'PAYOUT_PAID',
      'usr_1',
      { amount: '4900.00', method: 'HDFC ••••3310', reference: 'WDR-2026-000118', utr: 'UTR777' },
      { inApp: expect.objectContaining({ type: 'PAYOUT', title: 'Payout sent', relatedId: 'wdr_1' }) },
    );
    expect(payoutMethodLabel({ type: 'UPI', upiVpa: 'sharma@upi', bankName: null, accountNumber: null })).toBe('sharma@upi');
    expect(payoutMethodLabel({ type: 'BANK', upiVpa: null, bankName: null, accountNumber: null })).toBe('your bank account');

    // No user behind the wallet (an agent still holds the account): nothing to tell, nothing thrown.
    notifications.notify.mockClear();
    repository.findPartyContext.mockResolvedValueOnce(party({ userId: null }));
    await expect(markWithdrawalPaid('wdr_1', { railReference: 'UTR778', byUserId: 'usr_finance' }, NOW)).resolves.toMatchObject({ status: 'PAID' });
    expect(notifications.notify).not.toHaveBeenCalled();

    // A dispatcher failure never unwinds a recorded payment.
    notifications.notify.mockRejectedValueOnce(new Error('comms down'));
    await expect(markWithdrawalPaid('wdr_1', { railReference: 'UTR779', byUserId: 'usr_finance' }, NOW)).resolves.toMatchObject({ status: 'PAID' });
  });

  /* Lot B (Q140): a line paid by hand straight from APPROVED never went
     through a batch, so the debit it would have had at release is posted
     here first — the wallet must not keep money that has left the bank. */
  it('debits a reserved line first when it is marked paid without a batch', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      status: 'APPROVED',
      walletId: 'wal_1',
      batchId: null,
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      rail: 'MANUAL_NEFT',
      decisionNote: null,
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await markWithdrawalPaid('wdr_1', { railReference: 'UTR777', byUserId: 'usr_finance' }, NOW);
    const movement = wallets.move.mock.calls[0]![0];
    expect(movement).toMatchObject({ amount: '-5000.00', entryType: 'PAYOUT', idempotencyKey: 'withdrawal:wdr_1' });
    expect(movement.counterLegs).toEqual([expect.objectContaining({ accountCode: 'platform:payables', amount: '5000.00' })]);
    expect(ledger.post).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'withdrawal-paid:wdr_1' }), NOW);
    expect(repository.updateWithdrawal).toHaveBeenCalledWith('wdr_1', expect.objectContaining({ status: 'PAID' }));
  });

  it('posts nothing the second time it is marked paid', async () => {
    repository.findWithdrawal.mockResolvedValue({ id: 'wdr_1', status: 'PAID', payoutMethod: method(), wallet: { id: 'wal_1' } });
    await markWithdrawalPaid('wdr_1', { railReference: 'UTR777', byUserId: 'usr_finance' }, NOW);
    expect(ledger.post).not.toHaveBeenCalled();
  });
});

/*
 * Lot A (Q21), verifier finding (c): the closure freezes the wallet and THEN
 * raises the final payout, so the freeze it applied must not stop its own
 * withdrawal at approval — and must stop every other one.
 */
describe('the closure’s final payout passes the freeze it caused', () => {
  const FROZEN = new Date('2026-09-12T00:00:00Z');

  it('is marked by the closure when it is raised', async () => {
    repository.findMethodsForUser.mockResolvedValue([method()]);
    const result = await requestClosingWithdrawal('wal_1', { userId: 'usr_1' }, NOW);
    expect(result.reason).toBe('REQUESTED');
    expect(repository.createWithdrawal).toHaveBeenCalledWith(
      expect.objectContaining({ decisionNote: CLOSURE_WITHDRAWAL_MARKER })
    );
    expect(isClosureWithdrawal({ decisionNote: CLOSURE_WITHDRAWAL_MARKER })).toBe(true);
    expect(isClosureWithdrawal({ decisionNote: 'Checked' })).toBe(false);
    expect(isClosureWithdrawal({ decisionNote: null })).toBe(false);
  });

  it('is approved on a frozen wallet, and the marker survives for release to read', async () => {
    wallets.snapshot.mockResolvedValue(balances({ frozenAt: FROZEN }));
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_close',
      reference: 'WDR-2026-000119',
      walletId: 'wal_1',
      status: 'REQUESTED',
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      decisionNote: CLOSURE_WITHDRAWAL_MARKER,
      rail: null,
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });

    await approveWithdrawal('wdr_close', { byUserId: 'usr_admin', note: 'Final payout' }, NOW);

    // Lot B (Q140): nothing moves at approval — the freeze is passed at release.
    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.updateWithdrawal).toHaveBeenCalledWith(
      'wdr_close',
      expect.objectContaining({ status: 'APPROVED', reservedAt: NOW, decisionNote: `${CLOSURE_WITHDRAWAL_MARKER} — Final payout` })
    );
  });

  it('is debited past the freeze when it is paid', async () => {
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_close',
      reference: 'WDR-2026-000119',
      walletId: 'wal_1',
      status: 'APPROVED',
      batchId: null,
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      decisionNote: CLOSURE_WITHDRAWAL_MARKER,
      rail: 'MANUAL_NEFT',
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await markWithdrawalPaid('wdr_close', { railReference: 'UTR778', byUserId: 'usr_finance' }, NOW);
    expect(wallets.move).toHaveBeenCalledWith(expect.objectContaining({ allowFrozen: true, amount: '-5000.00' }));
  });

  it('still refuses every other withdrawal on a frozen wallet', async () => {
    wallets.snapshot.mockResolvedValue(balances({ frozenAt: FROZEN }));
    repository.findWithdrawal.mockResolvedValue({
      id: 'wdr_1',
      reference: 'WDR-2026-000118',
      walletId: 'wal_1',
      status: 'REQUESTED',
      amount: new Decimal('5000.00'),
      netAmount: new Decimal('5000.00'),
      decisionNote: null,
      payoutMethod: method(),
      wallet: { id: 'wal_1' },
    });
    await expect(approveWithdrawal('wdr_1', { byUserId: 'usr_admin' }, NOW)).rejects.toMatchObject({ code: 'WALLET_FROZEN' });
    expect(wallets.move).not.toHaveBeenCalled();
  });
});

/* Lot B (Q11): a bank account's IFSC is checked against the public directory
   before the row is written — and a free service being down is not a reason
   a party cannot add their account. */
describe('adding a bank account checks the IFSC', () => {
  const bank = {
    type: 'BANK' as const,
    accountHolder: 'Sharma Hoardings',
    bankName: 'hdfc',
    accountNumber: '000123453310',
    ifscCode: 'hdfc0001234',
  };

  it('stores the directory’s bank and branch, and when it said so', async () => {
    ifsc.lookupIfsc.mockResolvedValue({
      ifsc: 'HDFC0001234', bank: 'HDFC Bank', branch: 'Koramangala', city: 'Bengaluru', state: 'Karnataka', neft: true, imps: true, rtgs: true, found: true,
    });
    await addMethod('usr_1', bank);
    expect(repository.createMethod).toHaveBeenCalledWith(
      expect.objectContaining({
        bankName: 'HDFC Bank',
        bankBranch: 'Koramangala',
        ifscCode: 'HDFC0001234',
        ifscVerifiedAt: expect.any(Date),
        isDefault: true,
      })
    );
  });

  it('refuses 400 IFSC_UNKNOWN when the directory does not know the code', async () => {
    ifsc.lookupIfsc.mockResolvedValue({ ifsc: 'HDFC0001234', found: false });
    await expect(addMethod('usr_1', bank)).rejects.toMatchObject({ statusCode: 400, code: 'IFSC_UNKNOWN' });
    expect(repository.createMethod).not.toHaveBeenCalled();
  });

  it('lets the typed bank stand, unverified, when the directory is down', async () => {
    ifsc.lookupIfsc.mockResolvedValue(null);
    await addMethod('usr_1', bank);
    expect(repository.createMethod).toHaveBeenCalledWith(
      expect.objectContaining({ bankName: 'hdfc', bankBranch: null, ifscVerifiedAt: null, ifscCode: 'HDFC0001234' })
    );
  });

  it('does not ask the directory about a UPI method', async () => {
    await addMethod('usr_1', { type: 'UPI', upiVpa: 'sharma@upi' });
    expect(ifsc.lookupIfsc).not.toHaveBeenCalled();
  });
});

describe('earnings accrue a day at a time', () => {
  it('counts only days that have finished', () => {
    const days = elapsedDays(
      new Date('2026-09-05T00:00:00Z'),
      new Date('2026-09-20T00:00:00Z'),
      NOW
    );
    expect(days).toHaveLength(4); // 5th, 6th, 7th, 8th — not the 9th, still running
    expect(days[0]!.toISOString().slice(0, 10)).toBe('2026-09-05');
    expect(days[3]!.toISOString().slice(0, 10)).toBe('2026-09-08');
  });

  it('never runs past the end of the flight', () => {
    const days = elapsedDays(
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-03T00:00:00Z'),
      NOW
    );
    expect(days).toHaveLength(3);
  });

  it('earns nothing on the day a campaign starts', () => {
    expect(elapsedDays(NOW, new Date('2026-09-30'), NOW)).toHaveLength(0);
  });

  it('splits a day into publisher, commission and tax, and they add back up', () => {
    const split = splitDay('1000.00', '12.50', '2.00');
    expect(split.gross).toBe('1000.00');
    expect(split.commission).toBe('125.00');
    // Tax is on what the publisher earns, not on the advertiser's gross.
    expect(split.taxWithheld).toBe('17.50');
    expect(split.net).toBe('857.50');
    expect(
      new Decimal(split.commission).plus(split.taxWithheld).plus(split.net).toFixed(2)
    ).toBe('1000.00');
  });

  it('holds each day for a week before it can be withdrawn', () => {
    expect(CLEARING_DAYS).toBe(7);
  });
});

describe('tax is withheld when income is credited', () => {
  it('withholds nothing while the rate is unset', async () => {
    const result = await withholdingFor('PUBLISHER', '1000.00', NOW);
    expect(result.taxWithheld).toBe('0.00');
    expect(result.section).toBeNull();
  });

  it('withholds at the rate in force', async () => {
    repository.findTaxRate.mockResolvedValue({
      id: 't1',
      ratePct: new Decimal('2.00'),
      section: '194C',
    });
    const result = await withholdingFor('PUBLISHER', '1000.00', NOW);
    expect(result.taxWithheld).toBe('20.00');
    expect(result.section).toBe('194C');
  });
});

describe('agent incentives wait for ops', () => {
  beforeEach(() => {
    repository.listIncentiveRates.mockResolvedValue([{ id: 'ir_1' }]);
    repository.findIncentiveRate.mockResolvedValue({
      id: 'ir_1',
      amount: new Decimal('2000.00'),
    });
    repository.createIncentive.mockImplementation(async (d: Record<string, unknown>) => ({
      id: 'inc_1',
      status: 'PENDING_VERIFICATION',
      ...d,
    }));
  });

  /* Earned when the work happens, paid when a person has checked it. */
  it('records an incentive without paying it', async () => {
    const row = await recordIncentive(
      { agentId: 'agt_1', event: 'PUBLISHER_ONBOARDED', tier: 'BRONZE' },
      NOW
    );
    expect(row.status).toBe('PENDING_VERIFICATION');
    expect(wallets.move).not.toHaveBeenCalled();
  });

  /* Lot F (E7-1): the agent sees the record as a modal — event, amount, the
     party, the campaign when it was an assist — for the three onboarding and
     assist events, and for nothing else. */
  it('tells the agent, in-app, when a CAMPAIGN_ASSIST / ADVERTISER_ONBOARDED / PUBLISHER_ONBOARDED incentive is recorded', async () => {
    repository.findIncentiveRecipient.mockResolvedValue({ userId: 'usr_agent' });
    await recordIncentive(
      { agentId: 'agt_1', event: 'CAMPAIGN_ASSIST', tier: 'BRONZE', advertiserId: 'adv_1', note: 'CMP-1', notice: { campaignId: 'cmp_1', partyName: 'Third Wave Coffee' } },
      NOW
    );
    expect(repository.findIncentiveRecipient).toHaveBeenCalledWith('agt_1');
    expect(notifications.createNotification).toHaveBeenCalledWith({
      userId: 'usr_agent',
      type: 'PAYOUT',
      title: 'Campaign assist: ₹2000.00 recorded',
      subtitle: '₹2000.00',
      message: expect.stringContaining('Third Wave Coffee'),
      suggestedAction: 'View earnings',
      relatedId: 'cmp_1',
      // E9: the modal's facts ride the row, and the tap opens the campaign.
      relatedType: 'CAMPAIGN',
      payload: { event: 'CAMPAIGN_ASSIST', amount: '2000.00', campaignId: 'cmp_1', partyName: 'Third Wave Coffee' },
    });
    expect((notifications.createNotification.mock.calls[0]![0] as { message: string }).message).toContain('INCENTIVE_RECORDED:CAMPAIGN_ASSIST');

    notifications.createNotification.mockClear();
    await recordIncentive({ agentId: 'agt_1', event: 'PUBLISHER_ONBOARDED', tier: 'BRONZE', publisherId: 'pub_1', notice: { partyName: 'Asha Rao' } }, NOW);
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'Publisher onboarded: ₹2000.00 recorded', relatedId: 'pub_1', message: expect.stringContaining('Asha Rao') }));

    notifications.createNotification.mockClear();
    await recordIncentive({ agentId: 'agt_1', event: 'ADVERTISER_ONBOARDED', tier: 'BRONZE', advertiserId: 'adv_1', note: 'Onboarded ADV-1: Meera S' }, NOW);
    // No name given: the note stands in.
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ relatedId: 'adv_1', message: expect.stringContaining('Onboarded ADV-1: Meera S') }));

    // Any other event is recorded silently — the frames draw no modal for it.
    notifications.createNotification.mockClear();
    await recordIncentive({ agentId: 'agt_1', event: 'SITE_VISIT', tier: 'BRONZE' }, NOW);
    await recordIncentive({ agentId: 'agt_1', event: 'INSTALLATION', tier: 'BRONZE', orderId: 'ord_1' }, NOW);
    expect(notifications.createNotification).not.toHaveBeenCalled();

    // No login behind the profile, or a feed that is down: the record stands.
    repository.findIncentiveRecipient.mockResolvedValueOnce(null);
    await expect(recordIncentive({ agentId: 'agt_1', event: 'PUBLISHER_ONBOARDED', tier: 'BRONZE' }, NOW)).resolves.toMatchObject({ id: 'inc_1' });
    expect(notifications.createNotification).not.toHaveBeenCalled();
    notifications.createNotification.mockRejectedValueOnce(new Error('feed down'));
    await expect(recordIncentive({ agentId: 'agt_1', event: 'PUBLISHER_ONBOARDED', tier: 'BRONZE' }, NOW)).resolves.toMatchObject({ id: 'inc_1' });
  });

  it('copies the rate in force, so a promotion cannot re-rate past work', async () => {
    await recordIncentive({ agentId: 'agt_1', event: 'SITE_VISIT', tier: 'SILVER' }, NOW);
    const created = repository.createIncentive.mock.calls[0]![0];
    expect(created.rateId).toBe('ir_1');
    expect(created.tier).toBe('SILVER');
    expect(created.amount).toEqual(new Decimal('2000.00'));
  });

  it('credits the wallet only when ops verifies it', async () => {
    repository.findIncentive.mockResolvedValue({
      id: 'inc_1',
      agentId: 'agt_1',
      event: 'SITE_VISIT',
      status: 'PENDING_VERIFICATION',
      amount: new Decimal('500.00'),
      taxWithheld: new Decimal('0.00'),
      netAmount: new Decimal('500.00'),
      orderId: null,
    });
    repository.updateIncentive.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    }));

    await creditIncentive('inc_1', { byUserId: 'usr_admin' }, NOW);
    expect(wallets.move).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '500.00', idempotencyKey: 'incentive:inc_1' })
    );
    expect(repository.updateIncentive).toHaveBeenCalledWith(
      'inc_1',
      expect.objectContaining({ status: 'CREDITED', verifiedByUserId: 'usr_admin' })
    );
  });

  it('credits once however many times Verify is pressed', async () => {
    repository.findIncentive.mockResolvedValue({ id: 'inc_1', status: 'CREDITED' });
    await creditIncentive('inc_1', { byUserId: 'usr_admin' }, NOW);
    expect(wallets.move).not.toHaveBeenCalled();
  });
});

describe('D5: a method recorded on a party behalf', () => {
  it('names whose it is beside the usual fields, which the method schema then ignores', async () => {
    const { addMethodSchema, onBehalfSchema } = await import('../payouts.schema');
    expect(onBehalfSchema.safeParse({ type: 'BANK' }).success).toBe(false);
    expect(onBehalfSchema.parse({ userId: 'usr_agent', type: 'BANK' })).toEqual({ userId: 'usr_agent' });
    expect(
      addMethodSchema.parse({
        userId: 'usr_agent',
        type: 'BANK',
        accountHolder: 'Rahul Kumar',
        bankName: 'SBI',
        accountNumber: '12345678901',
        ifscCode: 'SBIN0001234',
      })
    ).not.toHaveProperty('userId');
  });
});

/* ── Lot J2 (f): GET /payouts/wallet for a publisher who has never earned ── */

describe('the wallet read opens a publisher wallet on first read', () => {
  it('answers the wallet that exists, whichever party', async () => {
    repository.findWalletForUser.mockResolvedValue({ id: 'wal_agt', kind: 'AGENT' });
    expect(await walletForUserOrOpen('usr_agt')).toEqual({ id: 'wal_agt', kind: 'AGENT' });
    expect(wallets.ensureWallet).not.toHaveBeenCalled();
  });

  it('opens a publisher wallet — a zero snapshot, not a 404 — when the login is a publisher with none yet', async () => {
    repository.findWalletForUser.mockResolvedValue(null);
    repository.findPublisherIdForUser.mockResolvedValue('pub_new');
    wallets.ensureWallet.mockResolvedValue({ id: 'wal_opened', publisherId: 'pub_new' });
    expect(await walletForUserOrOpen('usr_pub')).toEqual({ id: 'wal_opened', kind: 'PUBLISHER' });
    expect(wallets.ensureWallet).toHaveBeenCalledWith({ kind: 'PUBLISHER', id: 'pub_new' }, 'Publisher wallet');
  });

  it('opens nothing for a login that is not a publisher — an agent or a partner earns first', async () => {
    repository.findWalletForUser.mockResolvedValue(null);
    repository.findPublisherIdForUser.mockResolvedValue(null);
    expect(await walletForUserOrOpen('usr_agt')).toBeNull();
    expect(wallets.ensureWallet).not.toHaveBeenCalled();
  });
});
