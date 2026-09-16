import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Payout batches — Lot B (Q85/Q140).
 *
 * The rule under test is the timing: approval reserves, release debits. A
 * batch is built from reserved lines, signed off by a second admin, and only
 * at release does each line's wallet debit and PAYOUT legs post — one
 * idempotent movement per line, so a batch that fails half-way reverses
 * nothing and a retried release pays nobody twice.
 *
 * The repository is a small in-memory fake rather than a chain of
 * mockResolvedValue calls, because the service reads the batch back after
 * every write and the assertions are about where the rows end up.
 */

const NOW = new Date('2026-09-12T10:00:00Z');

type Row = Record<string, any>;

const { fake, repository, wallets, ledger, uploads, appConfig } = vi.hoisted(() => {
  const fake = { batches: new Map<string, Row>(), withdrawals: new Map<string, Row>(), bankAccounts: new Map<string, Row>(), parties: new Map<string, Row>() };
  const lines = (batchId: string) => [...fake.withdrawals.values()].filter((w) => w.batchId === batchId);
  const repository = {
    findPartyContext: vi.fn(async (walletId: string) => fake.parties.get(walletId) ?? null),
    findWithdrawal: vi.fn(async (id: string) => fake.withdrawals.get(id) ?? null),
    findWithdrawals: vi.fn(async (ids: string[]) => ids.map((id) => fake.withdrawals.get(id)).filter(Boolean)),
    updateWithdrawal: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.withdrawals.get(id), ...patch };
      fake.withdrawals.set(id, next);
      return next;
    }),
    createBatch: vi.fn(async (data: Row) => {
      const row = { id: `bat_${fake.batches.size + 1}`, status: 'DRAFT', lineCount: 0, totalNet: new Decimal(0), exportFileId: null, approvedByUserId: null, createdAt: NOW, ...data };
      fake.batches.set(row.id, row);
      return row;
    }),
    findBatch: vi.fn(async (id: string) => {
      const batch = fake.batches.get(id);
      if (!batch) return null;
      return { ...batch, lines: lines(id), bankAccount: batch.bankAccountId ? fake.bankAccounts.get(batch.bankAccountId) ?? null : null };
    }),
    updateBatch: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.batches.get(id), ...patch };
      fake.batches.set(id, next);
      return next;
    }),
    listBatches: vi.fn(),
    batchReferenceExists: vi.fn(async () => false),
    countBatchesForYear: vi.fn(async () => 0),
    setBatchLines: vi.fn(async (batchId: string, attach: string[], detach: string[]) => {
      for (const id of detach) fake.withdrawals.set(id, { ...fake.withdrawals.get(id), batchId: null });
      for (const id of attach) fake.withdrawals.set(id, { ...fake.withdrawals.get(id), batchId });
      return repository.recountBatch(batchId);
    }),
    recountBatch: vi.fn(async (batchId: string) => {
      const rows = lines(batchId);
      const totalNet = rows.reduce((sum, row) => sum.plus(row.netAmount), new Decimal(0));
      return repository.updateBatch(batchId, { lineCount: rows.length, totalNet });
    }),
    tallyBatchLines: vi.fn(async (batchId: string) => {
      const tally = new Map<string, number>();
      for (const row of lines(batchId)) tally.set(row.status, (tally.get(row.status) ?? 0) + 1);
      return [...tally.entries()].map(([status, count]) => ({ status, count }));
    }),
    listBankAccounts: vi.fn(async () => [...fake.bankAccounts.values()]),
    findBankAccount: vi.fn(async (id: string) => fake.bankAccounts.get(id) ?? null),
    createBankAccount: vi.fn(),
    updateBankAccount: vi.fn(),
  };
  return {
    fake,
    repository,
    wallets: { move: vi.fn(), snapshot: vi.fn() },
    ledger: { platformAccount: vi.fn(), post: vi.fn(), verifyLedger: vi.fn() },
    uploads: { storeGeneratedFile: vi.fn() },
    appConfig: {
      getPlatformSettings: vi.fn(async () => ({
        finance: { primaryRail: 'MANUAL_NEFT', railFallbackOrder: ['RAZORPAY_X', 'CASHFREE', 'MANUAL_NEFT'], payoutEtaHours: 48, clearingDays: 7 },
      })),
    },
  };
});

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ledger);
vi.mock('../../uploads', () => uploads);
vi.mock('../../app-config', () => appConfig);
// Lot E1/F: the dispatcher behind the payout-paid and incentive notices — never the wire in a unit test.
vi.mock('../../notifications', () => ({ notify: vi.fn(async () => ({ notificationId: null, templateKey: null, deliveries: [] })), createNotification: vi.fn(async () => ({ id: 'ntf' })) }));

import { CLOSURE_WITHDRAWAL_MARKER } from '../payouts.service';
import {
  approveBatch,
  buildBatchCsv,
  cancelBatch,
  createBatch,
  deriveBatchStatus,
  failBatchLine,
  markBatchLinePaid,
  preflightBatch,
  releaseBatch,
  setBatchLines,
  submitBatch,
} from '../batches.service';

const method = (over: Row = {}) => ({
  id: 'pm_1',
  userId: 'usr_1',
  type: 'BANK',
  accountHolder: 'Sharma Hoardings',
  bankName: 'HDFC',
  accountNumber: '000123453310',
  ifscCode: 'HDFC0001234',
  upiVpa: null,
  status: 'VERIFIED',
  ...over,
});

const party = (walletId: string, over: Row = {}) => ({
  kind: 'PUBLISHER',
  entityId: 'pub_1',
  walletId,
  userId: 'usr_1',
  name: 'Sharma Hoardings',
  onboardedAt: new Date('2026-01-09T00:00:00Z'),
  sizeBand: 'INDIVIDUAL',
  tier: null,
  kycStatus: 'VERIFIED',
  userActive: true,
  email: 'sharma@example.com',
  mobile: '9876543210',
  ...over,
});

const line = (id: string, over: Row = {}) => ({
  id,
  reference: `WDR-2026-${id.slice(-3).padStart(6, '0')}`,
  walletId: `wal_${id}`,
  status: 'APPROVED',
  reservedAt: NOW,
  batchId: null,
  amount: new Decimal('5000.00'),
  netAmount: new Decimal('5000.00'),
  taxWithheld: new Decimal(0),
  decisionNote: null,
  rail: 'MANUAL_NEFT',
  railReference: null,
  payoutMethod: method(),
  wallet: { id: `wal_${id}`, publisherId: 'pub_1', agentId: null, advertiserId: null, publisher: { name: 'Sharma Hoardings' } },
  ...over,
});

const balances = (over: Row = {}) => ({
  balance: '40000.00',
  goodwill: '0.00',
  spendable: '35000.00',
  pendingClearance: '0.00',
  held: '0.00',
  openWithdrawals: '5000.00',
  withdrawable: '35000.00',
  frozenAt: null,
  frozenReason: null,
  ...over,
});

/** A DRAFT batch with two reserved lines, ready to submit. */
async function draftWithLines() {
  const batch = await createBatch({ byUserId: 'usr_maker' }, NOW);
  await setBatchLines(batch.id, ['wdr_101', 'wdr_102'], NOW);
  return batch.id;
}

async function approvedBatch() {
  const id = await draftWithLines();
  await submitBatch(id, 'usr_maker', NOW);
  await approveBatch(id, 'usr_checker', NOW);
  return id;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['RAZORPAY_X_KEY'];
  fake.batches.clear();
  fake.withdrawals.clear();
  fake.bankAccounts.clear();
  fake.parties.clear();
  for (const id of ['wdr_101', 'wdr_102', 'wdr_103']) {
    fake.withdrawals.set(id, line(id));
    fake.parties.set(`wal_${id}`, party(`wal_${id}`));
  }
  fake.bankAccounts.set('bank_1', { id: 'bank_1', label: 'HDFC current', bankName: 'HDFC', accountNumberMasked: '•••• 4321', ifsc: 'HDFC0000001', isActive: true, isDefault: true });
  repository.countBatchesForYear.mockResolvedValue(0);
  wallets.snapshot.mockResolvedValue(balances());
  wallets.move.mockResolvedValue({ entry: { id: 'we_1' }, ledgerTransactionId: 'ltx_debit', created: true });
  ledger.platformAccount.mockImplementation(async (code: string) => ({ id: `acc_${code}` }));
  ledger.post.mockResolvedValue({ transaction: { id: 'ltx_paid' }, created: true });
  ledger.verifyLedger.mockResolvedValue({ healthy: true, unbalanced: [], drift: [] });
  uploads.storeGeneratedFile.mockResolvedValue({ id: 'file_export', url: 'http://x/payout-exports/BATCH.csv' });
});

describe('building a batch', () => {
  it('mints BATCH-<year>-<n> and starts DRAFT on the platform rail', async () => {
    repository.countBatchesForYear.mockResolvedValue(11);
    const batch = await createBatch({ byUserId: 'usr_maker', bankAccountId: 'bank_1' }, NOW);
    expect(batch.reference).toBe('BATCH-2026-000012');
    expect(batch.status).toBe('DRAFT');
    expect(batch.rail).toBe('MANUAL_NEFT');
    expect(batch.bankAccountId).toBe('bank_1');
  });

  it('refuses a bank account it does not know or that is switched off', async () => {
    await expect(createBatch({ byUserId: 'usr_maker', bankAccountId: 'bank_x' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    fake.bankAccounts.set('bank_1', { ...fake.bankAccounts.get('bank_1'), isActive: false });
    await expect(createBatch({ byUserId: 'usr_maker', bankAccountId: 'bank_1' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('takes only APPROVED lines with a VERIFIED method that are in no other open batch', async () => {
    fake.withdrawals.set('wdr_201', line('wdr_201', { status: 'REQUESTED' }));
    fake.withdrawals.set('wdr_202', line('wdr_202', { payoutMethod: method({ status: 'PENDING_VERIFICATION' }) }));
    fake.withdrawals.set('wdr_203', line('wdr_203', { batchId: 'bat_other' }));
    fake.batches.set('bat_other', { id: 'bat_other', status: 'IN_REVIEW' });
    const batch = await createBatch({ byUserId: 'usr_maker' }, NOW);

    for (const bad of ['wdr_201', 'wdr_202', 'wdr_203', 'wdr_missing']) {
      await expect(setBatchLines(batch.id, ['wdr_101', bad], NOW)).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(fake.withdrawals.get('wdr_101')!.batchId).toBeNull();
  });

  it('replaces the line set and recounts the header', async () => {
    const batch = await createBatch({ byUserId: 'usr_maker' }, NOW);
    let view = await setBatchLines(batch.id, ['wdr_101', 'wdr_102'], NOW);
    expect(view.lineCount).toBe(2);
    expect(view.totalNet.toFixed(2)).toBe('10000.00');

    view = await setBatchLines(batch.id, ['wdr_102', 'wdr_103'], NOW);
    expect(repository.setBatchLines).toHaveBeenLastCalledWith(batch.id, ['wdr_103'], ['wdr_101']);
    expect(view.lineCount).toBe(2);
    expect(fake.withdrawals.get('wdr_101')!.batchId).toBeNull();
    expect(fake.withdrawals.get('wdr_101')!.status).toBe('APPROVED');
  });

  it('only edits the lines of a DRAFT', async () => {
    const id = await draftWithLines();
    await submitBatch(id, 'usr_maker', NOW);
    await expect(setBatchLines(id, ['wdr_103'], NOW)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('four eyes', () => {
  it('will not submit an empty batch', async () => {
    const batch = await createBatch({ byUserId: 'usr_maker' }, NOW);
    await expect(submitBatch(batch.id, 'usr_maker', NOW)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('moves DRAFT to IN_REVIEW and IN_REVIEW to APPROVED by a different admin', async () => {
    const id = await draftWithLines();
    expect((await submitBatch(id, 'usr_maker', NOW)).status).toBe('IN_REVIEW');
    const approved = await approveBatch(id, 'usr_checker', NOW);
    expect(approved).toMatchObject({ status: 'APPROVED', approvedByUserId: 'usr_checker', approvedAt: NOW });
  });

  it('refuses 409 FOUR_EYES when the maker tries to approve their own batch', async () => {
    const id = await draftWithLines();
    await submitBatch(id, 'usr_maker', NOW);
    await expect(approveBatch(id, 'usr_maker', NOW)).rejects.toMatchObject({ statusCode: 409, code: 'FOUR_EYES' });
  });

  it('approves only what is in review', async () => {
    const id = await draftWithLines();
    await expect(approveBatch(id, 'usr_checker', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('preflight', () => {
  it('names every problem per line, and the rail and the books once', async () => {
    const id = await draftWithLines();
    fake.withdrawals.set('wdr_102', line('wdr_102', { batchId: id, payoutMethod: method({ status: 'PENDING_VERIFICATION' }), decisionNote: null }));
    fake.parties.set('wal_wdr_102', party('wal_wdr_102', { kycStatus: 'PENDING', userActive: false }));
    wallets.snapshot.mockImplementation(async (walletId: string) =>
      walletId === 'wal_wdr_102' ? balances({ balance: '1000.00', openWithdrawals: '5000.00', frozenAt: NOW, frozenReason: 'Review' }) : balances()
    );
    ledger.verifyLedger.mockResolvedValue({ healthy: false, unbalanced: [], drift: [{ walletId: 'wal_x' }] });

    const report = await preflightBatch(id, NOW);
    expect(report.ok).toBe(false);
    expect(report.rail).toEqual({ name: 'MANUAL_NEFT', configured: true });
    expect(report.ledgerHealthy).toBe(false);
    const good = report.lines.find((row) => row.withdrawalId === 'wdr_101')!;
    const bad = report.lines.find((row) => row.withdrawalId === 'wdr_102')!;
    expect(good.problems).toEqual([]);
    expect(bad.problems).toEqual(
      expect.arrayContaining(['METHOD_NOT_VERIFIED', 'KYC_NOT_VERIFIED', 'WALLET_SHORT', 'USER_INACTIVE', 'WALLET_FROZEN'])
    );
  });

  it('lets the closure’s own final payout through a frozen wallet', async () => {
    const id = await draftWithLines();
    fake.withdrawals.set('wdr_101', line('wdr_101', { batchId: id, decisionNote: CLOSURE_WITHDRAWAL_MARKER }));
    wallets.snapshot.mockResolvedValue(balances({ frozenAt: NOW, frozenReason: 'Closed' }));
    const report = await preflightBatch(id, NOW);
    expect(report.lines.find((row) => row.withdrawalId === 'wdr_101')!.problems).toEqual([]);
    expect(report.lines.find((row) => row.withdrawalId === 'wdr_102')!.problems).toEqual(['WALLET_FROZEN']);
  });
});

describe('release on the manual rail', () => {
  it('debits each line, posts its PAYOUT legs, writes the bank file and sets the lines PROCESSING', async () => {
    const id = await approvedBatch();
    const result = await releaseBatch(id, 'usr_checker', NOW);

    expect(wallets.move).toHaveBeenCalledTimes(2);
    const movement = wallets.move.mock.calls[0]![0];
    expect(movement).toMatchObject({
      walletId: 'wal_wdr_101',
      amount: '-5000.00',
      entryType: 'PAYOUT',
      ledgerKind: 'PAYOUT',
      idempotencyKey: 'withdrawal:wdr_101',
      createdByUserId: 'usr_checker',
    });
    expect(movement.counterLegs).toEqual([expect.objectContaining({ accountCode: 'platform:payables', amount: '5000.00' })]);

    for (const lineId of ['wdr_101', 'wdr_102']) {
      expect(fake.withdrawals.get(lineId)).toMatchObject({ status: 'PROCESSING', rail: 'MANUAL_NEFT', ledgerTransactionId: 'ltx_debit', batchId: id });
    }
    expect(uploads.storeGeneratedFile).toHaveBeenCalledWith(
      'usr_checker',
      expect.objectContaining({ purpose: 'PAYOUT_EXPORT', mimeType: 'text/csv', filename: 'BATCH-2026-000001.csv' })
    );
    expect(result.batch).toMatchObject({ status: 'RELEASED', releasedAt: NOW, exportFileId: 'file_export' });
    expect(result.released).toBe(2);
  });

  it('writes the bank bulk-transfer columns, narration = the WDR reference', async () => {
    const id = await approvedBatch();
    const view = await repository.findBatch(id);
    const csv = await buildBatchCsv(view as never);
    const [header, first] = csv.split('\r\n');
    expect(header).toBe('Beneficiary Name,Account Number,IFSC,Amount,Narration,Email,Mobile');
    expect(first).toBe('Sharma Hoardings,000123453310,HDFC0001234,5000.00,WDR-2026-000101,sharma@example.com,9876543210');
  });

  it('refuses to release when the preflight finds a problem, and moves nothing', async () => {
    const id = await approvedBatch();
    fake.withdrawals.set('wdr_102', line('wdr_102', { batchId: id, payoutMethod: method({ status: 'REJECTED' }) }));
    await expect(releaseBatch(id, 'usr_checker', NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect(wallets.move).not.toHaveBeenCalled();
    expect(fake.batches.get(id)!.status).toBe('APPROVED');
  });

  it('passes the freeze for the closure’s final payout only', async () => {
    const id = await approvedBatch();
    fake.withdrawals.set('wdr_101', line('wdr_101', { batchId: id, decisionNote: CLOSURE_WITHDRAWAL_MARKER }));
    await releaseBatch(id, 'usr_checker', NOW);
    const byWallet = Object.fromEntries(wallets.move.mock.calls.map((call) => [call[0].walletId, call[0].allowFrozen]));
    expect(byWallet).toEqual({ wal_wdr_101: true, wal_wdr_102: false });
  });

  it('releases only from APPROVED, and a retry skips lines already released', async () => {
    const id = await draftWithLines();
    await expect(releaseBatch(id, 'usr_checker', NOW)).rejects.toMatchObject({ statusCode: 409 });
    await submitBatch(id, 'usr_maker', NOW);
    await approveBatch(id, 'usr_checker', NOW);
    await releaseBatch(id, 'usr_checker', NOW);
    // Simulate a half-done release: the batch is RELEASING and one line is out.
    await repository.updateBatch(id, { status: 'RELEASING' });
    await repository.updateWithdrawal('wdr_102', { status: 'APPROVED', ledgerTransactionId: null });
    wallets.move.mockClear();
    await releaseBatch(id, 'usr_checker', NOW);
    expect(wallets.move).toHaveBeenCalledTimes(1);
    expect(wallets.move.mock.calls[0]![0].walletId).toBe('wal_wdr_102');
  });
});

describe('release on a vendor rail', () => {
  it('pays line by line and reverses a line the rail refuses', async () => {
    process.env['RAZORPAY_X_KEY'] = 'set-for-test';
    const id = await draftWithLines();
    await repository.updateBatch(id, { rail: 'RAZORPAY_X' });
    await submitBatch(id, 'usr_maker', NOW);
    await approveBatch(id, 'usr_checker', NOW);

    const result = await releaseBatch(id, 'usr_checker', NOW);

    // The registered-but-unconfigured vendor answers FAILED for every line:
    // the debit posts, then its mirror, and the line ends FAILED.
    expect(result.failed).toBe(2);
    const keys = wallets.move.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys).toEqual(['withdrawal:wdr_101', 'withdrawal-failed:wdr_101', 'withdrawal:wdr_102', 'withdrawal-failed:wdr_102']);
    expect(fake.withdrawals.get('wdr_101')).toMatchObject({ status: 'FAILED', rail: 'RAZORPAY_X' });
    expect(result.batch.status).toBe('FAILED');
    expect(uploads.storeGeneratedFile).not.toHaveBeenCalled();
  });
});

describe('after release', () => {
  it('marks a line paid with its UTR and completes the batch when every line is paid', async () => {
    const id = await approvedBatch();
    await releaseBatch(id, 'usr_checker', NOW);
    wallets.move.mockClear();

    const first = await markBatchLinePaid(id, 'wdr_101', { utr: 'UTR001', byUserId: 'usr_finance' }, NOW);
    expect(first.line).toMatchObject({ status: 'PAID', railReference: 'UTR001' });
    expect(first.batch.status).toBe('RELEASED');
    expect(ledger.post).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'withdrawal-paid:wdr_101' }), NOW);
    // Already debited at release — no second wallet movement.
    expect(wallets.move).not.toHaveBeenCalled();

    const second = await markBatchLinePaid(id, 'wdr_102', { utr: 'UTR002', byUserId: 'usr_finance' }, NOW);
    expect(second.batch).toMatchObject({ status: 'COMPLETED', completedAt: NOW });
  });

  it('fails a line by reversing its legs and marks the batch partially failed', async () => {
    const id = await approvedBatch();
    await releaseBatch(id, 'usr_checker', NOW);
    await markBatchLinePaid(id, 'wdr_101', { utr: 'UTR001', byUserId: 'usr_finance' }, NOW);
    wallets.move.mockClear();

    const result = await failBatchLine(id, 'wdr_102', { reason: 'Account closed', byUserId: 'usr_finance' }, NOW);
    expect(wallets.move).toHaveBeenCalledWith(expect.objectContaining({ amount: '5000.00', idempotencyKey: 'withdrawal-failed:wdr_102' }));
    expect(result.line.status).toBe('FAILED');
    expect(result.batch.status).toBe('PARTIALLY_FAILED');
  });

  it('refuses a line that is not in this batch', async () => {
    const id = await approvedBatch();
    await releaseBatch(id, 'usr_checker', NOW);
    await expect(markBatchLinePaid(id, 'wdr_103', { utr: 'UTR', byUserId: 'a' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('derives the batch status from its lines', () => {
    expect(deriveBatchStatus([{ status: 'PAID', count: 2 }])).toBe('COMPLETED');
    expect(deriveBatchStatus([{ status: 'FAILED', count: 2 }])).toBe('FAILED');
    expect(deriveBatchStatus([{ status: 'PAID', count: 1 }, { status: 'FAILED', count: 1 }])).toBe('PARTIALLY_FAILED');
    expect(deriveBatchStatus([{ status: 'PAID', count: 1 }, { status: 'PROCESSING', count: 1 }])).toBe('RELEASED');
    expect(deriveBatchStatus([{ status: 'PROCESSING', count: 1 }, { status: 'FAILED', count: 1 }])).toBe('RELEASED');
  });
});

describe('cancelling', () => {
  it('returns the lines to APPROVED-reserved and unbatched, before release only', async () => {
    const id = await approvedBatch();
    const cancelled = await cancelBatch(id, 'usr_checker', NOW);
    expect(cancelled.status).toBe('CANCELLED');
    for (const lineId of ['wdr_101', 'wdr_102']) {
      expect(fake.withdrawals.get(lineId)).toMatchObject({ status: 'APPROVED', reservedAt: NOW, batchId: null });
    }
    expect(wallets.move).not.toHaveBeenCalled();
  });

  it('cannot cancel a batch that has released', async () => {
    const id = await approvedBatch();
    await releaseBatch(id, 'usr_checker', NOW);
    await expect(cancelBatch(id, 'usr_checker', NOW)).rejects.toMatchObject({ statusCode: 409 });
  });
});
