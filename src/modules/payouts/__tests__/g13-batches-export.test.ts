import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * G13-B: GET /finance/payout-batches/export.csv — the batches under the
 * filters in force, one CRLF line per batch with its status, its line
 * count, its total, who built it, who approved it and when it was released.
 * Sits ahead of `/:id`; walks every page of the same list read; audited
 * PAYOUT_BATCHES_EXPORTED before the first byte.
 */

const NOW = new Date('2026-09-14T05:00:00Z');

const { repository, audit } = vi.hoisted(() => ({
  repository: { listBatches: vi.fn(), findBatch: vi.fn(), findBankAccount: vi.fn(async () => null) },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => ({ move: vi.fn(), snapshot: vi.fn() }));
vi.mock('../../ledger', () => ({ platformAccount: vi.fn(), post: vi.fn(), verifyLedger: vi.fn() }));
vi.mock('../../uploads', () => ({ storeGeneratedFile: vi.fn() }));
vi.mock('../../app-config', () => ({ getPlatformSettings: vi.fn(async () => ({ finance: { primaryRail: 'MANUAL_NEFT', railFallbackOrder: ['MANUAL_NEFT'], payoutEtaHours: 48, clearingDays: 7 } })) }));
vi.mock('../../notifications', () => ({ notify: vi.fn(), createNotification: vi.fn() }));
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { authenticate, requireRole } from '../../../shared/auth';
import { errorHandler } from '../../../shared/errors';
import { parseCsv } from '../../../shared/csv';
import { tokenFor } from '../../../shared/testing';
import { batchesRouter } from '../batches.routes';
import { BATCH_EXPORT_MAX_ROWS, batchExportCsvLines, batchesForExport } from '../batches.service';
import { registerPayoutUserLabelPort } from '../user-labels.port';

function app() {
  const instance = express();
  instance.use(express.json());
  const finance = Router();
  finance.use(authenticate, requireRole('ADMIN'));
  finance.use('/payout-batches', batchesRouter);
  const api = Router();
  api.use('/finance', finance);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');

const batch = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  reference: `BATCH-2026-${id}`,
  status: 'COMPLETED',
  rail: 'MANUAL_NEFT',
  bankAccountId: null,
  cutoffAt: null,
  scheduledFor: null,
  createdByUserId: 'usr_a',
  submittedAt: NOW,
  approvedByUserId: 'usr_b',
  approvedAt: NOW,
  releasedAt: new Date('2026-09-13T04:00:00Z'),
  completedAt: NOW,
  lineCount: 3,
  totalNet: new Decimal('4500.50'),
  exportFileId: null,
  note: 'Weekly, "Monday"',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  registerPayoutUserLabelPort(async (ids) => new Map(ids.map((id) => [id, { id, name: id === 'usr_a' ? 'Asha' : id === 'usr_b' ? 'Bala' : null }])));
  repository.listBatches.mockImplementation(async (filter: { page: number; pageSize: number }) => {
    const rows = [batch('000001'), batch('000002', { status: 'IN_REVIEW', approvedByUserId: null, approvedAt: null, releasedAt: null, completedAt: null, lineCount: 1, totalNet: new Decimal('10') })];
    const start = (filter.page - 1) * filter.pageSize;
    return { items: rows.slice(start, start + filter.pageSize), total: rows.length, counts: {} };
  });
});

describe('GET /finance/payout-batches/export.csv', () => {
  it('streams one line per batch under the filters in force, with a header, CRLF, and the actors by name', async () => {
    const res = await request(app()).get('/api/v1/finance/payout-batches/export.csv?status=COMPLETED,IN_REVIEW&q=2026').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('payout-batches');
    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(['reference', 'status', 'rail', 'lineCount', 'totalNet', 'createdBy', 'approvedBy', 'submittedAt', 'approvedAt', 'releasedAt', 'completedAt', 'createdAt', 'note']);
    expect(rows[1]).toEqual(['BATCH-2026-000001', 'COMPLETED', 'MANUAL_NEFT', '3', '4500.50', 'Asha', 'Bala', NOW.toISOString(), NOW.toISOString(), '2026-09-13T04:00:00.000Z', NOW.toISOString(), NOW.toISOString(), 'Weekly, "Monday"']);
    expect(rows[2]).toEqual(['BATCH-2026-000002', 'IN_REVIEW', 'MANUAL_NEFT', '1', '10.00', 'Asha', '', NOW.toISOString(), '', '', '', NOW.toISOString(), 'Weekly, "Monday"']);
    expect(res.text.endsWith('\r\n')).toBe(true);
    // The filters reach the list read; the page is the export's own.
    expect(repository.listBatches).toHaveBeenCalledWith(expect.objectContaining({ status: ['COMPLETED', 'IN_REVIEW'], q: '2026', page: 1 }));
  });

  it('is audited PAYOUT_BATCHES_EXPORTED before the first byte, with the filters and the row count', async () => {
    await request(app()).get('/api/v1/finance/payout-batches/export.csv?status=COMPLETED').set('Authorization', `Bearer ${admin}`);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'PAYOUT_BATCHES_EXPORTED',
      expect.objectContaining({ module: 'payouts', metadata: expect.objectContaining({ status: ['COMPLETED'], rows: 2 }) }),
    );
  });

  it('walks every page of the list read up to the cap and stops at the total', async () => {
    const rows = await batchesForExport({ status: undefined, q: undefined });
    expect(rows).toHaveLength(2);
    expect(repository.listBatches).toHaveBeenCalledTimes(1);
    expect(BATCH_EXPORT_MAX_ROWS).toBeGreaterThanOrEqual(1000);
  });

  it('is ADMIN only and a 400 on a status it does not know', async () => {
    const publisher = tokenFor(['PUBLISHER'], 'pub_1');
    expect((await request(app()).get('/api/v1/finance/payout-batches/export.csv').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect((await request(app()).get('/api/v1/finance/payout-batches/export.csv?status=BOGUS').set('Authorization', `Bearer ${admin}`)).status).toBe(400);
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('never reads "export.csv" as a batch id', async () => {
    await request(app()).get('/api/v1/finance/payout-batches/export.csv').set('Authorization', `Bearer ${admin}`);
    expect(repository.findBatch).not.toHaveBeenCalled();
  });

  it('the line builder quotes what needs quoting and blanks a null', () => {
    const lines = batchExportCsvLines([{ ...batch('x', { approvedByUserId: null, note: null }), createdBy: { id: 'usr_a', name: 'Asha' }, approvedBy: null } as never]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('BATCH-2026-x,COMPLETED,MANUAL_NEFT,3,4500.50,Asha,,');
  });
});
