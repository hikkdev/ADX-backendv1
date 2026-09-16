import { createHash } from 'crypto';
import { parseCsv } from '../../shared/csv';
import { Decimal, money, type Money } from '../../shared/money';

/**
 * A bank's statement export, read into lines — Lot B (Q85).
 *
 * Generic CSV in: every bank exports a table with a date, a narration, a
 * reference, money in, money out and a running balance, and only the column
 * headings and the date format differ. A `BankStatementProfile` names those
 * for one bank; without one the defaults below are what most Indian banks'
 * exports use. Nothing here touches the database — it turns text into the
 * rows the import writes, and reports what it could not read rather than
 * failing the whole file on one bad line.
 */

export type ProfileColumns = {
  date: string;
  description: string;
  utr?: string | undefined;
  /** Two-column exports: money out and money in. */
  debit?: string | undefined;
  credit?: string | undefined;
  /** One-column exports: signed, or suffixed Dr/Cr. */
  amount?: string | undefined;
  balance?: string | undefined;
};

export const DEFAULT_COLUMNS: ProfileColumns = {
  date: 'Date',
  description: 'Description',
  utr: 'Ref No./UTR',
  debit: 'Debit',
  credit: 'Credit',
  balance: 'Balance',
};

export const DEFAULT_DATE_FORMAT = 'dd/MM/yyyy';

export type ParsedLine = {
  valueDate: Date;
  description: string;
  utr: string | null;
  direction: 'CREDIT' | 'DEBIT';
  amount: Money;
  runningBalance: Money | null;
  rawHash: string;
};

/** `row` counts non-blank records from the top of the file, header included. */
export type ParseProblem = { row: number; problem: string };

export type ParsedStatement = {
  lines: ParsedLine[];
  problems: ParseProblem[];
  /** Earliest and latest value dates, for the import's period. */
  periodStart: Date | null;
  periodEnd: Date | null;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A date by format: `dd/MM/yyyy`, `yyyy-MM-dd`, `dd-MMM-yy`, `MM/dd/yyyy`…
 * Tokens are dd, MM, MMM, yy, yyyy; any run of non-alphanumerics separates.
 * Always a UTC midnight — a value date is a calendar day, not a moment.
 */
export function parseDate(value: string, format = DEFAULT_DATE_FORMAT): Date | null {
  const tokens = format.match(/dd|MMM|MM|yyyy|yy/g);
  const parts = value.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!tokens || tokens.length !== parts.length) return null;
  let day = 0;
  let month = 0;
  let year = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const part = parts[i]!;
    switch (tokens[i]) {
      case 'dd':
        day = Number(part);
        break;
      case 'MM':
        month = Number(part);
        break;
      case 'MMM':
        month = MONTHS.indexOf(part.slice(0, 3).toLowerCase()) + 1;
        break;
      case 'yyyy':
        year = Number(part);
        break;
      case 'yy':
        year = 2000 + Number(part);
        break;
    }
  }
  if (!day || !month || !year || month > 12 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

/**
 * `1,23,456.78`, `₹ 500`, `(250.00)`, `1200 Dr` — the ways a statement
 * writes money. Returns the magnitude and, where the cell says so, the sign
 * or the Dr/Cr side.
 */
export function parseAmount(value: string): { amount: Decimal; side: 'DR' | 'CR' | null } | null {
  let text = value.trim();
  if (!text) return null;
  let side: 'DR' | 'CR' | null = null;
  const suffix = text.match(/\b(dr|cr)\.?$/i);
  if (suffix) {
    side = suffix[1]!.toUpperCase() as 'DR' | 'CR';
    text = text.slice(0, suffix.index).trim();
  }
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  text = text.replace(/[₹$,\s]/g, '').replace(/^INR/i, '');
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const magnitude = new Decimal(text);
  if (negative && !side) side = 'DR';
  return { amount: magnitude, side };
}

/** NEFT/RTGS/IMPS references as they appear inside a narration. */
const UTR_IN_TEXT = /\b(?:[A-Z]{4}[A-Z0-9]{11,18}|\d{12}|\d{16})\b/;

export function utrFromDescription(description: string): string | null {
  const match = description.toUpperCase().match(UTR_IN_TEXT);
  return match ? match[0] : null;
}

/** sha256 of (date|description|amount|direction): the same line imported twice is one line. */
export function lineHash(line: Pick<ParsedLine, 'valueDate' | 'description' | 'amount' | 'direction'>): string {
  return createHash('sha256')
    .update(`${line.valueDate.toISOString().slice(0, 10)}|${line.description.trim()}|${line.amount}|${line.direction}`)
    .digest('hex');
}

const norm = (value: string) => value.trim().toLowerCase();

function headerIndex(header: string[], name: string | undefined): number {
  if (!name) return -1;
  const wanted = norm(name);
  const exact = header.findIndex((cell) => norm(cell) === wanted);
  if (exact >= 0) return exact;
  return header.findIndex((cell) => norm(cell).includes(wanted));
}

/**
 * Text to lines. The header row is found by the profile's date and
 * description columns (a bank often prints an address block above it), and
 * each row after it becomes a line or a problem.
 */
export function parseStatement(
  text: string,
  options: { columns?: Partial<ProfileColumns> | null; dateFormat?: string | null } = {}
): ParsedStatement {
  const columns: ProfileColumns = { ...DEFAULT_COLUMNS, ...(options.columns ?? {}) };
  const dateFormat = options.dateFormat || DEFAULT_DATE_FORMAT;
  const rows = parseCsv(text);

  const headerAt = rows.findIndex(
    (row) => headerIndex(row, columns.date) >= 0 && headerIndex(row, columns.description) >= 0
  );
  if (headerAt < 0) {
    return { lines: [], problems: [{ row: 0, problem: `No header row with "${columns.date}" and "${columns.description}"` }], periodStart: null, periodEnd: null };
  }
  const header = rows[headerAt]!;
  const at = {
    date: headerIndex(header, columns.date),
    description: headerIndex(header, columns.description),
    utr: headerIndex(header, columns.utr),
    debit: headerIndex(header, columns.debit),
    credit: headerIndex(header, columns.credit),
    amount: headerIndex(header, columns.amount),
    balance: headerIndex(header, columns.balance),
  };
  if (at.debit < 0 && at.credit < 0 && at.amount < 0) {
    return { lines: [], problems: [{ row: headerAt + 1, problem: 'No debit, credit or amount column' }], periodStart: null, periodEnd: null };
  }

  const lines: ParsedLine[] = [];
  const problems: ParseProblem[] = [];
  const cell = (row: string[], index: number) => (index >= 0 ? (row[index] ?? '') : '');

  for (let i = headerAt + 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    const rowNumber = i + 1;
    const valueDate = parseDate(cell(row, at.date), dateFormat);
    if (!valueDate) {
      problems.push({ row: rowNumber, problem: `Unreadable date "${cell(row, at.date)}"` });
      continue;
    }
    const description = cell(row, at.description).trim();

    let direction: 'CREDIT' | 'DEBIT' | null = null;
    let amount: Decimal | null = null;
    const debit = parseAmount(cell(row, at.debit));
    const credit = parseAmount(cell(row, at.credit));
    if (debit && !debit.amount.isZero()) {
      direction = 'DEBIT';
      amount = debit.amount;
    } else if (credit && !credit.amount.isZero()) {
      direction = 'CREDIT';
      amount = credit.amount;
    } else if (at.amount >= 0) {
      const signed = parseAmount(cell(row, at.amount));
      if (signed && !signed.amount.isZero()) {
        direction = signed.side === 'DR' ? 'DEBIT' : 'CREDIT';
        amount = signed.amount;
      }
    }
    if (!direction || !amount) {
      problems.push({ row: rowNumber, problem: 'No amount' });
      continue;
    }

    const balance = parseAmount(cell(row, at.balance));
    const utr = (at.utr >= 0 ? cell(row, at.utr).trim().toUpperCase() : '') || utrFromDescription(description);
    const line: ParsedLine = {
      valueDate,
      description,
      utr: utr || null,
      direction,
      amount: money(amount),
      runningBalance: balance ? money(balance.side === 'DR' ? balance.amount.negated() : balance.amount) : null,
      rawHash: '',
    };
    line.rawHash = lineHash(line);
    lines.push(line);
  }

  const dates = lines.map((line) => line.valueDate.getTime());
  return {
    lines,
    problems,
    periodStart: dates.length ? new Date(Math.min(...dates)) : null,
    periodEnd: dates.length ? new Date(Math.max(...dates)) : null,
  };
}
