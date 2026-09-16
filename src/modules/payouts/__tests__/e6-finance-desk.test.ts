import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * E6: the finance-desk gaps the console reported — the withdrawal queue's
 * frozen flag and party filters, the summary totals, the batch actors, the
 * ledger's amount facet on the way through, and the on-behalf note landing
 * on the row rather than only in the audit.
 */

const { repository, wallets, ledger, ifsc, appConfig } = vi.hoisted(() => ({
  repository: {
    findPartyContext: vi.fn(),
    findMethodsForUser: vi.fn(),
    findMethod: vi.fn(),
    listLimits: vi.fn(),
    findTaxRate: vi.fn(),
    listTaxRates: vi.fn(),
    createWithdrawal: vi.fn(),
    listWithdrawals: vi.fn(),
    withdrawalSummary: vi.fn(),
    referenceExists: vi.fn(),
    countForYear: vi.fn(),
    sumForDay: vi.fn(),
    listIncentives: vi.fn(),
  },
  wallets: { ensureWallet: vi.fn(), move: vi.fn(), snapshot: vi.fn() },
  ledger: { platformAccount: vi.fn(), post: vi.fn(), verifyLedger: vi.fn() },
  ifsc: { lookupIfsc: vi.fn(), normaliseIfsc: (code: string) => code.trim().toUpperCase() },
  appConfig: {
    getPlatformSettings: vi.fn(async () => ({
      finance: { primaryRail: 'MANUAL_NEFT', railFallbackOrder: ['MANUAL_NEFT'], payoutEtaHours: 48, clearingDays: 7 },
    })),
  },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ledger);
vi.mock('../../../shared/integrations', () => ifsc);
vi.mock('../../app-config', () => appConfig);
// Lot E1/F: the dispatcher behind the payout-paid and incentive notices — never the wire in a unit test.
vi.mock('../../notifications', () => ({ notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })), createNotification: vi.fn(async () => ({ id: 'ntf' })) }));

import { listWithdrawals, requestWithdrawalOnBehalf, withdrawalSummary } from '../payouts.service';
import { listIncentives } from '../incentives.service';
import { shapeWithdrawal, withBatchActors } from '../payouts.shape';
import { registerPayoutUserLabelPort } from '../user-labels.port';
import { DEFAULT_LIMITS, resetRulesCache } from '../rules.service';

const NOW = new Date('2026-09-12T10:00:00Z');

const method = () => ({
  id: 'pm_1',
  userId: 'usr_1',
  type: 'BANK',
  accountHolder: 'Sharma Hoardings',
  bankName: 'HDFC',
  accountNumber: '000123453310',
  ifscCode: 'HDFC0001234',
  bankBranch: null,
  ifscVerifiedAt: null,
  upiVpa: null,
  isDefault: true,
  status: 'VERIFIED',
  verifiedVia: null,
  verifiedAt: null,
  nameMatchPct: null,
  rejectionReason: null,
  createdAt: NOW,
});

const withdrawal = (over: Record<string, unknown> = {}) =>
  ({
    id: 'wdr_1',
    reference: 'WDR-2026-000118',
    walletId: 'wal_1',
    amount: new Decimal('10000'),
    taxWithheld: new Decimal(0),
    netAmount: new Decimal('10000'),
    status: 'REQUESTED',
    requestedAt: NOW,
    decidedAt: null,
    decisionNote: null,
    reservedAt: null,
    batchId: null,
    rail: null,
    railReference: null,
    paidAt: null,
    failureReason: null,
    payoutMethod: method(),
    wallet: { id: 'wal_1', balance: new Decimal(0), goodwill: new Decimal(0), publisherId: 'pub_1', agentId: null, advertiserId: null, printPartnerId: null, frozenAt: null, publisher: { name: 'Sharma Hoardings' } },
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  resetRulesCache();
  repository.listLimits.mockResolvedValue(
    DEFAULT_LIMITS.map((limit, i) => ({ id: `lim_${i}`, band: limit.band, minMonths: limit.minMonths, dailyCap: new Decimal(limit.dailyCap), createdAt: NOW, updatedAt: NOW })),
  );
  repository.listTaxRates.mockResolvedValue([]);
  repository.findTaxRate.mockResolvedValue(null);
  repository.sumForDay.mockResolvedValue(new Decimal(0));
  repository.countForYear.mockResolvedValue(117);
  repository.referenceExists.mockResolvedValue(false);
  repository.findPartyContext.mockResolvedValue({
    kind: 'PRINT_PARTNER', entityId: 'prt_1', walletId: 'wal_prt', userId: 'usr_prt', name: 'Sri Prints',
    onboardedAt: new Date('2026-01-01T00:00:00Z'), sizeBand: 'INDIVIDUAL', tier: null,
  });
  repository.findMethodsForUser.mockResolvedValue([{ ...method(), id: 'pm_prt', userId: 'usr_prt' }]);
  repository.findMethod.mockResolvedValue({ ...method(), id: 'pm_prt', userId: 'usr_prt' });
  repository.createWithdrawal.mockImplementation(async (data: Record<string, unknown>) => withdrawal({ ...data, id: 'wdr_9' }));
  wallets.snapshot.mockResolvedValue({
    walletId: 'wal_prt', balance: '40000.00', goodwill: '0.00', spendable: '40000.00', pendingClearance: '0.00',
    held: '0.00', openWithdrawals: '0.00', withdrawable: '40000.00', lastActivityAt: NOW, frozenAt: null,
  });
});

describe('GET /finance/withdrawals', () => {
  it('says when the wallet behind a line is frozen', () => {
    expect(shapeWithdrawal(withdrawal()).walletFrozen).toBe(false);
    const frozen = { ...(withdrawal() as { wallet: Record<string, unknown> }).wallet, frozenAt: NOW };
    expect(shapeWithdrawal(withdrawal({ wallet: frozen })).walletFrozen).toBe(true);
  });

  it('passes the party and paid-window facets through to the repository', async () => {
    repository.listWithdrawals.mockResolvedValue([]);
    const paidFrom = new Date('2026-09-01T00:00:00Z');
    await listWithdrawals({ publisherId: 'pub_1', agentId: 'agt_1', walletId: 'wal_1', paidFrom, paidTo: NOW });
    expect(repository.listWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({ publisherId: 'pub_1', agentId: 'agt_1', walletId: 'wal_1', paidFrom, paidTo: NOW, limit: 50 }),
    );
  });
});

describe('GET /finance/withdrawals/summary', () => {
  it('carries the three totals as decimal strings, the month being the IST month', async () => {
    repository.withdrawalSummary.mockResolvedValue({
      counts: { REQUESTED: 2 },
      processingOver24h: 1,
      reservedTotal: new Decimal('15000'),
      processingTotal: new Decimal('4200.5'),
      paidThisMonth: new Decimal('99000'),
    });
    // 23:30 IST on 30 Sep is 18:00 UTC — still September in India.
    const summary = await withdrawalSummary(new Date('2026-09-30T18:00:00Z'));
    expect(summary).toMatchObject({ reservedTotal: '15000.00', processingTotal: '4200.50', paidThisMonth: '99000.00', processingOver24h: 1 });
    const [, month] = repository.withdrawalSummary.mock.calls[0]!;
    expect(month.start.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(month.end.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });
});

describe('POST /finance/withdrawals/on-behalf', () => {
  it('keeps the note ops typed on the row as decisionNote', async () => {
    await requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '8000.00', note: 'Job PJ-000012 settled by NEFT' }, NOW);
    expect(repository.createWithdrawal).toHaveBeenCalledWith(expect.objectContaining({ decisionNote: 'Job PJ-000012 settled by NEFT' }));
  });

  it('leaves decisionNote alone when no note was typed', async () => {
    await requestWithdrawalOnBehalf({ walletId: 'wal_prt', amount: '8000.00' }, NOW);
    expect(repository.createWithdrawal.mock.calls[0]![0]).not.toHaveProperty('decisionNote');
  });
});

describe('GET /finance/payout-batches', () => {
  it('names who built and approved each batch through the port', async () => {
    registerPayoutUserLabelPort(async (ids) => new Map(ids.map((id) => [id, { id, name: id === 'usr_a' ? 'Asha' : id === 'usr_b' ? 'Bala' : null }])));
    const rows = await withBatchActors([
      { id: 'bat_1', createdByUserId: 'usr_a', approvedByUserId: 'usr_b' },
      { id: 'bat_2', createdByUserId: 'usr_a', approvedByUserId: null },
      { id: 'bat_3', createdByUserId: 'ghost', approvedByUserId: null },
    ]);
    expect(rows[0]).toMatchObject({ createdBy: { id: 'usr_a', name: 'Asha' }, approvedBy: { id: 'usr_b', name: 'Bala' } });
    expect(rows[1]).toMatchObject({ createdBy: { id: 'usr_a', name: 'Asha' }, approvedBy: null });
    expect(rows[2]).toMatchObject({ createdBy: { id: 'ghost', name: null }, approvedBy: null });
  });
});

describe('GET /finance/incentives', () => {
  it('passes the event list and the search through', async () => {
    repository.listIncentives.mockResolvedValue([]);
    await listIncentives({ events: ['SITE_VISIT', 'INSTALLATION'], q: 'ord_9' });
    expect(repository.listIncentives).toHaveBeenCalledWith(expect.objectContaining({ events: ['SITE_VISIT', 'INSTALLATION'], q: 'ord_9' }));
  });
});
