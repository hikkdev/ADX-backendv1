import { ApiError } from '../../shared/errors';
import { Decimal, money, type Money } from '../../shared/money';
import { toListPage, type ListPage } from '../../shared/pagination';
import {
  findTopUp,
  findTopUpByPaymentId,
  findTopUpByUtr,
  markTopUpReconciled,
} from '../advertisers';
import { getTransaction, listTransactions, platformAccount, post as postLedger, reverse as reverseLedger } from '../ledger';
import { findBankAccount, findWithdrawal, findWithdrawalByReference, findWithdrawalByUtr } from '../payouts';
import { storeGeneratedFile } from '../uploads';
import { parseStatement, type ProfileColumns } from './csv';
import { prismaReconciliationRepository as repository } from './prisma-reconciliation.repository';
import type { ImportRow, LineRow, MatchRow, NewMatch, ProfileRow, StatusSummary } from './reconciliation.repository';
import type { BankLineMatchStatus, LedgerTransactionKind } from '../../shared/database';

/**
 * Bank-statement reconciliation — Lot B (Q85).
 *
 * The books say what should have happened at the bank; the statement says
 * what did. This module lines the two up. A statement is imported as lines
 * (generic CSV, a per-bank profile when the bank names its columns
 * differently), and each line is then explained by exactly one ADX record:
 *
 *   a paid withdrawal      by UTR, or by the WDR reference in the narration
 *   a recorded top-up      by UTR, or by the gateway's payment id
 *   a ledger transaction   by kind, amount and value date, when nothing
 *                          else names it — and only when there is one
 *
 * A line whose record disagrees on the amount is DIFFERS, never quietly
 * MATCHED: the difference is stored and a person decides. A top-up by
 * transfer or cheque sits in `platform:suspense` until its bank line is
 * matched; the match settles it into cash, and unmatching reverses that.
 */

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

export const listProfiles = (): Promise<ProfileRow[]> => repository.listProfiles();

export async function createProfile(input: {
  name: string;
  bankName: string;
  columns: ProfileColumns;
  dateFormat?: string | null;
}): Promise<ProfileRow> {
  const existing = (await repository.listProfiles()).find((row) => row.name.toLowerCase() === input.name.trim().toLowerCase());
  if (existing) throw new ApiError(409, 'CONFLICT', `A profile named ${existing.name} already exists`);
  return repository.createProfile({
    name: input.name.trim(),
    bankName: input.bankName.trim(),
    columns: Object.fromEntries(Object.entries(input.columns).filter(([, value]) => typeof value === 'string' && value)) as Record<string, string>,
    dateFormat: input.dateFormat?.trim() || null,
  });
}

/* ------------------------------------------------------------------ */
/* Imports                                                             */
/* ------------------------------------------------------------------ */

export type ImportOutcome = {
  import: ImportRow;
  created: number;
  duplicates: number;
  problems: { row: number; problem: string }[];
};

/**
 * Parses, keeps the file as uploaded, writes the new lines and reports the
 * counts. A file with nothing readable is refused with the parser's reasons;
 * a file with some bad rows lands the good ones and names the rest.
 */
export async function importStatement(
  input: {
    bankAccountId: string;
    profileId?: string | null;
    file: { buffer: Buffer; originalname: string };
    byUserId: string;
  },
  now = new Date()
): Promise<ImportOutcome> {
  const account = await findBankAccount(input.bankAccountId);
  if (!account) throw new ApiError(404, 'NOT_FOUND', 'Bank account not found');

  let profile: ProfileRow | null = null;
  if (input.profileId) {
    profile = await repository.findProfile(input.profileId);
    if (!profile) throw new ApiError(404, 'NOT_FOUND', 'Statement profile not found');
  }

  const parsed = parseStatement(input.file.buffer.toString('utf8'), {
    columns: (profile?.columns as Partial<ProfileColumns> | null) ?? null,
    dateFormat: profile?.dateFormat ?? null,
  });
  if (parsed.lines.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No statement lines could be read from that file', { problems: parsed.problems });
  }

  const stored = await storeGeneratedFile(input.byUserId, {
    content: input.file.buffer,
    filename: input.file.originalname,
    mimeType: 'text/csv',
    purpose: 'BANK_STATEMENT',
  });

  const created = await repository.createImport({
    bankAccountId: account.id,
    profileId: profile?.id ?? null,
    fileId: stored.id,
    fileName: input.file.originalname,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    importedByUserId: input.byUserId,
  });
  void now;
  const counts = await repository.addLines(created.id, account.id, parsed.lines);
  const row = (await repository.findImport(created.id)) ?? created;
  return { import: row, created: counts.created, duplicates: counts.duplicates, problems: parsed.problems };
}

export const listImports = (filter: { bankAccountId?: string | undefined; limit?: number | undefined }) =>
  repository.listImports({ bankAccountId: filter.bankAccountId, limit: Math.min(filter.limit ?? 50, 200) });

/* ------------------------------------------------------------------ */
/* Lines                                                               */
/* ------------------------------------------------------------------ */

export async function listLines(query: {
  status?: readonly string[] | undefined;
  bankAccountId?: string | undefined;
  importId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}): Promise<ListPage<LineRow>> {
  const { items, total, counts } = await repository.listLines(
    {
      status: query.status as BankLineMatchStatus[] | undefined,
      bankAccountId: query.bankAccountId,
      importId: query.importId,
      from: query.from,
      to: query.to,
      q: query.q,
    },
    query
  );
  return toListPage(items, total, counts, query);
}

export async function getLine(id: string): Promise<LineRow> {
  const line = await repository.findLine(id);
  if (!line) throw new ApiError(404, 'NOT_FOUND', 'Statement line not found');
  return line;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/** What a line can be explained by, resolved to the amount the books say. */
type Target = {
  withdrawalId: string | null;
  topUpId: string | null;
  paymentId: string | null;
  ledgerTransactionId: string | null;
  amount: Decimal;
  /** A transfer or cheque top-up still sitting in suspense. */
  settleSuspense: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 2;
const WDR_IN_TEXT = /WDR-\d{4}-\d{6}/i;

const debitKinds: LedgerTransactionKind[] = ['PAYOUT', 'REFUND'];
const creditKinds: LedgerTransactionKind[] = ['TOPUP'];

const endOfDay = (date: Date) => new Date(date.getTime() + DAY_MS - 1);

function targetFromWithdrawal(row: { id: string; netAmount: Decimal | string }): Target {
  return { withdrawalId: row.id, topUpId: null, paymentId: null, ledgerTransactionId: null, amount: new Decimal(row.netAmount), settleSuspense: false };
}

function targetFromTopUp(row: { id: string; amount: Decimal | string; method: string; paymentId?: string | null }, paymentId: string | null = null): Target {
  return {
    withdrawalId: null,
    topUpId: row.id,
    paymentId: paymentId ?? row.paymentId ?? null,
    ledgerTransactionId: null,
    amount: new Decimal(row.amount),
    settleSuspense: row.method !== 'GATEWAY',
  };
}

/** The cash-side leg of a transaction, signed from the account's point of view. */
function cashLegAmount(tx: { legs: { account: { code: string }; amount: Decimal }[] }): Decimal | null {
  const leg = tx.legs.find((row) => row.account.code === 'platform:cash' || row.account.code === 'platform:suspense');
  return leg ? new Decimal(leg.amount) : null;
}

/**
 * Money leaving ADX is a credit to `platform:cash` (positive leg), money
 * arriving a debit (negative) — see the ledger's sign convention. So a bank
 * DEBIT line looks for a positive cash leg and a CREDIT line for a negative
 * one, on cash or on suspense.
 */
function legMatchesLine(line: LineRow, tx: { legs: { account: { code: string }; amount: Decimal }[] }): boolean {
  const leg = cashLegAmount(tx);
  if (!leg) return false;
  const amount = new Decimal(line.amount);
  return line.direction === 'DEBIT' ? leg.equals(amount) : leg.equals(amount.negated());
}

async function recordMatch(
  line: LineRow,
  target: Target,
  input: { kind: 'AUTO' | 'MANUAL'; byUserId: string; note?: string | null },
  now: Date
): Promise<LineRow> {
  const difference = new Decimal(line.amount).minus(target.amount);
  const status: BankLineMatchStatus = difference.isZero() ? 'MATCHED' : 'DIFFERS';

  const data: NewMatch = {
    lineId: line.id,
    withdrawalId: target.withdrawalId,
    topUpId: target.topUpId,
    paymentId: target.paymentId,
    ledgerTransactionId: target.ledgerTransactionId,
    difference: money(difference),
    kind: input.kind,
    matchedByUserId: input.byUserId,
    note: input.note?.trim() || null,
  };
  const match = await repository.createMatch(data);

  if (target.topUpId) {
    await markTopUpReconciled(target.topUpId, now);
    // The transfer landed: what the top-up parked in suspense is now cash.
    // Only when the amounts agree — a difference is a question for a person.
    if (target.settleSuspense && status === 'MATCHED') {
      const settled = await settleSuspense(target.topUpId, match, money(target.amount), input.byUserId, now);
      await repository.updateMatch(match.id, { ledgerTransactionId: settled });
    }
  }
  return repository.setLineStatus(line.id, status);
}

/**
 * suspense +amount / cash −amount, keyed on the match so an unmatch-and-
 * rematch posts a fresh settlement rather than replaying a reversed one.
 * Stored on the match as its `ledgerTransactionId`, which is what unmatch
 * reverses.
 */
async function settleSuspense(topUpId: string, match: MatchRow, amount: Money, byUserId: string, now: Date): Promise<string> {
  const [suspense, cash] = await Promise.all([platformAccount('platform:suspense'), platformAccount('platform:cash')]);
  const { transaction } = await postLedger(
    {
      kind: 'TOPUP',
      idempotencyKey: `recon-settle:${topUpId}:${match.id}`,
      legs: [
        { accountId: suspense.id, amount, note: 'Top-up matched to bank line' },
        { accountId: cash.id, amount: money(new Decimal(amount).negated()), note: 'Top-up matched to bank line' },
      ],
      occurredAt: now,
      createdByUserId: byUserId,
      note: `Bank line matched to top-up ${topUpId}`,
    },
    now
  );
  return transaction.id;
}

export type AutoMatchOutcome = {
  scanned: number;
  matched: number;
  differs: number;
  unmatched: number;
  /** Lines whose withdrawal the bank has paid but finance has not yet confirmed. */
  awaitingMarkPaid: { lineId: string; withdrawalId: string; reference: string; utr: string | null }[];
};

/**
 * Explains every UNMATCHED line it can, in the order above. Never guesses:
 * two candidate transactions of the same amount leave the line alone, and a
 * withdrawal the bank has paid but finance has not marked so is reported
 * rather than matched — the mark-paid is finance's act, and posts the cash
 * legs this would otherwise be matching against.
 */
export async function autoMatch(
  input: { bankAccountId?: string | null; from?: Date | null; to?: Date | null; byUserId: string },
  now = new Date()
): Promise<AutoMatchOutcome> {
  const lines = await repository.listUnmatched({
    bankAccountId: input.bankAccountId ?? undefined,
    from: input.from ?? undefined,
    to: input.to ?? undefined,
    limit: 2000,
  });
  const outcome: AutoMatchOutcome = { scanned: lines.length, matched: 0, differs: 0, unmatched: 0, awaitingMarkPaid: [] };

  for (const line of lines) {
    const target = await findTarget(line, outcome);
    if (!target) {
      outcome.unmatched += 1;
      continue;
    }
    const updated = await recordMatch(line, target, { kind: 'AUTO', byUserId: input.byUserId }, now);
    if (updated.matchStatus === 'MATCHED') outcome.matched += 1;
    else outcome.differs += 1;
  }
  return outcome;
}

async function findTarget(line: LineRow, outcome: AutoMatchOutcome): Promise<Target | null> {
  if (line.direction === 'DEBIT') {
    const byReference = line.description.match(WDR_IN_TEXT);
    const candidates = [
      byReference ? await findWithdrawalByReference(byReference[0].toUpperCase()) : null,
      line.utr ? await findWithdrawalByUtr(line.utr) : null,
    ];
    for (const withdrawal of candidates) {
      if (!withdrawal) continue;
      if (withdrawal.status === 'PAID') {
        const claimed = await repository.claimedWithdrawalIds([withdrawal.id]);
        if (claimed.has(withdrawal.id)) continue;
        return targetFromWithdrawal(withdrawal);
      }
      if (withdrawal.status === 'PROCESSING') {
        outcome.awaitingMarkPaid.push({ lineId: line.id, withdrawalId: withdrawal.id, reference: withdrawal.reference, utr: line.utr });
        return null;
      }
    }
  } else if (line.utr) {
    const topUp = await findTopUpByUtr(line.utr);
    if (topUp) {
      const claimed = await repository.claimedTopUpIds([topUp.id]);
      if (!claimed.has(topUp.id)) return targetFromTopUp(topUp);
    }
  }
  return ledgerTarget(line);
}

/** The one unclaimed transaction of the right kind and amount within two days of the value date. */
async function ledgerTarget(line: LineRow): Promise<Target | null> {
  const from = new Date(line.valueDate.getTime() - WINDOW_DAYS * DAY_MS);
  const to = endOfDay(new Date(line.valueDate.getTime() + WINDOW_DAYS * DAY_MS));
  const rows = await listTransactions({
    kind: line.direction === 'DEBIT' ? debitKinds : creditKinds,
    from,
    to,
    limit: 200,
  });
  const inWindow = rows.filter((tx) => tx.occurredAt >= from && tx.occurredAt <= to && legMatchesLine(line, tx));
  const claimed = await repository.claimedLedgerTransactionIds(inWindow.map((tx) => tx.id));
  const open = inWindow.filter((tx) => !claimed.has(tx.id));
  if (open.length !== 1) return null;
  const tx = open[0]!;
  return {
    withdrawalId: null,
    topUpId: null,
    paymentId: null,
    ledgerTransactionId: tx.id,
    amount: cashLegAmount(tx)!.abs(),
    settleSuspense: false,
  };
}

/* ------------------------------------------------------------------ */
/* By hand                                                             */
/* ------------------------------------------------------------------ */

export type ManualMatchInput = {
  withdrawalId?: string | null;
  topUpId?: string | null;
  paymentId?: string | null;
  ledgerTransactionId?: string | null;
  note?: string | null;
  byUserId: string;
};

/** A person names the record. One target; the difference, if any, is recorded rather than hidden. */
export async function matchLine(lineId: string, input: ManualMatchInput, now = new Date()): Promise<LineRow> {
  const line = await getLine(lineId);
  if (line.matchStatus !== 'UNMATCHED') {
    throw new ApiError(409, 'CONFLICT', `This line is already ${line.matchStatus.toLowerCase()}; unmatch it first.`);
  }

  let target: Target | null = null;
  if (input.withdrawalId) {
    const withdrawal = await findWithdrawal(input.withdrawalId);
    if (!withdrawal) throw new ApiError(404, 'NOT_FOUND', 'Withdrawal not found');
    if ((await repository.claimedWithdrawalIds([withdrawal.id])).has(withdrawal.id)) {
      throw new ApiError(409, 'CONFLICT', `${withdrawal.reference} already explains another line`);
    }
    target = targetFromWithdrawal(withdrawal);
  } else if (input.topUpId || input.paymentId) {
    const topUp = input.topUpId ? await findTopUp(input.topUpId) : await findTopUpByPaymentId(input.paymentId!);
    if (!topUp) throw new ApiError(404, 'NOT_FOUND', 'Top-up not found');
    if ((await repository.claimedTopUpIds([topUp.id])).has(topUp.id)) {
      throw new ApiError(409, 'CONFLICT', 'That top-up already explains another line');
    }
    target = targetFromTopUp(topUp, input.paymentId ?? null);
  } else if (input.ledgerTransactionId) {
    const tx = await getTransaction(input.ledgerTransactionId);
    if (!tx) throw new ApiError(404, 'NOT_FOUND', 'Ledger transaction not found');
    if ((await repository.claimedLedgerTransactionIds([tx.id])).has(tx.id)) {
      throw new ApiError(409, 'CONFLICT', `${tx.reference} already explains another line`);
    }
    const amount = cashLegAmount(tx);
    if (!amount) throw new ApiError(409, 'CONFLICT', `${tx.reference} has no cash or suspense leg to match a bank line against`);
    target = { withdrawalId: null, topUpId: null, paymentId: null, ledgerTransactionId: tx.id, amount: amount.abs(), settleSuspense: false };
  }
  if (!target) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Name what explains this line: a withdrawal, a top-up, a payment id or a ledger transaction.');
  }
  return recordMatch(line, target, { kind: 'MANUAL', byUserId: input.byUserId, note: input.note ?? null }, now);
}

/** Bank charges, interest, a line that is nobody's: set aside with a note. */
export async function ignoreLine(lineId: string, input: { note?: string | null; byUserId: string }): Promise<LineRow> {
  const line = await getLine(lineId);
  if (line.matchStatus !== 'UNMATCHED') {
    throw new ApiError(409, 'CONFLICT', `This line is already ${line.matchStatus.toLowerCase()}; unmatch it first.`);
  }
  await repository.createMatch({
    lineId: line.id,
    withdrawalId: null,
    topUpId: null,
    paymentId: null,
    ledgerTransactionId: null,
    difference: money(0),
    kind: 'MANUAL',
    matchedByUserId: input.byUserId,
    note: input.note?.trim() || null,
  });
  return repository.setLineStatus(line.id, 'IGNORED');
}

/** Back to UNMATCHED. A top-up loses its stamp and its settlement is reversed — never edited. */
export async function unmatchLine(lineId: string, input: { byUserId: string }, now = new Date()): Promise<LineRow> {
  const line = await getLine(lineId);
  if (line.matchStatus === 'UNMATCHED') return line;
  const match = line.match;
  if (match?.topUpId) {
    await markTopUpReconciled(match.topUpId, null);
    if (match.ledgerTransactionId) {
      await reverseLedger(match.ledgerTransactionId, { reason: `Bank line ${line.id} unmatched`, createdByUserId: input.byUserId }, now);
    }
  }
  await repository.deleteMatch(line.id);
  return repository.setLineStatus(line.id, 'UNMATCHED');
}

/* ------------------------------------------------------------------ */
/* Summary                                                             */
/* ------------------------------------------------------------------ */

export type ReconciliationSummary = StatusSummary & {
  total: { count: number; sum: Money };
};

export async function summary(filter: { bankAccountId?: string | undefined; from?: Date | undefined; to?: Date | undefined }): Promise<ReconciliationSummary> {
  const byStatus = await repository.summary(filter);
  let count = 0;
  let sum = new Decimal(0);
  for (const row of Object.values(byStatus)) {
    count += row.count;
    sum = sum.plus(row.sum);
  }
  return { ...byStatus, total: { count, sum: money(sum) } };
}
