import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Reconciliation — Lot B (Q85). A bank line is explained by one ADX record:
 * a paid withdrawal by UTR or by the WDR reference in the narration, a
 * recorded top-up by UTR, or — failing both — the one ledger transaction of
 * the right kind, amount and date. A line that is explained but disagrees on
 * the amount is DIFFERS, never silently MATCHED; a top-up matched by a bank
 * credit has its suspense settled into cash, and unmatching reverses that.
 */

const NOW = new Date('2026-09-12T10:00:00Z');
const DAY = (s: string) => new Date(`${s}T00:00:00Z`);

type Row = Record<string, any>;

const { fake, repository, payouts, advertisers, ledger, uploads } = vi.hoisted(() => {
  const fake = { lines: new Map<string, Row>(), matches: new Map<string, Row>(), imports: new Map<string, Row>(), profiles: new Map<string, Row>() };
  const withMatch = (line: Row) => ({ ...line, match: fake.matches.get(line.id) ?? null });
  const repository = {
    listProfiles: vi.fn(async () => [...fake.profiles.values()]),
    findProfile: vi.fn(async (id: string) => fake.profiles.get(id) ?? null),
    createProfile: vi.fn(async (data: Row) => {
      const row = { id: `prof_${fake.profiles.size + 1}`, ...data };
      fake.profiles.set(row.id, row);
      return row;
    }),
    createImport: vi.fn(async (data: Row) => {
      const row = { id: `imp_${fake.imports.size + 1}`, lineCount: 0, duplicateCount: 0, createdAt: NOW, ...data };
      fake.imports.set(row.id, row);
      return row;
    }),
    findImport: vi.fn(async (id: string) => fake.imports.get(id) ?? null),
    listImports: vi.fn(async () => [...fake.imports.values()]),
    addLines: vi.fn(async (importId: string, bankAccountId: string, lines: Row[]) => {
      let created = 0;
      for (const line of lines) {
        const dup = [...fake.lines.values()].some((row) => row.bankAccountId === bankAccountId && row.rawHash === line.rawHash);
        if (dup) continue;
        const id = `line_${fake.lines.size + 1}`;
        fake.lines.set(id, { id, importId, bankAccountId, matchStatus: 'UNMATCHED', ...line, amount: new Decimal(line.amount) });
        created += 1;
      }
      return { created, duplicates: lines.length - created };
    }),
    findLine: vi.fn(async (id: string) => (fake.lines.has(id) ? withMatch(fake.lines.get(id)!) : null)),
    listLines: vi.fn(),
    listUnmatched: vi.fn(async () => [...fake.lines.values()].filter((row) => row.matchStatus === 'UNMATCHED').map(withMatch)),
    setLineStatus: vi.fn(async (id: string, status: string) => {
      const next = { ...fake.lines.get(id), matchStatus: status };
      fake.lines.set(id, next);
      return withMatch(next);
    }),
    createMatch: vi.fn(async (data: Row) => {
      const row = { id: `match_${fake.matches.size + 1}`, ...data };
      fake.matches.set(data.lineId, row);
      return row;
    }),
    updateMatch: vi.fn(async (id: string, patch: Row) => {
      const entry = [...fake.matches.entries()].find(([, row]) => row.id === id)!;
      const next = { ...entry[1], ...patch };
      fake.matches.set(entry[0], next);
      return next;
    }),
    deleteMatch: vi.fn(async (lineId: string) => {
      fake.matches.delete(lineId);
    }),
    claimedLedgerTransactionIds: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => [...fake.matches.values()].some((m) => m.ledgerTransactionId === id)))),
    claimedWithdrawalIds: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => [...fake.matches.values()].some((m) => m.withdrawalId === id)))),
    claimedTopUpIds: vi.fn(async (ids: string[]) => new Set(ids.filter((id) => [...fake.matches.values()].some((m) => m.topUpId === id)))),
    summary: vi.fn(),
  };
  return {
    fake,
    repository,
    payouts: { findBankAccount: vi.fn(), findWithdrawal: vi.fn(), findWithdrawalByUtr: vi.fn(), findWithdrawalByReference: vi.fn() },
    advertisers: { findTopUp: vi.fn(), findTopUpByUtr: vi.fn(), findTopUpByPaymentId: vi.fn(), markTopUpReconciled: vi.fn() },
    ledger: { listTransactions: vi.fn(), getTransaction: vi.fn(), platformAccount: vi.fn(), post: vi.fn(), reverse: vi.fn() },
    uploads: { storeGeneratedFile: vi.fn() },
  };
});

vi.mock('../prisma-reconciliation.repository', () => ({ prismaReconciliationRepository: repository }));
vi.mock('../../payouts', () => payouts);
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../ledger', () => ledger);
vi.mock('../../uploads', () => uploads);

import { autoMatch, createProfile, ignoreLine, importStatement, matchLine, unmatchLine } from '../reconciliation.service';

const line = (id: string, over: Row = {}) => ({
  id,
  importId: 'imp_1',
  bankAccountId: 'bank_1',
  valueDate: DAY('2026-09-01'),
  description: 'NEFT OUT',
  utr: null,
  direction: 'DEBIT',
  amount: new Decimal('5000.00'),
  runningBalance: null,
  rawHash: `hash_${id}`,
  matchStatus: 'UNMATCHED',
  ...over,
});

const withdrawal = (over: Row = {}) => ({
  id: 'wdr_1',
  reference: 'WDR-2026-000118',
  status: 'PAID',
  netAmount: new Decimal('5000.00'),
  railReference: 'UTR001',
  ledgerTransactionId: 'ltx_debit',
  ...over,
});

const topUp = (over: Row = {}) => ({
  id: 'tu_1',
  walletId: 'wal_adv',
  amount: new Decimal('25000.00'),
  method: 'BANK_TRANSFER',
  utr: 'UTR777',
  ledgerTransactionId: 'ltx_topup',
  reconciledAt: null,
  ...over,
});

const cashTx = (id: string, kind: string, cashAmount: string, occurredAt: Date, account = 'platform:cash') => ({
  id,
  kind,
  reference: `LGR-${id}`,
  occurredAt,
  legs: [
    { account: { code: 'wallet:wal_1' }, amount: new Decimal(cashAmount).negated() },
    { account: { code: account }, amount: new Decimal(cashAmount) },
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.lines.clear();
  fake.matches.clear();
  fake.imports.clear();
  fake.profiles.clear();
  payouts.findBankAccount.mockResolvedValue({ id: 'bank_1', label: 'HDFC current', isActive: true });
  payouts.findWithdrawal.mockResolvedValue(null);
  payouts.findWithdrawalByUtr.mockResolvedValue(null);
  payouts.findWithdrawalByReference.mockResolvedValue(null);
  advertisers.findTopUp.mockResolvedValue(null);
  advertisers.findTopUpByUtr.mockResolvedValue(null);
  advertisers.findTopUpByPaymentId.mockResolvedValue(null);
  advertisers.markTopUpReconciled.mockImplementation(async (id: string, at: Date | null) => topUp({ id, reconciledAt: at }));
  ledger.listTransactions.mockResolvedValue([]);
  ledger.getTransaction.mockResolvedValue(null);
  ledger.platformAccount.mockImplementation(async (code: string) => ({ id: `acc_${code}`, code }));
  ledger.post.mockResolvedValue({ transaction: { id: 'ltx_settle' }, created: true });
  ledger.reverse.mockResolvedValue({ id: 'ltx_reversal' });
  uploads.storeGeneratedFile.mockResolvedValue({ id: 'file_stmt' });
});

describe('importing a statement', () => {
  const csv = [
    'Date,Description,Ref No./UTR,Debit,Credit,Balance',
    '01/09/2026,NEFT OUT WDR-2026-000118,UTR001,"5,000.00",,',
    '02/09/2026,IMPS IN,UTR777,,"25,000.00",',
    '02/09/2026,IMPS IN,UTR777,,"25,000.00",',
  ].join('\n');

  it('parses with the defaults, keeps the file, dedupes on the hash and reports the counts', async () => {
    const result = await importStatement(
      { bankAccountId: 'bank_1', profileId: null, file: { buffer: Buffer.from(csv), originalname: 'sept.csv' }, byUserId: 'usr_fin' },
      NOW
    );
    expect(uploads.storeGeneratedFile).toHaveBeenCalledWith('usr_fin', expect.objectContaining({ purpose: 'BANK_STATEMENT', filename: 'sept.csv' }));
    expect(repository.createImport).toHaveBeenCalledWith(
      expect.objectContaining({ bankAccountId: 'bank_1', fileId: 'file_stmt', periodStart: DAY('2026-09-01'), periodEnd: DAY('2026-09-02') })
    );
    expect(result).toMatchObject({ created: 2, duplicates: 1, problems: [] });
    expect(fake.lines.size).toBe(2);
  });

  it('reads through the named profile', async () => {
    await createProfile({ name: 'HDFC', bankName: 'HDFC Bank', columns: { date: 'Txn Date', description: 'Narration', debit: 'Withdrawal', credit: 'Deposit' }, dateFormat: 'dd-MMM-yyyy' });
    const hdfc = 'Txn Date,Narration,Withdrawal,Deposit\n01-Sep-2026,NEFT OUT,500.00,\n';
    const result = await importStatement(
      { bankAccountId: 'bank_1', profileId: 'prof_1', file: { buffer: Buffer.from(hdfc), originalname: 'hdfc.csv' }, byUserId: 'usr_fin' },
      NOW
    );
    expect(result.created).toBe(1);
    expect([...fake.lines.values()][0]).toMatchObject({ direction: 'DEBIT', description: 'NEFT OUT' });
  });

  it('refuses an account it does not know, and a file with no readable lines', async () => {
    payouts.findBankAccount.mockResolvedValue(null);
    await expect(
      importStatement({ bankAccountId: 'bank_x', profileId: null, file: { buffer: Buffer.from(csv), originalname: 'x.csv' }, byUserId: 'u' }, NOW)
    ).rejects.toMatchObject({ statusCode: 404 });
    payouts.findBankAccount.mockResolvedValue({ id: 'bank_1', isActive: true });
    await expect(
      importStatement({ bankAccountId: 'bank_1', profileId: null, file: { buffer: Buffer.from('nothing,here\n1,2'), originalname: 'x.csv' }, byUserId: 'u' }, NOW)
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('auto-match', () => {
  it('matches a debit to the PAID withdrawal carrying its UTR', async () => {
    fake.lines.set('line_1', line('line_1', { utr: 'UTR001' }));
    payouts.findWithdrawalByUtr.mockResolvedValue(withdrawal());

    const result = await autoMatch({ byUserId: 'usr_fin' }, NOW);

    expect(result).toMatchObject({ scanned: 1, matched: 1, differs: 0, unmatched: 0 });
    expect(fake.lines.get('line_1')!.matchStatus).toBe('MATCHED');
    expect(fake.matches.get('line_1')).toMatchObject({ withdrawalId: 'wdr_1', kind: 'AUTO', difference: '0.00', matchedByUserId: 'usr_fin' });
  });

  it('matches by the WDR reference in the narration, and marks DIFFERS when the amount disagrees', async () => {
    fake.lines.set('line_1', line('line_1', { description: 'NEFT DR SHARMA WDR-2026-000118', amount: new Decimal('4990.00') }));
    payouts.findWithdrawalByReference.mockResolvedValue(withdrawal());

    const result = await autoMatch({ byUserId: 'usr_fin' }, NOW);

    expect(payouts.findWithdrawalByReference).toHaveBeenCalledWith('WDR-2026-000118');
    expect(result).toMatchObject({ matched: 0, differs: 1 });
    expect(fake.lines.get('line_1')!.matchStatus).toBe('DIFFERS');
    expect(fake.matches.get('line_1')).toMatchObject({ withdrawalId: 'wdr_1', difference: '-10.00' });
  });

  it('leaves a withdrawal still PROCESSING for finance to confirm, and says so', async () => {
    fake.lines.set('line_1', line('line_1', { utr: 'UTR001' }));
    payouts.findWithdrawalByUtr.mockResolvedValue(withdrawal({ status: 'PROCESSING' }));

    const result = await autoMatch({ byUserId: 'usr_fin' }, NOW);

    expect(result.unmatched).toBe(1);
    expect(result.awaitingMarkPaid).toEqual([{ lineId: 'line_1', withdrawalId: 'wdr_1', reference: 'WDR-2026-000118', utr: 'UTR001' }]);
    expect(fake.lines.get('line_1')!.matchStatus).toBe('UNMATCHED');
  });

  it('matches a credit to the top-up carrying its UTR and settles suspense into cash', async () => {
    fake.lines.set('line_1', line('line_1', { direction: 'CREDIT', amount: new Decimal('25000.00'), utr: 'UTR777' }));
    advertisers.findTopUpByUtr.mockResolvedValue(topUp());

    await autoMatch({ byUserId: 'usr_fin' }, NOW);

    expect(fake.lines.get('line_1')!.matchStatus).toBe('MATCHED');
    expect(fake.matches.get('line_1')).toMatchObject({ topUpId: 'tu_1', ledgerTransactionId: 'ltx_settle' });
    expect(advertisers.markTopUpReconciled).toHaveBeenCalledWith('tu_1', NOW);
    expect(ledger.post).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'TOPUP',
        idempotencyKey: 'recon-settle:tu_1:match_1',
        legs: [
          expect.objectContaining({ accountId: 'acc_platform:suspense', amount: '25000.00' }),
          expect.objectContaining({ accountId: 'acc_platform:cash', amount: '-25000.00' }),
        ],
      }),
      NOW
    );
  });

  it('does not settle a gateway top-up — its cash leg was posted when it landed', async () => {
    fake.lines.set('line_1', line('line_1', { direction: 'CREDIT', amount: new Decimal('25000.00'), utr: 'UTR777' }));
    advertisers.findTopUpByUtr.mockResolvedValue(topUp({ method: 'GATEWAY' }));
    await autoMatch({ byUserId: 'usr_fin' }, NOW);
    expect(ledger.post).not.toHaveBeenCalled();
    expect(fake.matches.get('line_1')).toMatchObject({ topUpId: 'tu_1', ledgerTransactionId: null });
  });

  it('falls back to the one ledger transaction of the right kind, amount and date within two days', async () => {
    fake.lines.set('line_1', line('line_1', { valueDate: DAY('2026-09-03') }));
    ledger.listTransactions.mockResolvedValue([
      cashTx('ltx_a', 'PAYOUT', '5000.00', DAY('2026-09-01')),
      cashTx('ltx_b', 'PAYOUT', '4000.00', DAY('2026-09-02')),
      cashTx('ltx_c', 'REFUND', '5000.00', DAY('2026-09-08')),
    ]);

    const result = await autoMatch({ byUserId: 'usr_fin' }, NOW);

    expect(ledger.listTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ kind: ['PAYOUT', 'REFUND'], from: DAY('2026-09-01'), to: new Date('2026-09-05T23:59:59.999Z') })
    );
    expect(result.matched).toBe(1);
    expect(fake.matches.get('line_1')).toMatchObject({ ledgerTransactionId: 'ltx_a', withdrawalId: null });
  });

  it('leaves an ambiguous amount alone rather than guessing, and skips a transaction already claimed', async () => {
    fake.lines.set('line_1', line('line_1'));
    fake.lines.set('line_2', line('line_2', { rawHash: 'other' }));
    ledger.listTransactions.mockResolvedValue([
      cashTx('ltx_a', 'PAYOUT', '5000.00', DAY('2026-09-01')),
      cashTx('ltx_b', 'PAYOUT', '5000.00', DAY('2026-09-02')),
    ]);
    let result = await autoMatch({ byUserId: 'usr_fin' }, NOW);
    expect(result).toMatchObject({ matched: 0, unmatched: 2 });

    // Once one of the two is claimed by hand, the other line has one candidate left.
    fake.matches.set('line_9', { id: 'match_x', lineId: 'line_9', ledgerTransactionId: 'ltx_a' });
    result = await autoMatch({ byUserId: 'usr_fin' }, NOW);
    expect(result.matched).toBe(1);
    expect(fake.matches.get('line_1')).toMatchObject({ ledgerTransactionId: 'ltx_b' });
  });

  it('reads a credit against TOPUP transactions on cash or suspense', async () => {
    fake.lines.set('line_1', line('line_1', { direction: 'CREDIT', amount: new Decimal('25000.00') }));
    ledger.listTransactions.mockResolvedValue([cashTx('ltx_t', 'TOPUP', '-25000.00', DAY('2026-09-01'), 'platform:suspense')]);
    const result = await autoMatch({ byUserId: 'usr_fin' }, NOW);
    expect(ledger.listTransactions).toHaveBeenCalledWith(expect.objectContaining({ kind: ['TOPUP'] }));
    expect(result.matched).toBe(1);
  });
});

describe('by hand', () => {
  beforeEach(() => {
    fake.lines.set('line_1', line('line_1'));
  });

  it('matches to a withdrawal, recording the difference and who did it', async () => {
    payouts.findWithdrawal.mockResolvedValue(withdrawal({ netAmount: new Decimal('4900.00') }));
    const result = await matchLine('line_1', { withdrawalId: 'wdr_1', note: 'Bank charge deducted', byUserId: 'usr_fin' }, NOW);
    expect(result.matchStatus).toBe('DIFFERS');
    expect(result.match).toMatchObject({ withdrawalId: 'wdr_1', difference: '100.00', kind: 'MANUAL', matchedByUserId: 'usr_fin', note: 'Bank charge deducted' });
  });

  it('matches to a ledger transaction, a top-up or a payment id', async () => {
    ledger.getTransaction.mockResolvedValue(cashTx('ltx_a', 'PAYOUT', '5000.00', DAY('2026-09-01')));
    expect((await matchLine('line_1', { ledgerTransactionId: 'ltx_a', byUserId: 'u' }, NOW)).matchStatus).toBe('MATCHED');

    fake.lines.set('line_2', line('line_2', { direction: 'CREDIT', amount: new Decimal('25000.00') }));
    advertisers.findTopUpByPaymentId.mockResolvedValue(topUp({ method: 'GATEWAY', paymentId: 'pay_1' }));
    const byPayment = await matchLine('line_2', { paymentId: 'pay_1', byUserId: 'u' }, NOW);
    expect(byPayment.match).toMatchObject({ topUpId: 'tu_1', paymentId: 'pay_1' });
  });

  it('refuses a target it cannot find, a line already explained, and a record another line claims', async () => {
    await expect(matchLine('line_1', { withdrawalId: 'wdr_missing', byUserId: 'u' }, NOW)).rejects.toMatchObject({ statusCode: 404 });
    await expect(matchLine('line_1', { byUserId: 'u' }, NOW)).rejects.toMatchObject({ statusCode: 400 });

    payouts.findWithdrawal.mockResolvedValue(withdrawal());
    await matchLine('line_1', { withdrawalId: 'wdr_1', byUserId: 'u' }, NOW);
    await expect(matchLine('line_1', { withdrawalId: 'wdr_1', byUserId: 'u' }, NOW)).rejects.toMatchObject({ statusCode: 409 });

    fake.lines.set('line_2', line('line_2'));
    await expect(matchLine('line_2', { withdrawalId: 'wdr_1', byUserId: 'u' }, NOW)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('ignores a line with a note, and unmatches back to UNMATCHED', async () => {
    const ignored = await ignoreLine('line_1', { note: 'Bank charges', byUserId: 'u' });
    expect(ignored.matchStatus).toBe('IGNORED');
    expect(ignored.match).toMatchObject({ note: 'Bank charges', kind: 'MANUAL' });

    const back = await unmatchLine('line_1', { byUserId: 'u' }, NOW);
    expect(back.matchStatus).toBe('UNMATCHED');
    expect(back.match).toBeNull();
  });

  it('unmatching a top-up takes the stamp back and reverses the settlement', async () => {
    fake.lines.set('line_2', line('line_2', { direction: 'CREDIT', amount: new Decimal('25000.00') }));
    advertisers.findTopUp.mockResolvedValue(topUp());
    await matchLine('line_2', { topUpId: 'tu_1', byUserId: 'u' }, NOW);
    expect(ledger.post).toHaveBeenCalledTimes(1);

    await unmatchLine('line_2', { byUserId: 'usr_fin' }, NOW);
    expect(advertisers.markTopUpReconciled).toHaveBeenLastCalledWith('tu_1', null);
    expect(ledger.reverse).toHaveBeenCalledWith('ltx_settle', expect.objectContaining({ createdByUserId: 'usr_fin' }), NOW);
  });
});
