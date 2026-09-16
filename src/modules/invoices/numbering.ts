import type { InvoiceKind } from '../../shared/database';

/**
 * How an invoice number is put together — `<series>/<FY>/<000018>`.
 *
 * The GST rule is that each series is consecutive within a financial year,
 * with no gaps. So the number is allocated from `InvoiceSequence` inside the
 * same transaction that writes the invoice: a failed write rolls the counter
 * back, and two concurrent issues serialise on the sequence row.
 *
 * Three series, because they mean different things to the tax office. A tax
 * invoice consumes a number in the entity's own series (`invoicePrefix`,
 * "INV" by default). A proforma is not a tax document and must not sit in
 * that run, so it takes `<prefix>-PRO`. A credit note is its own consecutive
 * run under `<prefix>-CN`.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "2026-27" for a date in the year that starts in `startMonth` (1-12; 4 is April). */
export function financialYearLabel(at: Date, startMonth = 4): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth() + 1;
  const start = month >= startMonth ? year : year - 1;
  if (startMonth === 1) return String(start);
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export function seriesFor(kind: InvoiceKind, prefix: string): string {
  const base = prefix.trim() || 'INV';
  if (kind === 'CREDIT_NOTE') return `${base}-CN`;
  if (kind === 'PROFORMA') return `${base}-PRO`;
  return base;
}

/** The printed number for the next value in a series. */
export function formatInvoiceNumber(series: string, financialYear: string, next: number): string {
  return `${series}/${financialYear}/${String(next).padStart(6, '0')}`;
}

/** The `InvoiceSequence.series` key: one counter per series per financial year. */
export const sequenceKey = (series: string, financialYear: string): string => `${series}/${financialYear}`;
