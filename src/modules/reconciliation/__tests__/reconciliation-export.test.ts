import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The reconciliation export — Lot G (Q125).
 *
 * What is pinned: every line leaves with its match state, the record that
 * explains it (which of the four and its id), the difference, and who
 * resolved it — by id and by name — and when; the walk is by keyset under
 * (valueDate, id) newest first, a thousand a slice, capped; the two routes
 * are ADMIN, audited before the first byte, and `export.csv` is never read
 * as a line id.
 */

type Row = Record<string, any>;

const { repository, users, audit } = vi.hoisted(() => ({
  repository: {
    findImport: vi.fn(),
    findLineRows: vi.fn(),
  },
  users: { findUserLabels: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-reconciliation.repository', () => ({ prismaReconciliationRepository: repository }));
vi.mock('../../users', () => users);
vi.mock('../../uploads', () => ({ csvUploadMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(), storeGeneratedFile: vi.fn() }));
vi.mock('../../payouts', () => ({ findBankAccount: vi.fn(), findWithdrawal: vi.fn(), findWithdrawalByUtr: vi.fn(), findWithdrawalByReference: vi.fn() }));
vi.mock('../../advertisers', () => ({ findTopUp: vi.fn(), findTopUpByUtr: vi.fn(), findTopUpByPaymentId: vi.fn(), markTopUpReconciled: vi.fn() }));
vi.mock('../../ledger', () => ({ listTransactions: vi.fn(), getTransaction: vi.fn(), platformAccount: vi.fn(), post: vi.fn(), reverse: vi.fn() }));
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { iterateLineCsv, LINE_CSV_COLUMNS, LINE_EXPORT_BATCH, lineCsvHeader, lineCsvLine, matchedRecordOf } from '../reconciliation-export.service';
import { reconciliationRouter } from '../reconciliation.routes';

const line = (id: string, over: Row = {}) => ({
  id,
  importId: 'imp_1',
  bankAccountId: 'bank_1',
  valueDate: new Date('2026-09-01T00:00:00Z'),
  description: 'NEFT OUT, "Sharma Hoardings"',
  utr: 'UTR001',
  direction: 'DEBIT',
  amount: new Decimal('5000.00'),
  runningBalance: new Decimal('120000.50'),
  matchStatus: 'MATCHED',
  createdAt: new Date('2026-09-02T04:00:00Z'),
  match: {
    id: 'match_1',
    lineId: id,
    withdrawalId: 'wdr_1',
    topUpId: null,
    paymentId: null,
    ledgerTransactionId: 'ltx_1',
    difference: new Decimal('0'),
    kind: 'MANUAL',
    matchedByUserId: 'adm-1',
    note: 'seen on the statement',
    createdAt: new Date('2026-09-02T05:30:00Z'),
  },
  ...over,
});

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/finance/reconciliation', reconciliationRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm-1');
const publisher = tokenFor(['PUBLISHER'], 'pub-1');

beforeEach(() => {
  vi.clearAllMocks();
  users.findUserLabels.mockImplementation(async (ids: readonly string[]) => new Map(ids.map((id) => [id, { id, name: id === 'adm-1' ? 'Priya Menon' : null }])));
  repository.findImport.mockResolvedValue({ id: 'imp_1', fileName: 'HDFC Sep 2026.csv', bankAccountId: 'bank_1' });
  repository.findLineRows.mockResolvedValue([]);
});

describe('the rows', () => {
  it('names the matched record, the difference and the resolver, and quotes what needs quoting', () => {
    expect(lineCsvHeader()).toBe(`${LINE_CSV_COLUMNS.join(',')}\r\n`);
    const out = lineCsvLine(line('line_1') as never, 'Priya Menon');
    expect(out).toBe(
      'line_1,imp_1,bank_1,2026-09-01,"NEFT OUT, ""Sharma Hoardings""",UTR001,DEBIT,5000.00,120000.50,MATCHED,MANUAL,WITHDRAWAL,wdr_1,0.00,seen on the statement,adm-1,Priya Menon,2026-09-02T05:30:00.000Z\r\n',
    );
  });

  it('leaves the match columns empty on an unmatched line, names NONE on an ignored one, and prefers the withdrawal over the ledger id', () => {
    const unmatched = lineCsvLine(line('line_2', { matchStatus: 'UNMATCHED', match: null, utr: null, runningBalance: null }) as never, null);
    expect(unmatched).toBe('line_2,imp_1,bank_1,2026-09-01,"NEFT OUT, ""Sharma Hoardings""",,DEBIT,5000.00,,UNMATCHED,,NONE,,,,,,\r\n');
    const ignored = matchedRecordOf({ withdrawalId: null, topUpId: null, paymentId: null, ledgerTransactionId: null } as never);
    expect(ignored).toEqual({ type: 'NONE', id: null });
    expect(matchedRecordOf({ withdrawalId: null, topUpId: 'tu_1', paymentId: null, ledgerTransactionId: 'ltx_9' } as never)).toEqual({ type: 'TOP_UP', id: 'tu_1' });
    expect(matchedRecordOf({ withdrawalId: null, topUpId: null, paymentId: 'pay_1', ledgerTransactionId: null } as never)).toEqual({ type: 'PAYMENT', id: 'pay_1' });
    expect(matchedRecordOf({ withdrawalId: null, topUpId: null, paymentId: null, ledgerTransactionId: 'ltx_9' } as never)).toEqual({ type: 'LEDGER_TRANSACTION', id: 'ltx_9' });
  });

  it('records a DIFFERS line with the difference signed as line minus record', () => {
    const out = lineCsvLine(line('line_3', { matchStatus: 'DIFFERS', match: { ...line('line_3').match, difference: new Decimal('-250.00'), kind: 'AUTO', note: null } }) as never, 'Priya Menon');
    expect(out).toContain(',DIFFERS,AUTO,WITHDRAWAL,wdr_1,-250.00,,adm-1,Priya Menon,');
  });
});

describe('the walk', () => {
  it('continues by keyset past the last row of each slice, looks the names up once a slice, and stops under the cap', async () => {
    const slice1 = Array.from({ length: LINE_EXPORT_BATCH }, (_, i) => line(`line_${String(i).padStart(4, '0')}`, { valueDate: new Date('2026-09-02T00:00:00Z') }));
    const slice2 = [line('line_last', { valueDate: new Date('2026-09-01T00:00:00Z'), match: { ...line('x').match, matchedByUserId: 'adm-2' } })];
    repository.findLineRows.mockResolvedValueOnce(slice1).mockResolvedValueOnce(slice2);

    const chunks: string[] = [];
    for await (const chunk of iterateLineCsv({ importId: 'imp_1' })) chunks.push(chunk);

    expect(chunks).toHaveLength(2);
    expect(repository.findLineRows).toHaveBeenNthCalledWith(1, { importId: 'imp_1' }, { take: LINE_EXPORT_BATCH });
    expect(repository.findLineRows).toHaveBeenNthCalledWith(2, { importId: 'imp_1' }, { take: LINE_EXPORT_BATCH, after: { valueDate: new Date('2026-09-02T00:00:00Z'), id: 'line_0999' } });
    expect(users.findUserLabels).toHaveBeenCalledTimes(2);
    expect(users.findUserLabels).toHaveBeenNthCalledWith(1, ['adm-1']);
    expect(chunks[1]).toContain(',adm-2,,');
    // A short slice ends the walk without another read.
    expect(repository.findLineRows).toHaveBeenCalledTimes(2);
  });

  it('honours the cap: a filter matching everything still ends', async () => {
    repository.findLineRows.mockImplementation(async (_f: unknown, slice: { take: number }) => Array.from({ length: slice.take }, (_, i) => line(`l${i}`)));
    let rows = 0;
    for await (const chunk of iterateLineCsv({}, 2_500)) rows += chunk.split('\r\n').length - 1;
    expect(rows).toBe(2_500);
    expect(repository.findLineRows).toHaveBeenCalledTimes(3);
    expect(repository.findLineRows).toHaveBeenLastCalledWith({}, expect.objectContaining({ take: 500 }));
  });

  it('still answers the ids when the name lookup fails', async () => {
    users.findUserLabels.mockRejectedValue(new Error('users down'));
    repository.findLineRows.mockResolvedValueOnce([line('line_1')]);
    const chunks: string[] = [];
    for await (const chunk of iterateLineCsv({ importId: 'imp_1' })) chunks.push(chunk);
    expect(chunks[0]).toContain(',adm-1,,2026-09-02T05:30:00.000Z');
  });
});

describe('the routes', () => {
  it('streams one import as a CSV, named after the file, audited against the import before the first byte', async () => {
    repository.findLineRows.mockResolvedValueOnce([line('line_1')]);
    const res = await request(app()).get('/api/v1/finance/reconciliation/imports/imp_1/export.csv').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toBe('attachment; filename="reconciliation-HDFC-Sep-2026-imp_1.csv"');
    const lines = res.text.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe(LINE_CSV_COLUMNS.join(','));
    expect(lines[1]).toContain('line_1,imp_1,bank_1,2026-09-01');
    expect(lines[1]).toContain('Priya Menon');
    expect(repository.findLineRows).toHaveBeenCalledWith({ importId: 'imp_1' }, { take: LINE_EXPORT_BATCH });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm-1',
      'RECONCILIATION_LINES_EXPORTED',
      expect.objectContaining({ module: 'reconciliation', targetType: 'BankStatementImport', targetId: 'imp_1' }),
    );
  });

  it('is a 404 for an import that does not exist, and refuses a party', async () => {
    repository.findImport.mockResolvedValue(null);
    expect((await request(app()).get('/api/v1/finance/reconciliation/imports/nope/export.csv').set('Authorization', `Bearer ${admin}`)).status).toBe(404);
    expect((await request(app()).get('/api/v1/finance/reconciliation/lines/export.csv').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('streams the lines under the desk filters — status, window, account — with no page, and refuses a backwards window', async () => {
    repository.findLineRows.mockResolvedValueOnce([line('line_1', { matchStatus: 'DIFFERS' })]);
    const res = await request(app())
      .get('/api/v1/finance/reconciliation/lines/export.csv?status=DIFFERS,UNMATCHED&from=2026-09-01&to=2026-09-30&bankAccountId=bank_1&q=NEFT')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="reconciliation-lines-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.csv"$/);
    expect(repository.findLineRows).toHaveBeenCalledWith(
      { status: ['DIFFERS', 'UNMATCHED'], bankAccountId: 'bank_1', importId: undefined, from: new Date('2026-09-01'), to: new Date('2026-09-30'), q: 'NEFT' },
      { take: LINE_EXPORT_BATCH },
    );
    expect(audit.logActivity).toHaveBeenCalledWith('adm-1', 'RECONCILIATION_LINES_EXPORTED', expect.objectContaining({ targetType: 'BankAccount', targetId: 'bank_1' }));

    const backwards = await request(app()).get('/api/v1/finance/reconciliation/lines/export.csv?from=2026-09-30&to=2026-09-01').set('Authorization', `Bearer ${admin}`);
    expect(backwards.status).toBe(400);
  });
});
