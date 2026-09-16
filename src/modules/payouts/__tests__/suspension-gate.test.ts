import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot A where the money leaves, and where it is earned.
 *
 * STOP_ACCRUAL: a suspended spot earns nothing for the days it is suspended,
 * and — because the run is keyed on (spot, day) and simply never writes those
 * days — it does not quietly earn them later either.
 *
 * FREEZE_WALLET: no withdrawal is raised and none is approved. Both are
 * checked, because a request raised before the freeze must not walk through
 * approval afterwards.
 */

const { repository, wallets, rules } = vi.hoisted(() => ({
  repository: {
    findAccruableSpots: vi.fn(),
    findAccruedDates: vi.fn(),
    createAccrual: vi.fn(),
    findPartyContext: vi.fn(),
    findMethod: vi.fn(),
    listLimits: vi.fn(),
    sumForDay: vi.fn(),
    findWithdrawal: vi.fn(),
    updateWithdrawal: vi.fn(),
    createWithdrawal: vi.fn(),
    countForYear: vi.fn(),
    referenceExists: vi.fn(),
  },
  wallets: { ensureWallet: vi.fn(), move: vi.fn(), snapshot: vi.fn() },
  rules: { withholdingFor: vi.fn(), dailyCapFor: vi.fn() },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => wallets);
// Lot E1/F: the dispatcher behind the payout-paid and incentive notices — never the wire in a unit test.
vi.mock('../../notifications', () => ({ notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })), createNotification: vi.fn(async () => ({ id: 'ntf' })) }));
vi.mock('../../app-config', () => ({
  getPlatformSettings: vi.fn(async () => ({
    finance: { primaryRail: 'MANUAL_NEFT', railFallbackOrder: ['RAZORPAY_X', 'CASHFREE', 'MANUAL_NEFT'], payoutEtaHours: 48, clearingDays: 7 },
  })),
}));
vi.mock('../rules.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rules.service')>();
  return { ...actual, ...rules };
});

import { runDailyAccrual } from '../accrual.service';
import { approveWithdrawal, requestWithdrawal, withdrawalAllowance } from '../payouts.service';

const NOW = new Date('2026-09-12T10:00:00Z');

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'spt_1',
  ratePerDay: new Decimal('1000.00'),
  quantity: 1,
  commissionPct: new Decimal('0.1500'),
  commissionSource: 'PLATFORM_DEFAULT',
  orderId: 'ord_1',
  campaign: { id: 'cmp_1', startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2026-09-30T00:00:00Z') },
  listing: { id: 'lst_1', publisherId: 'pub_1', title: 'Lift lobby panel', suspensionScopes: [] },
  ...over,
});

const balances = (over: Record<string, unknown> = {}) => ({
  walletId: 'wal_1',
  balance: '10000.00',
  goodwill: '0.00',
  spendable: '10000.00',
  pendingClearance: '0.00',
  held: '0.00',
  openWithdrawals: '0.00',
  withdrawable: '10000.00',
  lastActivityAt: NOW,
  frozenAt: null,
  frozenReason: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAccruedDates.mockResolvedValue([]);
  repository.createAccrual.mockResolvedValue({ id: 'acr_1' });
  repository.findPartyContext.mockResolvedValue({
    kind: 'PUBLISHER',
    entityId: 'pub_1',
    walletId: 'wal_1',
    userId: 'usr_1',
    name: 'Sharma Hoardings',
    onboardedAt: new Date('2026-01-01T00:00:00Z'),
    sizeBand: 'INDIVIDUAL',
    tier: null,
  });
  repository.findMethod.mockResolvedValue({ id: 'pm_1', userId: 'usr_1', status: 'VERIFIED' });
  repository.sumForDay.mockResolvedValue('0.00');
  repository.findWithdrawal.mockResolvedValue({
    id: 'wdr_1',
    reference: 'WDR-2026-000001',
    walletId: 'wal_1',
    amount: new Decimal('1000.00'),
    status: 'REQUESTED',
  });
  rules.withholdingFor.mockResolvedValue({ ratePct: '0.00', section: null });
  rules.dailyCapFor.mockResolvedValue({ cap: '25000.00', months: 8, nextRung: null });
  wallets.ensureWallet.mockResolvedValue({ id: 'wal_1' });
  wallets.move.mockResolvedValue({ entry: { id: 'ent_1' }, ledgerTransactionId: 'ltx_1', created: true });
  wallets.snapshot.mockResolvedValue(balances());
});

describe('STOP_ACCRUAL', () => {
  it('skips a suspended spot and credits nothing for it', async () => {
    repository.findAccruableSpots.mockResolvedValue([
      spot({ listing: { id: 'lst_1', publisherId: 'pub_1', title: 'A', suspensionScopes: ['STOP_ACCRUAL'] } }),
    ]);

    const run = await runDailyAccrual(NOW);

    expect(wallets.move).not.toHaveBeenCalled();
    expect(repository.createAccrual).not.toHaveBeenCalled();
    expect(run).toMatchObject({ daysCredited: 0, skipped: 1 });
  });

  it('keeps crediting every other spot in the same run', async () => {
    repository.findAccruableSpots.mockResolvedValue([
      spot({ id: 'spt_frozen', listing: { id: 'lst_1', publisherId: 'pub_1', title: 'A', suspensionScopes: ['STOP_ACCRUAL'] } }),
      spot({ id: 'spt_ok' }),
    ]);

    const run = await runDailyAccrual(NOW);

    expect(run.daysCredited).toBeGreaterThan(0);
    expect(wallets.move).toHaveBeenCalled();
    for (const call of wallets.move.mock.calls) {
      expect((call[0] as { reference: string }).reference).toBe('spt_ok');
    }
  });
});

describe('FREEZE_WALLET', () => {
  it('reports the freeze on the allowance, so the screen can say why', async () => {
    wallets.snapshot.mockResolvedValue(balances({ frozenAt: NOW, frozenReason: 'Fraud review' }));
    await expect(withdrawalAllowance('wal_1', NOW)).resolves.toMatchObject({ frozenAt: NOW });
  });

  it('refuses to raise a withdrawal', async () => {
    wallets.snapshot.mockResolvedValue(balances({ frozenAt: NOW, frozenReason: 'Fraud review' }));
    await expect(
      requestWithdrawal('wal_1', { amount: '1000.00', payoutMethodId: 'pm_1', userId: 'usr_1' }, NOW),
    ).rejects.toMatchObject({ statusCode: 409, code: 'WALLET_FROZEN' });
    expect(repository.createWithdrawal).not.toHaveBeenCalled();
  });

  it('refuses to approve one raised before the freeze', async () => {
    wallets.snapshot.mockResolvedValue(balances({ frozenAt: NOW, frozenReason: 'Fraud review' }));
    await expect(
      approveWithdrawal('wdr_1', { byUserId: 'usr_admin' }, NOW),
    ).rejects.toMatchObject({ statusCode: 409, code: 'WALLET_FROZEN' });
    expect(wallets.move).not.toHaveBeenCalled();
  });
});
