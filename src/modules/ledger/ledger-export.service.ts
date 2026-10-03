import { formatCsv } from '../../shared/csv';
import { ApiError } from '../../shared/errors';
import { Decimal, money } from '../../shared/money';
import { isoIST } from '../../shared/time';
import type { TransactionRow } from './ledger.repository';
import { countLegs, listTransactions, type LedgerFacets } from './ledger.service';

/**
 * The ledger as a file — one line per leg, under the ledger screen's filters.
 *
 * A leg is the unit an accountant ticks against a statement, so the file is
 * legs rather than transactions: each line repeats its transaction's
 * reference, kind, time and note, then names the account and puts the leg on
 * its side — debit (a negative leg, money leaving the account) or credit (a
 * positive one). Times are India's, offset written out. Walked newest first
 * by the same keyset the screen pages with, a slice at a time, and capped:
 * past the cap the export is refused before a byte is written, with a
 * sentence asking for a narrower range rather than a file cut short.
 */

export const LEDGER_EXPORT_LEG_CAP = 50_000;
const SLICE = 200;

export const LEDGER_CSV_COLUMNS = [
  'reference',
  'kind',
  'occurredAtIST',
  'note',
  'accountCode',
  'accountName',
  'debit',
  'credit',
  'reversesReference',
] as const;

export function ledgerCsvHeader(): string {
  return formatCsv([LEDGER_CSV_COLUMNS]);
}

/** One transaction's legs, one CRLF line each. */
export function ledgerCsvLines(tx: TransactionRow): string {
  return formatCsv(
    tx.legs.map((leg) => {
      const amount = new Decimal(leg.amount);
      return [
        tx.reference,
        tx.kind,
        isoIST(tx.occurredAt),
        tx.note,
        leg.account.code,
        leg.account.name,
        amount.isNegative() ? money(amount.abs()) : null,
        amount.isNegative() ? null : money(amount),
        tx.reverses?.reference ?? null,
      ];
    })
  );
}

/** Refuses an export past the cap, before anything is written or audited. Answers the leg count. */
export async function assertLedgerExportable(filter: LedgerFacets, cap = LEDGER_EXPORT_LEG_CAP): Promise<number> {
  const legs = await countLegs(filter);
  if (legs > cap) {
    throw new ApiError(
      422,
      'VALIDATION_ERROR',
      `These filters match ${legs.toLocaleString('en-IN')} ledger lines, more than the ${cap.toLocaleString('en-IN')} one file can hold. Narrow the date range or add a filter, then export again.`,
      { legs, cap }
    );
  }
  return legs;
}

/** The file's body, a slice of transactions at a time, never past the cap. */
export async function* iterateLedgerCsv(filter: LedgerFacets, cap = LEDGER_EXPORT_LEG_CAP): AsyncGenerator<string, void, void> {
  let written = 0;
  let cursor: string | undefined;
  while (written < cap) {
    const rows = await listTransactions({ ...filter, limit: SLICE, ...(cursor ? { cursor } : {}) });
    if (rows.length === 0) return;
    let chunk = '';
    for (const tx of rows) {
      if (written + tx.legs.length > cap) {
        if (chunk) yield chunk;
        return;
      }
      chunk += ledgerCsvLines(tx);
      written += tx.legs.length;
    }
    yield chunk;
    if (rows.length < SLICE) return;
    cursor = rows[rows.length - 1]!.id;
  }
}
