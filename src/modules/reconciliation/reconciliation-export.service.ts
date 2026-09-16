import { ApiError } from '../../shared/errors';
import { money } from '../../shared/money';
import { findUserLabels } from '../users';
import { prismaReconciliationRepository as repository } from './prisma-reconciliation.repository';
import type { LineFilter, LineRow, LineSlice } from './reconciliation.repository';

/**
 * The reconciliation export — Lot G (Q125).
 *
 * Every line of an import, or every line under the desk's filters, as a CSV
 * an auditor can hold beside the bank's own file: the line as imported, its
 * match state, the ADX record that explains it (which of the four, and its
 * id), the difference the two disagree by, and who resolved it and when —
 * the admin who matched or ignored it by hand, or who ran the auto-match
 * that claimed it. Streamed a thousand lines a slice the way the other
 * exports are, walked by keyset so a line landing mid-stream neither
 * repeats nor drops a row, and capped so a filter that matches everything
 * still ends.
 */

export const LINE_EXPORT_ROW_CAP = 50_000;
export const LINE_EXPORT_BATCH = 1_000;

export const LINE_CSV_COLUMNS = [
  'lineId',
  'importId',
  'bankAccountId',
  'valueDate',
  'description',
  'utr',
  'direction',
  'amount',
  'runningBalance',
  'matchStatus',
  'matchKind',
  'matchedRecordType',
  'matchedRecordId',
  'difference',
  'matchNote',
  'resolvedByUserId',
  'resolvedByName',
  'resolvedAt',
] as const;

export type MatchedRecordType = 'WITHDRAWAL' | 'TOP_UP' | 'PAYMENT' | 'LEDGER_TRANSACTION' | 'NONE';

/** Which of the four records a match names — a line set aside (IGNORED) names none. */
export function matchedRecordOf(match: LineRow['match']): { type: MatchedRecordType; id: string | null } {
  if (!match) return { type: 'NONE', id: null };
  if (match.withdrawalId) return { type: 'WITHDRAWAL', id: match.withdrawalId };
  if (match.topUpId) return { type: 'TOP_UP', id: match.topUpId };
  if (match.paymentId) return { type: 'PAYMENT', id: match.paymentId };
  if (match.ledgerTransactionId) return { type: 'LEDGER_TRANSACTION', id: match.ledgerTransactionId };
  return { type: 'NONE', id: null };
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function lineCsvHeader(): string {
  return `${LINE_CSV_COLUMNS.join(',')}\r\n`;
}

/** One line. `valueDate` is the bank's date (`YYYY-MM-DD`); money as decimal strings; the resolver by id and by name. */
export function lineCsvLine(row: LineRow, resolverName: string | null): string {
  const record = matchedRecordOf(row.match);
  const cells: Record<(typeof LINE_CSV_COLUMNS)[number], unknown> = {
    lineId: row.id,
    importId: row.importId,
    bankAccountId: row.bankAccountId,
    valueDate: row.valueDate.toISOString().slice(0, 10),
    description: row.description,
    utr: row.utr,
    direction: row.direction,
    amount: money(row.amount),
    runningBalance: row.runningBalance ? money(row.runningBalance) : null,
    matchStatus: row.matchStatus,
    matchKind: row.match?.kind ?? null,
    matchedRecordType: record.type,
    matchedRecordId: record.id,
    difference: row.match ? money(row.match.difference) : null,
    matchNote: row.match?.note ?? null,
    resolvedByUserId: row.match?.matchedByUserId ?? null,
    resolvedByName: resolverName,
    resolvedAt: row.match?.createdAt ?? null,
  };
  return `${LINE_CSV_COLUMNS.map((column) => csvCell(cells[column])).join(',')}\r\n`;
}

/** The names behind the resolver ids of one slice, one lookup per slice; an unknown id is left nameless. */
async function resolverNames(rows: LineRow[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map((row) => row.match?.matchedByUserId).filter((id): id is string => typeof id === 'string'))];
  const out = new Map<string, string | null>();
  if (ids.length === 0) return out;
  try {
    for (const [id, label] of await findUserLabels(ids)) out.set(id, label.name);
  } catch {
    // A name is decoration on the file; the ids still answer.
  }
  return out;
}

/**
 * The export's rows, a slice at a time under the cap, each slice already
 * rendered — the controller writes what it is handed. The lines of one
 * import (`importId`) or every line under the desk's filters.
 */
export async function* iterateLineCsv(filter: LineFilter, cap = LINE_EXPORT_ROW_CAP): AsyncGenerator<string, void, void> {
  let written = 0;
  let after: LineSlice['after'];
  while (written < cap) {
    const take = Math.min(LINE_EXPORT_BATCH, cap - written);
    const rows = await repository.findLineRows(filter, { take, ...(after ? { after } : {}) });
    if (rows.length === 0) return;
    const names = await resolverNames(rows);
    yield rows.map((row) => lineCsvLine(row, row.match?.matchedByUserId ? (names.get(row.match.matchedByUserId) ?? null) : null)).join('');
    if (rows.length < take) return;
    written += rows.length;
    const last = rows[rows.length - 1]!;
    after = { valueDate: last.valueDate, id: last.id };
  }
}

/** The import an export is asked for must exist; the file then carries its lines and only its lines. */
export async function requireImport(importId: string): Promise<{ id: string; fileName: string }> {
  const row = await repository.findImport(importId);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Statement import not found');
  return { id: row.id, fileName: row.fileName };
}
