import { csvCell, formatCsv } from '../../shared/csv';
import { ApiError } from '../../shared/errors';
import { money } from '../../shared/money';
import { MAX_LIST_PAGE_SIZE, toListPage, type ListPage } from '../../shared/pagination';
import { verifyLedger } from '../ledger';
import { storeGeneratedFile } from '../uploads';
import { snapshot } from '../wallets';
import { getPlatformSettings } from '../app-config';
import { deriveBatchStatus, syncBatchStatus } from './batch-status';
import {
  debitForRelease,
  failWithdrawal,
  isClosureWithdrawal,
  markWithdrawalPaid,
  walletShortfall,
} from './payouts.service';
import { prismaPayoutsRepository as repository } from './prisma-payouts.repository';
import { pickRail } from './rail';
import type { BatchRow, BatchView, PartyContext, WithdrawalRow } from './payouts.repository';
import type { PayoutBatchStatus, PayoutRailName } from '../../shared/database';

/**
 * Payout batches — Lot B (Q85/Q140).
 *
 * Approved withdrawals are paid together: a batch is built from reserved
 * lines, submitted, signed off by a second admin (four eyes — the database
 * CHECK backs the rule this file names), and released. Release is where the
 * money moves: each line's wallet debit and PAYOUT legs post at that moment,
 * one idempotent movement per line, and on the manual rail the bank's
 * bulk-transfer file is written for finance to upload. A vendor rail is paid
 * line by line instead.
 *
 * A batch's status after release is derived from its lines and never set by
 * hand: COMPLETED when every line is PAID, FAILED when every line bounced,
 * PARTIALLY_FAILED between the two, RELEASED while any is still with the
 * rail. Cancelling is only possible before release and simply un-batches the
 * lines — they stay APPROVED and reserved, because nothing moved.
 */

export { deriveBatchStatus };

/* ------------------------------------------------------------------ */
/* Building                                                            */
/* ------------------------------------------------------------------ */

async function nextBatchReference(now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  let n = (await repository.countBatchesForYear(year)) + 1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const reference = `BATCH-${year}-${String(n).padStart(6, '0')}`;
    if (!(await repository.batchReferenceExists(reference))) return reference;
    n += 1;
  }
  throw new ApiError(500, 'INTERNAL_ERROR', 'Could not allocate a batch reference');
}

export async function getBatch(id: string): Promise<BatchView> {
  const batch = await repository.findBatch(id);
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Payout batch not found');
  return batch;
}

export async function listBatches(query: {
  status?: readonly string[] | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}): Promise<ListPage<BatchRow>> {
  const { items, total, counts } = await repository.listBatches({
    ...(query.status?.length ? { status: query.status as PayoutBatchStatus[] } : {}),
    ...(query.q ? { q: query.q } : {}),
    page: query.page,
    pageSize: query.pageSize,
  });
  return toListPage(items, total, counts, query);
}

/* ── G13-B: the batch export ─────────────────────────────────────── */

/** How many batches one CSV pull may carry — a year of weekly drafts is under a hundred. */
export const BATCH_EXPORT_MAX_ROWS = 5000;

/**
 * Every batch under the filters, newest first — the same list read walked
 * page by page at the list's own cap, stopping at its total or at
 * `BATCH_EXPORT_MAX_ROWS`, so the export can never disagree with the desk.
 */
export async function batchesForExport(query: { status?: readonly string[] | undefined; q?: string | undefined }): Promise<BatchRow[]> {
  const rows: BatchRow[] = [];
  for (let page = 1; rows.length < BATCH_EXPORT_MAX_ROWS; page += 1) {
    const { items, total } = await repository.listBatches({
      ...(query.status?.length ? { status: query.status as PayoutBatchStatus[] } : {}),
      ...(query.q ? { q: query.q } : {}),
      page,
      pageSize: MAX_LIST_PAGE_SIZE,
    });
    rows.push(...items);
    if (items.length === 0 || rows.length >= total) break;
  }
  return rows.slice(0, BATCH_EXPORT_MAX_ROWS);
}

export const BATCH_EXPORT_HEADER = [
  'reference',
  'status',
  'rail',
  'lineCount',
  'totalNet',
  'createdBy',
  'approvedBy',
  'submittedAt',
  'approvedAt',
  'releasedAt',
  'completedAt',
  'createdAt',
  'note',
] as const;

type ExportRow = BatchRow & { createdBy: { id: string; name: string | null }; approvedBy: { id: string; name: string | null } | null };

const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null);

/** A header, then one CRLF-terminated line per batch — the actors by name, falling back to the id. */
export function batchExportCsvLines(batches: readonly ExportRow[]): string[] {
  const line = (cells: readonly (string | number | null | undefined)[]) => cells.map(csvCell).join(',') + '\r\n';
  return [
    line(BATCH_EXPORT_HEADER),
    ...batches.map((batch) =>
      line([
        batch.reference,
        batch.status,
        batch.rail,
        batch.lineCount,
        money(batch.totalNet),
        batch.createdBy.name ?? batch.createdBy.id,
        batch.approvedBy ? (batch.approvedBy.name ?? batch.approvedBy.id) : null,
        iso(batch.submittedAt),
        iso(batch.approvedAt),
        iso(batch.releasedAt),
        iso(batch.completedAt),
        iso(batch.createdAt),
        batch.note,
      ]),
    ),
  ];
}

async function assertBankAccountUsable(bankAccountId: string): Promise<void> {
  const account = await repository.findBankAccount(bankAccountId);
  if (!account) throw new ApiError(404, 'NOT_FOUND', 'Bank account not found');
  if (!account.isActive) {
    throw new ApiError(409, 'CONFLICT', `${account.label} is switched off. Choose an active account to draw the batch on.`);
  }
}

/** A DRAFT on the platform's rail unless one is named, drawn on an ADX account. */
export async function createBatch(
  input: {
    byUserId: string;
    rail?: PayoutRailName | null;
    bankAccountId?: string | null;
    note?: string | null;
    scheduledFor?: Date | null;
    cutoffAt?: Date | null;
  },
  now = new Date()
): Promise<BatchRow> {
  if (input.bankAccountId) await assertBankAccountUsable(input.bankAccountId);
  const { finance } = await getPlatformSettings();
  return repository.createBatch({
    reference: await nextBatchReference(now),
    rail: input.rail ?? finance.primaryRail,
    bankAccountId: input.bankAccountId ?? null,
    createdByUserId: input.byUserId,
    note: input.note ?? null,
    scheduledFor: input.scheduledFor ?? null,
    cutoffAt: input.cutoffAt ?? null,
  });
}

const OPEN_BATCH: readonly PayoutBatchStatus[] = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'RELEASING'];

/**
 * Replaces the batch's line set. Only a reserved (APPROVED) line with a
 * VERIFIED method that is in no other open batch may join; anything else is
 * refused as a whole, naming each offender, so a half-built batch never
 * exists.
 */
export async function setBatchLines(batchId: string, withdrawalIds: string[], _now = new Date()): Promise<BatchView> {
  const batch = await getBatch(batchId);
  if (batch.status !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', `Lines can only be changed on a draft; this batch is ${batch.status.toLowerCase()}.`);
  }
  const wanted = Array.from(new Set(withdrawalIds));
  const rows = await repository.findWithdrawals(wanted);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const problems: { withdrawalId: string; problem: string }[] = [];
  for (const id of wanted) {
    const row = byId.get(id);
    if (!row) {
      problems.push({ withdrawalId: id, problem: 'NOT_FOUND' });
      continue;
    }
    if (row.status !== 'APPROVED') problems.push({ withdrawalId: id, problem: `NOT_APPROVED:${row.status}` });
    if (row.payoutMethod.status !== 'VERIFIED') problems.push({ withdrawalId: id, problem: 'METHOD_NOT_VERIFIED' });
    if (row.batchId && row.batchId !== batchId) {
      const other = await repository.findBatch(row.batchId);
      if (other && OPEN_BATCH.includes(other.status)) {
        problems.push({ withdrawalId: id, problem: `IN_BATCH:${other.reference}` });
      }
    }
  }
  if (problems.length) {
    throw new ApiError(409, 'CONFLICT', 'Some lines cannot join this batch', { problems });
  }

  const current = new Set(batch.lines.map((row) => row.id));
  const attach = wanted.filter((id) => !current.has(id));
  const detach = batch.lines.map((row) => row.id).filter((id) => !wanted.includes(id));
  await repository.setBatchLines(batchId, attach, detach);
  return getBatch(batchId);
}

/* ------------------------------------------------------------------ */
/* Four eyes                                                           */
/* ------------------------------------------------------------------ */

export async function submitBatch(batchId: string, byUserId: string, now = new Date()): Promise<BatchView> {
  const batch = await getBatch(batchId);
  if (batch.status !== 'DRAFT') {
    throw new ApiError(409, 'CONFLICT', `This batch is ${batch.status.toLowerCase()}.`);
  }
  if (batch.lines.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Add at least one line before submitting the batch.');
  }
  void byUserId;
  await repository.updateBatch(batchId, { status: 'IN_REVIEW', submittedAt: now });
  return getBatch(batchId);
}

/** A different admin from the one who built it — 409 FOUR_EYES otherwise; the DB CHECK backs it. */
export async function approveBatch(batchId: string, byUserId: string, now = new Date()): Promise<BatchView> {
  const batch = await getBatch(batchId);
  if (batch.status !== 'IN_REVIEW') {
    throw new ApiError(409, 'CONFLICT', `Only a batch in review can be approved; this one is ${batch.status.toLowerCase()}.`);
  }
  if (batch.createdByUserId === byUserId) {
    throw new ApiError(409, 'FOUR_EYES', 'A payout batch must be approved by someone other than the admin who built it.');
  }
  await repository.updateBatch(batchId, { status: 'APPROVED', approvedByUserId: byUserId, approvedAt: now });
  return getBatch(batchId);
}

/** Before release only. The lines go back to reserved-and-unbatched; nothing moved, so nothing reverses. */
export async function cancelBatch(batchId: string, byUserId: string, now = new Date()): Promise<BatchView> {
  const batch = await getBatch(batchId);
  if (!['DRAFT', 'IN_REVIEW', 'APPROVED'].includes(batch.status)) {
    throw new ApiError(409, 'CONFLICT', `A ${batch.status.toLowerCase()} batch cannot be cancelled.`);
  }
  void byUserId;
  void now;
  await repository.setBatchLines(batchId, [], batch.lines.map((row) => row.id));
  await repository.updateBatch(batchId, { status: 'CANCELLED' });
  return getBatch(batchId);
}

/* ------------------------------------------------------------------ */
/* Preflight                                                           */
/* ------------------------------------------------------------------ */

export type LinePreflight = {
  withdrawalId: string;
  reference: string;
  netAmount: string;
  problems: string[];
};

export type BatchPreflight = {
  ok: boolean;
  rail: { name: PayoutRailName; configured: boolean };
  ledgerHealthy: boolean;
  lines: LinePreflight[];
};

async function preflightLine(row: WithdrawalRow, party: PartyContext | null, now: Date): Promise<string[]> {
  const problems: string[] = [];
  if (row.status !== 'APPROVED' && row.status !== 'PROCESSING') problems.push(`NOT_APPROVED:${row.status}`);
  if (row.payoutMethod.status !== 'VERIFIED') problems.push('METHOD_NOT_VERIFIED');
  if (!party) {
    problems.push('WALLET_MISSING');
    return problems;
  }
  // Lot B (B4b): a print partner has no KYC record — ops vets one at the desk
  // (GSTIN, PAN) when it is created — and its `userActive` is the partner's own
  // switch, since the User row is sign-in-disabled by design.
  if (party.kind !== 'PRINT_PARTNER' && party.kycStatus !== 'VERIFIED') problems.push('KYC_NOT_VERIFIED');
  if (party.userActive === false) problems.push(party.kind === 'PRINT_PARTNER' ? 'PARTNER_INACTIVE' : 'USER_INACTIVE');
  // A line already released has left the wallet: nothing to re-check.
  if (row.status === 'APPROVED') {
    const balances = await snapshot(row.walletId, now);
    if (walletShortfall(row, balances) !== null) problems.push('WALLET_SHORT');
    if (balances.frozenAt && !isClosureWithdrawal(row)) problems.push('WALLET_FROZEN');
  }
  return problems;
}

/**
 * Everything release will refuse on, in one read: each line's method, KYC,
 * wallet cover and freeze, the party's account, plus the rail's
 * configuration and the books' health once for the batch.
 */
export async function preflightBatch(batchId: string, now = new Date()): Promise<BatchPreflight> {
  const batch = await getBatch(batchId);
  const { finance } = await getPlatformSettings();
  const rail = pickRail(batch.rail, finance);
  const ledger = await verifyLedger();
  const lines: LinePreflight[] = [];
  for (const row of batch.lines) {
    const party = await repository.findPartyContext(row.walletId);
    lines.push({
      withdrawalId: row.id,
      reference: row.reference,
      netAmount: money(row.netAmount),
      problems: await preflightLine(row, party, now),
    });
  }
  const railOk = rail.name === batch.rail && rail.isConfigured();
  return {
    ok: railOk && ledger.healthy && lines.length > 0 && lines.every((line) => line.problems.length === 0),
    rail: { name: batch.rail, configured: railOk },
    ledgerHealthy: ledger.healthy,
    lines,
  };
}

/* ------------------------------------------------------------------ */
/* Release                                                             */
/* ------------------------------------------------------------------ */

export const BATCH_CSV_HEADER = ['Beneficiary Name', 'Account Number', 'IFSC', 'Amount', 'Narration', 'Email', 'Mobile'] as const;

/**
 * The bank's bulk-transfer file: one row per line, narration = the WDR
 * reference so the statement line comes back carrying it. A UPI method has
 * no IFSC; its VPA goes in the account column and the bank's upload will say
 * whether it takes it.
 */
export async function buildBatchCsv(batch: BatchView): Promise<string> {
  const rows: (string | null)[][] = [[...BATCH_CSV_HEADER]];
  for (const row of batch.lines) {
    const party = await repository.findPartyContext(row.walletId);
    const method = row.payoutMethod;
    rows.push([
      method.accountHolder ?? party?.name ?? '',
      method.accountNumber ?? method.upiVpa ?? '',
      method.ifscCode ?? '',
      money(row.netAmount),
      row.reference,
      party?.email ?? '',
      party?.mobile ?? '',
    ]);
  }
  return formatCsv(rows);
}

export type ReleaseOutcome = {
  batch: BatchView;
  released: number;
  failed: number;
  skipped: number;
  exportFileId: string | null;
};

/**
 * Where the money moves. Each line: the debit and its PAYOUT legs (idempotent
 * on the withdrawal), then PROCESSING on the manual rail — the bank file
 * carries it — or the vendor's answer on a vendor rail. A line the vendor
 * refuses is reversed at once and ends FAILED. Allowed from APPROVED, and
 * again from RELEASING so a release that died half-way can be finished:
 * lines already out are skipped.
 */
export async function releaseBatch(batchId: string, byUserId: string, now = new Date()): Promise<ReleaseOutcome> {
  const batch = await getBatch(batchId);
  if (batch.status !== 'APPROVED' && batch.status !== 'RELEASING') {
    throw new ApiError(409, 'CONFLICT', `Only an approved batch can be released; this one is ${batch.status.toLowerCase()}.`);
  }
  const preflight = await preflightBatch(batchId, now);
  if (!preflight.ok) {
    throw new ApiError(409, 'CONFLICT', 'The batch did not pass preflight; nothing was released.', preflight);
  }
  const { finance } = await getPlatformSettings();
  const rail = pickRail(batch.rail, finance);

  await repository.updateBatch(batchId, { status: 'RELEASING' });

  let released = 0;
  let failed = 0;
  let skipped = 0;
  for (const line of batch.lines) {
    if (line.status !== 'APPROVED') {
      skipped += 1;
      continue;
    }
    const { ledgerTransactionId } = await debitForRelease(line, { byUserId }, now);
    const processing = await repository.updateWithdrawal(line.id, {
      status: 'PROCESSING',
      rail: rail.name,
      ledgerTransactionId,
    });

    if (rail.name === 'MANUAL_NEFT') {
      released += 1;
      continue;
    }

    const party = await repository.findPartyContext(line.walletId);
    const result = await rail.pay({
      withdrawalId: line.id,
      reference: line.reference,
      amount: money(line.netAmount),
      method: line.payoutMethod,
      beneficiaryName: line.payoutMethod.accountHolder ?? party?.name ?? '',
    });
    if (result.status === 'FAILED') {
      await failWithdrawal(processing.id, { reason: result.reason, byUserId }, now);
      failed += 1;
    } else if (result.status === 'PAID') {
      await markWithdrawalPaid(processing.id, { railReference: result.railReference, byUserId }, now);
      released += 1;
    } else {
      await repository.updateWithdrawal(processing.id, {
        ...(result.railReference ? { railReference: result.railReference } : {}),
      });
      released += 1;
    }
  }

  let exportFileId = batch.exportFileId ?? null;
  if (rail.name === 'MANUAL_NEFT') {
    const file = await storeGeneratedFile(byUserId, {
      content: await buildBatchCsv(await getBatch(batchId)),
      filename: `${batch.reference}.csv`,
      mimeType: 'text/csv',
      purpose: 'PAYOUT_EXPORT',
    });
    exportFileId = file.id;
  }

  await repository.updateBatch(batchId, { status: 'RELEASED', releasedAt: batch.releasedAt ?? now, exportFileId });
  await syncBatchStatus(batchId, now);
  return { batch: await getBatch(batchId), released, failed, skipped, exportFileId };
}

/* ------------------------------------------------------------------ */
/* After release                                                       */
/* ------------------------------------------------------------------ */

async function lineOf(batchId: string, withdrawalId: string): Promise<{ batch: BatchView; line: WithdrawalRow }> {
  const batch = await getBatch(batchId);
  const line = batch.lines.find((row) => row.id === withdrawalId);
  if (!line) throw new ApiError(404, 'NOT_FOUND', 'That withdrawal is not a line of this batch');
  return { batch, line };
}

/** Finance confirms one line landed, with its UTR. The batch completes when every line has. */
export async function markBatchLinePaid(
  batchId: string,
  withdrawalId: string,
  input: { utr: string; byUserId: string },
  now = new Date()
): Promise<{ line: WithdrawalRow; batch: BatchView }> {
  await lineOf(batchId, withdrawalId);
  const line = await markWithdrawalPaid(withdrawalId, { railReference: input.utr, byUserId: input.byUserId }, now);
  return { line, batch: await getBatch(batchId) };
}

/** One line bounced: its legs are reversed and the money returns to the wallet. */
export async function failBatchLine(
  batchId: string,
  withdrawalId: string,
  input: { reason: string; byUserId: string },
  now = new Date()
): Promise<{ line: WithdrawalRow; batch: BatchView }> {
  if (!input.reason.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'Say why the transfer failed.');
  await lineOf(batchId, withdrawalId);
  const line = await failWithdrawal(withdrawalId, { reason: input.reason.trim(), byUserId: input.byUserId }, now);
  return { line, batch: await getBatch(batchId) };
}

/* ------------------------------------------------------------------ */
/* ADX bank accounts (Q85)                                             */
/* ------------------------------------------------------------------ */

/** Only the last four digits are ever stored — see `NewBankAccount`. */
export const maskAccountNumber = (accountNumber: string): string => `•••• ${accountNumber.trim().slice(-4)}`;

export const listBankAccounts = () => repository.listBankAccounts();
export const findBankAccount = (id: string) => repository.findBankAccount(id);

export type BankAccountInput = {
  id?: string | null;
  label: string;
  bankName: string;
  accountHolder?: string | null;
  /** The whole number on the way in; masked before it is written. */
  accountNumber?: string | null;
  ifsc: string;
  isActive?: boolean;
  isDefault?: boolean;
};

/** Creates without an id, updates with one. One default: setting it clears the rest. */
export async function saveBankAccount(input: BankAccountInput) {
  if (input.id) {
    const existing = await repository.findBankAccount(input.id);
    if (!existing) throw new ApiError(404, 'NOT_FOUND', 'Bank account not found');
    const after = await repository.updateBankAccount(input.id, {
      label: input.label,
      bankName: input.bankName,
      accountHolder: input.accountHolder ?? existing.accountHolder,
      ...(input.accountNumber ? { accountNumberMasked: maskAccountNumber(input.accountNumber) } : {}),
      ifsc: input.ifsc.trim().toUpperCase(),
      isActive: input.isActive ?? existing.isActive,
      isDefault: input.isDefault ?? existing.isDefault,
    });
    return { before: existing, after };
  }
  if (!input.accountNumber) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A new bank account needs its account number.');
  }
  const others = await repository.listBankAccounts();
  const after = await repository.createBankAccount({
    label: input.label,
    bankName: input.bankName,
    accountHolder: input.accountHolder ?? null,
    accountNumberMasked: maskAccountNumber(input.accountNumber),
    ifsc: input.ifsc.trim().toUpperCase(),
    isActive: input.isActive ?? true,
    // The first account is the default; nobody should have to choose one of one.
    isDefault: input.isDefault ?? others.length === 0,
  });
  return { before: null, after };
}
