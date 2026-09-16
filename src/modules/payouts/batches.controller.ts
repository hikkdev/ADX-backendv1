import type { Request, Response } from 'express';
import { auditDiff, logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { money } from '../../shared/money';
import {
  approveBatch,
  batchExportCsvLines,
  batchesForExport,
  buildBatchCsv,
  cancelBatch,
  createBatch,
  failBatchLine,
  getBatch,
  listBankAccounts,
  listBatches,
  markBatchLinePaid,
  preflightBatch,
  releaseBatch,
  saveBankAccount,
  setBatchLines,
  submitBatch,
} from './batches.service';
import { payoutBatchSchedule } from './batch-draft.service';
import * as schema from './batches.schema';
import { shapeBankAccount, shapeBatch, shapeWithdrawal, withBatchActors } from './payouts.shape';
import type { BatchView } from './payouts.repository';

/**
 * `/finance/payout-batches` and `/finance/bank-accounts` — Lot B (Q85/Q140).
 *
 * Every write is audited by hand against the batch (or the bank account)
 * with the status before and after, because these are the writes an auditor
 * asks about first: who built the batch, who signed it off, who released it.
 */

function parse<T>(s: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = s.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

const userId = (req: Request) => req.user!.sub;
const batchId = (req: Request) => req.params['id'] as string;
const lineId = (req: Request) => req.params['withdrawalId'] as string;

const shapeView = (batch: BatchView) => ({
  ...shapeBatch(batch),
  bankAccount: batch.bankAccount ? shapeBankAccount(batch.bankAccount) : null,
  lines: batch.lines.map(shapeWithdrawal),
});

/**
 * The batch detail — what `GET /finance/payout-batches/:id` answers and
 * (T-B) what every write on a batch answers: the shaped batch with its bank
 * account and lines, and (E6) who built and approved it by name, through
 * the user-label port. One lookup beside the write.
 */
async function batchDetailView(batch: BatchView) {
  const [view] = await withBatchActors([shapeView(batch)]);
  return view!;
}

async function audit(
  req: Request,
  action: string,
  batch: { id: string; reference: string },
  before: string | null,
  after: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await logActivity(userId(req), action, {
    req,
    module: 'payouts',
    targetType: 'PayoutBatch',
    targetId: batch.id,
    diff: auditDiff({ status: before }, { status: after }),
    metadata: { reference: batch.reference, ...metadata },
  });
}

/* ── Batches ──────────────────────────────────────────────────────── */

export async function listBatchesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<import('zod').infer<typeof schema.batchListQuerySchema>>(schema.batchListQuerySchema, req.query);
  const page = await listBatches(query);
  // E6: who built and approved each batch, by name.
  res.json({ success: true, data: { ...page, items: await withBatchActors(page.items.map(shapeBatch)) } });
}

/**
 * GET /finance/payout-batches/export.csv — G13-B: the batches under the
 * filters in force, one line each. Audited before the first byte, the way
 * the analytics export is: an export that fails half-way was still one.
 */
export async function exportBatchesHandler(req: Request, res: Response): Promise<void> {
  const query = parse<schema.BatchExportQuery>(schema.batchExportQuerySchema, req.query);
  const rows = await withBatchActors(await batchesForExport(query));
  await logActivity(userId(req), 'PAYOUT_BATCHES_EXPORTED', {
    req,
    module: 'payouts',
    metadata: { status: query.status ?? null, q: query.q ?? null, rows: rows.length },
  });
  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="payout-batches-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  for (const line of batchExportCsvLines(rows)) res.write(line);
  res.end();
}

export async function createBatchHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.CreateBatchInput>(schema.createBatchSchema, req.body ?? {});
  const batch = await createBatch({
    byUserId: userId(req),
    rail: body.rail ?? null,
    bankAccountId: body.bankAccountId ?? null,
    note: body.note ?? null,
    scheduledFor: body.scheduledFor ?? null,
    cutoffAt: body.cutoffAt ?? null,
  });
  await audit(req, 'PAYOUT_BATCH_CREATED', batch, null, batch.status, { rail: batch.rail, bankAccountId: batch.bankAccountId });
  res.status(201).json({ success: true, data: await batchDetailView(await getBatch(batch.id)) });
}

/** GET /finance/payout-batches/schedule — Lot G (Q124): the weekly draft's cadence, when it next runs, and its last draft. */
export async function batchScheduleHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await payoutBatchSchedule() });
}

export async function getBatchHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await batchDetailView(await getBatch(batchId(req))) });
}

export async function setLinesHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ withdrawalIds: string[] }>(schema.setLinesSchema, req.body);
  const before = await getBatch(batchId(req));
  const batch = await setBatchLines(batchId(req), body.withdrawalIds);
  await logActivity(userId(req), 'PAYOUT_BATCH_LINES_SET', {
    req,
    module: 'payouts',
    targetType: 'PayoutBatch',
    targetId: batch.id,
    diff: auditDiff(
      { lineCount: before.lineCount, totalNet: money(before.totalNet) },
      { lineCount: batch.lineCount, totalNet: money(batch.totalNet) }
    ),
    metadata: { reference: batch.reference, withdrawalIds: body.withdrawalIds },
  });
  res.json({ success: true, data: await batchDetailView(batch) });
}

export async function submitBatchHandler(req: Request, res: Response): Promise<void> {
  const before = await getBatch(batchId(req));
  const batch = await submitBatch(batchId(req), userId(req));
  await audit(req, 'PAYOUT_BATCH_SUBMITTED', batch, before.status, batch.status, { lineCount: batch.lineCount, totalNet: money(batch.totalNet) });
  res.json({ success: true, data: await batchDetailView(batch) });
}

export async function approveBatchHandler(req: Request, res: Response): Promise<void> {
  const before = await getBatch(batchId(req));
  const batch = await approveBatch(batchId(req), userId(req));
  await audit(req, 'PAYOUT_BATCH_APPROVED', batch, before.status, batch.status, {
    createdByUserId: batch.createdByUserId,
    lineCount: batch.lineCount,
    totalNet: money(batch.totalNet),
  });
  res.json({ success: true, data: await batchDetailView(batch) });
}

export async function releaseBatchHandler(req: Request, res: Response): Promise<void> {
  const before = await getBatch(batchId(req));
  const outcome = await releaseBatch(batchId(req), userId(req));
  await audit(req, 'PAYOUT_BATCH_RELEASED', outcome.batch, before.status, outcome.batch.status, {
    rail: outcome.batch.rail,
    released: outcome.released,
    failed: outcome.failed,
    skipped: outcome.skipped,
    totalNet: money(outcome.batch.totalNet),
    exportFileId: outcome.exportFileId,
  });
  res.json({
    success: true,
    data: { ...(await batchDetailView(outcome.batch)), released: outcome.released, failed: outcome.failed, skipped: outcome.skipped },
  });
}

export async function cancelBatchHandler(req: Request, res: Response): Promise<void> {
  const before = await getBatch(batchId(req));
  const batch = await cancelBatch(batchId(req), userId(req));
  await audit(req, 'PAYOUT_BATCH_CANCELLED', batch, before.status, batch.status, {
    releasedLines: before.lines.map((line) => line.id),
  });
  res.json({ success: true, data: await batchDetailView(batch) });
}

export async function preflightBatchHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await preflightBatch(batchId(req)) });
}

/**
 * The bank upload file, regenerated from the lines — byte-for-byte what was
 * stored at release, and available before release as a preview.
 */
export async function exportBatchHandler(req: Request, res: Response): Promise<void> {
  const batch = await getBatch(batchId(req));
  const csv = await buildBatchCsv(batch);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${batch.reference}.csv"`);
  res.send(csv);
}

export async function markLinePaidHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ utr: string }>(schema.lineMarkPaidSchema, req.body);
  const { line, batch } = await markBatchLinePaid(batchId(req), lineId(req), { utr: body.utr, byUserId: userId(req) });
  await logActivity(userId(req), 'WITHDRAWAL_MARKED_PAID', {
    req,
    module: 'payouts',
    targetType: 'WithdrawalRequest',
    targetId: line.id,
    diff: auditDiff({ status: 'PROCESSING', railReference: null }, { status: line.status, railReference: line.railReference }),
    metadata: { reference: line.reference, batchId: batch.id, batchReference: batch.reference, netAmount: money(line.netAmount), batchStatus: batch.status },
  });
  res.json({ success: true, data: { line: shapeWithdrawal(line), batch: shapeBatch(batch) } });
}

export async function failLineHandler(req: Request, res: Response): Promise<void> {
  const body = parse<{ reason: string }>(schema.lineFailSchema, req.body);
  const { line, batch } = await failBatchLine(batchId(req), lineId(req), { reason: body.reason, byUserId: userId(req) });
  await logActivity(userId(req), 'WITHDRAWAL_FAILED', {
    req,
    module: 'payouts',
    targetType: 'WithdrawalRequest',
    targetId: line.id,
    diff: auditDiff({ status: 'PROCESSING' }, { status: line.status }),
    metadata: { reference: line.reference, batchId: batch.id, batchReference: batch.reference, reason: body.reason, batchStatus: batch.status },
  });
  res.json({ success: true, data: { line: shapeWithdrawal(line), batch: shapeBatch(batch) } });
}

/* ── ADX bank accounts ────────────────────────────────────────────── */

export async function listBankAccountsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: (await listBankAccounts()).map(shapeBankAccount) });
}

export async function saveBankAccountHandler(req: Request, res: Response): Promise<void> {
  const body = parse<schema.BankAccountInput>(schema.bankAccountSchema, req.body);
  const { before, after } = await saveBankAccount(body);
  await logActivity(userId(req), before ? 'BANK_ACCOUNT_UPDATED' : 'BANK_ACCOUNT_CREATED', {
    req,
    module: 'payouts',
    targetType: 'BankAccount',
    targetId: after.id,
    // Only the masked number ever reaches the log: the whole one was never stored.
    diff: auditDiff(before, after, ['label', 'bankName', 'accountHolder', 'accountNumberMasked', 'ifsc', 'isActive', 'isDefault']),
  });
  res.status(before ? 200 : 201).json({ success: true, data: shapeBankAccount(after) });
}
