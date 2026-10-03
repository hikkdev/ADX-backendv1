import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The improved Finance › Ledger: `?q=` searches the reference or the note,
 * `?paged=1` answers `{ rows, total, nextCursor, totals }` while the bare
 * array stays as it was, and `GET /finance/ledger/export.csv` writes one
 * line per leg under the same filters — capped, refused with a sentence
 * past the cap, and audited LEDGER_EXPORTED before the first byte.
 */

const { repository, audit } = vi.hoisted(() => ({
  repository: {
    findAccountByCode: vi.fn(),
    findAccountByWallet: vi.fn(),
    createAccount: vi.fn(),
    listAccounts: vi.fn(),
    append: vi.fn(),
    findTransaction: vi.fn(),
    findTransactionByKey: vi.fn(),
    listTransactions: vi.fn(),
    countTransactions: vi.fn(),
    sumLegs: vi.fn(),
    countLegs: vi.fn(),
    referenceExists: vi.fn(),
    countForYear: vi.fn(),
    balanceOf: vi.fn(),
    findUnbalanced: vi.fn(),
    findWalletDrift: vi.fn(),
  },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../../ledger/prisma-ledger.repository', () => ({ prismaLedgerRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { errorHandler } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import { parseCsv } from '../../../shared/csv';
import { tokenFor } from '../../../shared/testing';
import { financeRouter } from '../payouts.routes';
import { LEDGER_CSV_COLUMNS, iterateLedgerCsv, pageTransactions } from '../../ledger';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/finance', financeRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');
const outsider = signAccessToken('usr_ops', ['ADMIN'], undefined, { perms: ['supply.view'] });

const account = (code: string, name: string) => ({
  id: `acc_${code}`,
  code,
  name,
  kind: 'PLATFORM',
  walletId: null,
  createdAt: new Date(),
});

const leg = (txId: string, suffix: string, amount: string, code: string, name: string) => ({
  id: `${txId}_${suffix}`,
  transactionId: txId,
  accountId: `acc_${code}`,
  amount: new Decimal(amount),
  campaignId: null,
  orderId: null,
  reference: null,
  note: null,
  createdAt: new Date(),
  account: account(code, name),
});

const tx = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  reference: `LGR-2026-${id}`,
  kind: 'PUBLISHER_EARNING',
  idempotencyKey: `k:${id}`,
  reversesId: null,
  occurredAt: new Date('2026-09-09T18:45:00Z'),
  createdByUserId: null,
  note: 'Earning, "day 3"',
  createdAt: new Date(),
  reverses: null,
  reversedBy: null,
  legs: [
    leg(id, 'a', '-1000.00', 'platform:payables', 'Payable to parties'),
    leg(id, 'b', '1000.00', 'wallet:wal_1', 'Sharma Hoardings wallet'),
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.listTransactions.mockResolvedValue([tx('t1')]);
  repository.countTransactions.mockResolvedValue(1);
  repository.sumLegs.mockResolvedValue({ debit: new Decimal('1000'), credit: new Decimal('1000') });
  repository.countLegs.mockResolvedValue(2);
});

describe('GET /finance/ledger', () => {
  it('passes the search to the read with the other facets', async () => {
    const res = await request(app())
      .get('/api/v1/finance/ledger?q=%20LGR-2026%20&kind=TOPUP,PROMOTION_SPEND&walletId=wal_1')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(repository.listTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'LGR-2026', kind: ['TOPUP', 'PROMOTION_SPEND'], walletId: 'wal_1' })
    );
  });

  it('answers the bare array exactly as before without paged=1', async () => {
    const res = await request(app()).get('/api/v1/finance/ledger').set('Authorization', `Bearer ${admin}`);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(Object.keys(res.body.data[0]).sort()).toEqual([
      'id',
      'kind',
      'legs',
      'note',
      'occurredAt',
      'reference',
      'reversesId',
    ]);
    expect(repository.countTransactions).not.toHaveBeenCalled();
    expect(repository.sumLegs).not.toHaveBeenCalled();
  });

  it('pages with the total, the totals by side and the next cursor', async () => {
    repository.listTransactions.mockResolvedValue([
      tx('t3'),
      tx('t2', { reversedBy: { id: 't9', reference: 'LGR-2026-t9' } }),
      tx('t1'),
    ]);
    repository.countTransactions.mockResolvedValue(548);
    repository.sumLegs.mockResolvedValue({ debit: new Decimal('482500'), credit: new Decimal('482500') });
    const res = await request(app())
      .get('/api/v1/finance/ledger?paged=1&limit=2&cursor=t4&q=sharma')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    // One past the page is read, so the last page knows it is the last.
    expect(repository.listTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3, cursor: 't4', q: 'sharma' })
    );
    // The count and the sums see every match, not the page.
    expect(repository.countTransactions).toHaveBeenCalledWith({ q: 'sharma' });
    expect(repository.sumLegs).toHaveBeenCalledWith({ q: 'sharma' });
    expect(res.body.data.total).toBe(548);
    expect(res.body.data.totals).toEqual({ debit: '482500.00', credit: '482500.00' });
    expect(res.body.data.nextCursor).toBe('t2');
    expect(res.body.data.rows.map((r: { id: string }) => r.id)).toEqual(['t3', 't2']);
    expect(res.body.data.rows[0].debit).toBe('1000.00');
    expect(res.body.data.rows[0].reversesReference).toBeNull();
    expect(res.body.data.rows[1].reversedBy).toEqual({ id: 't9', reference: 'LGR-2026-t9' });
  });

  it('says the last page is the last', async () => {
    const page = await pageTransactions({ limit: 20 });
    expect(page.nextCursor).toBeNull();
    expect(page.rows).toHaveLength(1);
  });
});

describe('GET /finance/ledger/export.csv', () => {
  it('writes one line per leg with the debit and credit on their sides, in India time', async () => {
    repository.listTransactions.mockResolvedValue([
      tx('t2', { kind: 'REVERSAL', reversesId: 't1', reverses: { reference: 'LGR-2026-t1' }, note: null }),
    ]);
    const res = await request(app())
      .get('/api/v1/finance/ledger/export.csv?kind=REVERSAL&from=2026-09-01')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="ledger-.*\.csv"/);
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual([...LEDGER_CSV_COLUMNS]);
    expect(rows[1]).toEqual([
      'LGR-2026-t2',
      'REVERSAL',
      '2026-09-10T00:15:00+05:30',
      '',
      'platform:payables',
      'Payable to parties',
      '1000.00',
      '',
      'LGR-2026-t1',
    ]);
    expect(rows[2]).toEqual([
      'LGR-2026-t2',
      'REVERSAL',
      '2026-09-10T00:15:00+05:30',
      '',
      'wallet:wal_1',
      'Sharma Hoardings wallet',
      '',
      '1000.00',
      'LGR-2026-t1',
    ]);
    expect(repository.listTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ kind: ['REVERSAL'], from: new Date('2026-09-01') })
    );
  });

  it('quotes a note with a comma and quotes in it', async () => {
    const res = await request(app()).get('/api/v1/finance/ledger/export.csv').set('Authorization', `Bearer ${admin}`);
    expect(res.text).toContain('"Earning, ""day 3"""');
    expect(parseCsv(res.text)[1]![3]).toBe('Earning, "day 3"');
  });

  it('is audited LEDGER_EXPORTED with who and which filters', async () => {
    await request(app())
      .get('/api/v1/finance/ledger/export.csv?walletId=wal_1&q=sharma&amount=1000')
      .set('Authorization', `Bearer ${admin}`);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'LEDGER_EXPORTED',
      expect.objectContaining({
        module: 'ledger',
        targetId: 'wal_1',
        metadata: expect.objectContaining({
          filter: expect.objectContaining({ walletId: 'wal_1', q: 'sharma' }),
          legs: 2,
          cap: 50_000,
        }),
      })
    );
  });

  it('refuses past the cap with a sentence, before writing or auditing anything', async () => {
    repository.countLegs.mockResolvedValue(50_001);
    const res = await request(app()).get('/api/v1/finance/ledger/export.csv').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toMatch(/Narrow the date range/);
    expect(audit.logActivity).not.toHaveBeenCalled();
    expect(repository.listTransactions).not.toHaveBeenCalled();
  });

  it('takes the ledger read permission', async () => {
    const res = await request(app())
      .get('/api/v1/finance/ledger/export.csv')
      .set('Authorization', `Bearer ${outsider}`);
    expect(res.status).toBe(403);
  });

  it('stops at the cap rather than cutting a transaction in half', async () => {
    repository.listTransactions.mockResolvedValueOnce([tx('t3'), tx('t2'), tx('t1')]);
    let body = '';
    for await (const chunk of iterateLedgerCsv({}, 5)) body += chunk;
    expect(parseCsv(body)).toHaveLength(4);
  });
});
