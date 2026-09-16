import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The weekly payout draft — Lot G (Q124).
 *
 * What is pinned: the cadence arithmetic (the slot is `weekday` at `hourIst`
 * Indian time, the last one at or before now and the next one after); the
 * draft takes every APPROVED line in no open batch, as the actor handed in,
 * with the schedule's note and the `PAYOUT_BATCH_DRAFTED_BY_SCHEDULE` audit
 * row against the batch — and nothing else: no submit, no approval, no
 * release, no line status moved; no lines, no batch; a set that fails
 * cancels the empty draft; the schedule read answers the cadence, the next
 * run and the last draft, and sits ahead of `/:id`.
 */

const NOW = new Date('2026-09-14T05:00:00Z'); // Monday 10:30 IST

type Row = Record<string, any>;

const { fake, repository, wallets, ledger, uploads, appConfig, audit } = vi.hoisted(() => {
  const fake = { batches: new Map<string, Row>(), withdrawals: new Map<string, Row>(), settings: { enabled: true, weekday: 1, hourIst: 10 } };
  const lines = (batchId: string) => [...fake.withdrawals.values()].filter((w) => w.batchId === batchId);
  const repository = {
    findWithdrawals: vi.fn(async (ids: string[]) => ids.map((id) => fake.withdrawals.get(id)).filter(Boolean)),
    findDraftableWithdrawals: vi.fn(async (limit: number) =>
      [...fake.withdrawals.values()]
        .filter((w) => w.status === 'APPROVED' && w.payoutMethod.status === 'VERIFIED' && (!w.batchId || !['DRAFT', 'IN_REVIEW', 'APPROVED', 'RELEASING'].includes(fake.batches.get(w.batchId)?.status)))
        .slice(0, limit),
    ),
    findLatestBatchByNote: vi.fn(async (prefix: string) => [...fake.batches.values()].filter((b) => typeof b.note === 'string' && b.note.startsWith(prefix)).pop() ?? null),
    createBatch: vi.fn(async (data: Row) => {
      const row = { id: `bat_${fake.batches.size + 1}`, status: 'DRAFT', lineCount: 0, totalNet: new Decimal(0), exportFileId: null, approvedByUserId: null, createdAt: NOW, ...data };
      fake.batches.set(row.id, row);
      return row;
    }),
    findBatch: vi.fn(async (id: string) => {
      const batch = fake.batches.get(id);
      return batch ? { ...batch, lines: lines(id), bankAccount: null } : null;
    }),
    updateBatch: vi.fn(async (id: string, patch: Row) => {
      const next = { ...fake.batches.get(id), ...patch };
      fake.batches.set(id, next);
      return next;
    }),
    batchReferenceExists: vi.fn(async () => false),
    countBatchesForYear: vi.fn(async () => fake.batches.size),
    setBatchLines: vi.fn(async (batchId: string, attach: string[], detach: string[]) => {
      for (const id of detach) fake.withdrawals.set(id, { ...fake.withdrawals.get(id), batchId: null });
      for (const id of attach) fake.withdrawals.set(id, { ...fake.withdrawals.get(id), batchId });
      const rows = lines(batchId);
      return repository.updateBatch(batchId, { lineCount: rows.length, totalNet: rows.reduce((sum, row) => sum.plus(row.netAmount), new Decimal(0)) });
    }),
    findBankAccount: vi.fn(async () => null),
  };
  return {
    fake,
    repository,
    wallets: { move: vi.fn(), snapshot: vi.fn() },
    ledger: { platformAccount: vi.fn(), post: vi.fn(), verifyLedger: vi.fn() },
    uploads: { storeGeneratedFile: vi.fn() },
    appConfig: {
      getPlatformSettings: vi.fn(async () => ({
        finance: { primaryRail: 'MANUAL_NEFT', railFallbackOrder: ['RAZORPAY_X', 'CASHFREE', 'MANUAL_NEFT'], payoutEtaHours: 48, clearingDays: 7, payoutBatchCadence: fake.settings },
      })),
    },
    audit: { logActivity: vi.fn() },
  };
});

vi.mock('../prisma-payouts.repository', () => ({ prismaPayoutsRepository: repository }));
vi.mock('../../wallets', () => wallets);
vi.mock('../../ledger', () => ledger);
vi.mock('../../uploads', () => uploads);
vi.mock('../../app-config', () => appConfig);
vi.mock('../../notifications', () => ({ notify: vi.fn(), createNotification: vi.fn() }));
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});

import { authenticate, requireRole } from '../../../shared/auth';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { draftScheduledBatch, lastSlot, nextSlot, payoutBatchSchedule, SCHEDULE_DRAFT_MAX_LINES, SCHEDULE_NOTE_PREFIX } from '../batch-draft.service';
import { batchesRouter } from '../batches.routes';

const withdrawal = (id: string, over: Row = {}) => ({
  id,
  reference: `WDR-2026-${id}`,
  walletId: `wal_${id}`,
  status: 'APPROVED',
  netAmount: new Decimal('1000.00'),
  amount: new Decimal('1000.00'),
  batchId: null,
  requestedAt: NOW,
  payoutMethod: { id: `pm_${id}`, status: 'VERIFIED' },
  wallet: { id: `wal_${id}`, publisherId: 'pub_1' },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.batches.clear();
  fake.withdrawals.clear();
  fake.settings = { enabled: true, weekday: 1, hourIst: 10 };
});

describe('the cadence', () => {
  const monday10 = { weekday: 1, hourIst: 10 };

  it('finds the slot at or before now and the one after — Monday 10:00 IST is 04:30Z', () => {
    expect(lastSlot(monday10, NOW).toISOString()).toBe('2026-09-14T04:30:00.000Z');
    expect(nextSlot(monday10, NOW).toISOString()).toBe('2026-09-21T04:30:00.000Z');
    // Exactly on the slot: the slot itself is "at or before".
    expect(lastSlot(monday10, new Date('2026-09-14T04:30:00.000Z')).toISOString()).toBe('2026-09-14T04:30:00.000Z');
    // Monday 09:59 IST: last week's Monday.
    expect(lastSlot(monday10, new Date('2026-09-14T04:29:00.000Z')).toISOString()).toBe('2026-09-07T04:30:00.000Z');
    // Sunday evening IST: still the Monday before.
    expect(lastSlot(monday10, new Date('2026-09-13T15:00:00.000Z')).toISOString()).toBe('2026-09-07T04:30:00.000Z');
  });

  it('takes Sunday as 0 and an evening hour, across a month edge', () => {
    // Sunday 20:00 IST; 1 Nov 2026 is a Sunday.
    const sunday20 = { weekday: 0, hourIst: 20 };
    expect(lastSlot(sunday20, new Date('2026-11-03T12:00:00.000Z')).toISOString()).toBe('2026-11-01T14:30:00.000Z');
    expect(nextSlot(sunday20, new Date('2026-11-03T12:00:00.000Z')).toISOString()).toBe('2026-11-08T14:30:00.000Z');
  });
});

describe('the draft', () => {
  it('builds one DRAFT from every approved line in no open batch, as the actor, with the note and the audit row — and moves nothing else', async () => {
    fake.withdrawals.set('a', withdrawal('a'));
    fake.withdrawals.set('b', withdrawal('b', { netAmount: new Decimal('2500.50') }));
    fake.withdrawals.set('c', withdrawal('c', { status: 'REQUESTED' }));
    fake.withdrawals.set('d', withdrawal('d', { payoutMethod: { id: 'pm_d', status: 'PENDING' } }));
    fake.batches.set('bat_open', { id: 'bat_open', status: 'IN_REVIEW', reference: 'BATCH-2026-000009', note: null });
    fake.withdrawals.set('e', withdrawal('e', { batchId: 'bat_open' }));
    fake.batches.set('bat_done', { id: 'bat_done', status: 'COMPLETED', reference: 'BATCH-2026-000008', note: null });
    fake.withdrawals.set('f', withdrawal('f', { batchId: 'bat_done' })); // left APPROVED by a cancelled release path: draftable again

    const draft = await draftScheduledBatch('sys-1', NOW);
    expect(draft).not.toBeNull();
    expect(draft!.lineCount).toBe(3);
    expect(draft!.totalNet).toBe('4500.50');
    expect(draft!.moreWaiting).toBe(false);
    expect(draft!.batch).toMatchObject({ status: 'DRAFT', createdByUserId: 'sys-1', rail: 'MANUAL_NEFT', lineCount: 3 });
    expect(draft!.batch.note).toBe(`${SCHEDULE_NOTE_PREFIX} — 2026-09-14 10:30 IST`);
    expect(draft!.batch.lines.map((row) => row.id).sort()).toEqual(['a', 'b', 'f']);
    // Reserved lines stay APPROVED; nothing was submitted, approved or released.
    for (const id of ['a', 'b', 'f']) expect(fake.withdrawals.get(id)!.status).toBe('APPROVED');
    expect(fake.withdrawals.get('e')!.batchId).toBe('bat_open');
    expect(wallets.move).not.toHaveBeenCalled();
    expect(ledger.post).not.toHaveBeenCalled();
    expect(audit.logActivity).toHaveBeenCalledTimes(1);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'sys-1',
      'PAYOUT_BATCH_DRAFTED_BY_SCHEDULE',
      expect.objectContaining({
        module: 'payouts',
        targetType: 'PayoutBatch',
        targetId: draft!.batch.id,
        diff: expect.objectContaining({ status: { before: null, after: 'DRAFT' }, lineCount: { before: 0, after: 3 }, totalNet: { before: '0.00', after: '4500.50' } }),
        metadata: expect.objectContaining({ reference: draft!.batch.reference, withdrawalIds: ['a', 'b', 'f'], moreWaiting: false }),
      }),
    );
  });

  it('drafts nothing when nothing is draftable', async () => {
    fake.withdrawals.set('c', withdrawal('c', { status: 'PROCESSING' }));
    await expect(draftScheduledBatch('sys-1', NOW)).resolves.toBeNull();
    expect(repository.createBatch).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('caps a draft and says more is waiting', async () => {
    for (let i = 0; i < SCHEDULE_DRAFT_MAX_LINES + 3; i += 1) fake.withdrawals.set(`w${i}`, withdrawal(`w${i}`));
    const draft = await draftScheduledBatch('sys-1', NOW);
    expect(draft!.lineCount).toBe(SCHEDULE_DRAFT_MAX_LINES);
    expect(draft!.moreWaiting).toBe(true);
    expect(repository.findDraftableWithdrawals).toHaveBeenCalledWith(SCHEDULE_DRAFT_MAX_LINES + 1);
  });

  it('cancels the empty draft when the lines refuse to attach, and audits nothing', async () => {
    fake.withdrawals.set('a', withdrawal('a'));
    // The line moves between the read and the attach.
    repository.findWithdrawals.mockImplementationOnce(async (ids: string[]) => ids.map((id) => ({ ...fake.withdrawals.get(id), status: 'REJECTED' })));
    await expect(draftScheduledBatch('sys-1', NOW)).rejects.toMatchObject({ statusCode: 409 });
    expect([...fake.batches.values()][0]).toMatchObject({ status: 'CANCELLED', lineCount: 0 });
    expect(audit.logActivity).not.toHaveBeenCalled();
  });
});

describe('the schedule read', () => {
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

  it('answers the cadence, the next run and the last scheduled draft', async () => {
    fake.batches.set('bat_9', { id: 'bat_9', reference: 'BATCH-2026-000009', status: 'DRAFT', lineCount: 4, totalNet: new Decimal('8000'), note: `${SCHEDULE_NOTE_PREFIX} — 2026-09-07 10:00 IST`, createdAt: new Date('2026-09-07T04:31:00Z') });
    fake.batches.set('bat_10', { id: 'bat_10', reference: 'BATCH-2026-000010', status: 'DRAFT', lineCount: 1, totalNet: new Decimal('10'), note: 'By hand', createdAt: NOW });
    const schedule = await payoutBatchSchedule(NOW);
    expect(schedule).toEqual({
      enabled: true,
      weekday: 1,
      hourIst: 10,
      nextRunAt: new Date('2026-09-21T04:30:00.000Z'),
      lastDraft: { batchId: 'bat_9', reference: 'BATCH-2026-000009', status: 'DRAFT', lineCount: 4, totalNet: '8000.00', createdAt: new Date('2026-09-07T04:31:00Z') },
    });

    fake.settings = { enabled: false, weekday: 5, hourIst: 18 };
    expect((await payoutBatchSchedule(NOW)).nextRunAt).toBeNull();
  });

  it('is served at /finance/payout-batches/schedule ahead of /:id, ADMIN only', async () => {
    const admin = tokenFor(['ADMIN'], 'adm-1');
    const res = await request(app()).get('/api/v1/finance/payout-batches/schedule').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ enabled: true, weekday: 1, hourIst: 10, lastDraft: null });
    expect(typeof res.body.data.nextRunAt).toBe('string');
    expect(repository.findBatch).not.toHaveBeenCalled();
    expect((await request(app()).get('/api/v1/finance/payout-batches/schedule').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'pub-1')}`)).status).toBe(403);
  });
});
