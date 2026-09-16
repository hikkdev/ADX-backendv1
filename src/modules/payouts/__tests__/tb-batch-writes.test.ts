import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * T-B — a write answers the same view its read answers.
 *
 * Every write on a payout batch — create, lines, submit, approve, release,
 * cancel — answers what `GET /finance/payout-batches/:id` answers: the
 * shaped batch with its bank account and lines, and (E6) `createdBy` /
 * `approvedBy` by name through the user-label port. The release keeps its
 * three counters beside the view.
 */

const NOW = new Date('2026-09-14T05:00:00Z');

const { service, audit } = vi.hoisted(() => ({
  service: {
    createBatch: vi.fn(),
    getBatch: vi.fn(),
    setBatchLines: vi.fn(),
    submitBatch: vi.fn(),
    approveBatch: vi.fn(),
    releaseBatch: vi.fn(),
    cancelBatch: vi.fn(),
    listBatches: vi.fn(),
    preflightBatch: vi.fn(),
    buildBatchCsv: vi.fn(),
    batchesForExport: vi.fn(),
    batchExportCsvLines: vi.fn(),
    markBatchLinePaid: vi.fn(),
    failBatchLine: vi.fn(),
    listBankAccounts: vi.fn(),
    saveBankAccount: vi.fn(),
  },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../batches.service', () => service);
vi.mock('../batch-draft.service', () => ({ payoutBatchSchedule: vi.fn() }));
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { authenticate, requireRole } from '../../../shared/auth';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { batchesRouter } from '../batches.routes';
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

const batch = (over: Record<string, unknown> = {}) => ({
  id: 'bat_1',
  reference: 'BATCH-2026-000001',
  status: 'DRAFT',
  rail: 'MANUAL_NEFT',
  bankAccountId: null,
  cutoffAt: null,
  scheduledFor: null,
  createdByUserId: 'usr_a',
  submittedAt: null,
  approvedByUserId: null,
  approvedAt: null,
  releasedAt: null,
  completedAt: null,
  lineCount: 0,
  totalNet: new Decimal('0'),
  exportFileId: null,
  note: null,
  createdAt: NOW,
  updatedAt: NOW,
  bankAccount: null,
  lines: [],
  ...over,
});

const actors = { createdBy: { id: 'usr_a', name: 'Asha' }, approvedBy: null };
const approved = { createdBy: { id: 'usr_a', name: 'Asha' }, approvedBy: { id: 'usr_b', name: 'Bala' } };

beforeEach(() => {
  vi.clearAllMocks();
  registerPayoutUserLabelPort(async (ids) => new Map(ids.map((id) => [id, { id, name: id === 'usr_a' ? 'Asha' : id === 'usr_b' ? 'Bala' : null }])));
  service.getBatch.mockResolvedValue(batch());
});

const call = (method: 'post' | 'put', path: string, body: Record<string, unknown> = {}) =>
  request(app())[method](`/api/v1/finance/payout-batches${path}`).set('Authorization', `Bearer ${admin}`).send(body);

describe('every batch write answers the detail view', () => {
  it('POST / — createdBy by name, the bank account and the lines beside the batch', async () => {
    service.createBatch.mockResolvedValue(batch());
    const res = await call('post', '/', { rail: 'MANUAL_NEFT' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ id: 'bat_1', totalNet: '0.00', bankAccount: null, lines: [], ...actors });
  });

  it('PUT /:id/lines', async () => {
    service.setBatchLines.mockResolvedValue(batch({ lineCount: 1, totalNet: new Decimal('4500.50') }));
    const res = await call('put', '/bat_1/lines', { withdrawalIds: ['wdr_1'] });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ lineCount: 1, totalNet: '4500.50', ...actors });
  });

  it('POST /:id/submit', async () => {
    service.submitBatch.mockResolvedValue(batch({ status: 'PENDING_APPROVAL', submittedAt: NOW }));
    const res = await call('post', '/bat_1/submit');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'PENDING_APPROVAL', ...actors });
  });

  it('POST /:id/approve — approvedBy named too', async () => {
    service.approveBatch.mockResolvedValue(batch({ status: 'APPROVED', approvedByUserId: 'usr_b', approvedAt: NOW }));
    const res = await call('post', '/bat_1/approve');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'APPROVED', ...approved });
  });

  it('POST /:id/release — the three counters ride beside the view', async () => {
    service.releaseBatch.mockResolvedValue({
      batch: batch({ status: 'RELEASED', approvedByUserId: 'usr_b', releasedAt: NOW }),
      released: 2,
      failed: 0,
      skipped: 1,
      exportFileId: null,
    });
    const res = await call('post', '/bat_1/release');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'RELEASED', released: 2, failed: 0, skipped: 1, ...approved });
  });

  it('POST /:id/cancel', async () => {
    service.cancelBatch.mockResolvedValue(batch({ status: 'CANCELLED' }));
    const res = await call('post', '/bat_1/cancel');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', ...actors });
  });
});
