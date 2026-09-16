import { env } from '../../config/env';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal, money, type Money } from '../../shared/money';
import type { Statement, WalletEntryType } from '../../shared/database';
import { notify } from '../notifications';
import { listAccrualsForPeriod, partyContext, publisherIdsWithAccruals, type AccrualRow } from '../payouts';
import { findPublisherBilling, findPublisherForUser } from '../publishers';
import { storeGeneratedFile } from '../uploads';
import { findWalletFor, sumEntries } from '../wallets';
import { prismaInvoicesRepository as repository } from './prisma-invoices.repository';
import { renderPaymentAdvicePdf, type PaymentAdvice } from './pdf';
import type { NewStatement } from './invoices.repository';

/**
 * The publisher's monthly payment advice — Lot B (Q13), the generator DR 04's
 * `Statement` table was waiting for.
 *
 * On the first of each month, for every publisher who earned anything in the
 * month just ended, one PDF: every day's gross, ADX's commission, the tax
 * withheld and the net that reached the wallet, with the totals and the
 * wallet's opening and closing balances. The figures are stored on the
 * `Statement` row rather than recomputed on read, because an advice somebody
 * downloaded in March must still say in December what it said then.
 *
 * It is a payment advice, not a tax invoice: ADX is the payer here. A
 * GST-registered publisher raises their own invoice to ADX for the period,
 * which arrives through `POST /publishers/me/invoices`.
 */

const D = Decimal;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type MonthWindow = { period: string; label: string; start: Date; end: Date };

/**
 * A calendar month as accruals are dated: `forDate` is a UTC-midnight date
 * column, so the window is [1st 00:00Z, next 1st 00:00Z).
 */
export function monthWindow(year: number, month: number): MonthWindow {
  if (month < 1 || month > 12) throw new ApiError(400, 'VALIDATION_ERROR', 'A month is 1-12');
  return {
    period: `${year}-${String(month).padStart(2, '0')}`,
    label: `${MONTH_NAMES[month - 1]} ${year}`,
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

export function monthWindowFor(period: string): MonthWindow {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new ApiError(400, 'VALIDATION_ERROR', 'A period is YYYY-MM');
  return monthWindow(Number(match[1]), Number(match[2]));
}

/** The month before the one `now` falls in, in Indian time. */
export function previousMonth(now: Date): MonthWindow {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth(); // 0-based; the previous month's 1-based number
  return month === 0 ? monthWindow(year - 1, 12) : monthWindow(year, month);
}

/** Whether `now` is the first day of a month in Indian time. */
export function isFirstOfMonthIST(now: Date): boolean {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCDate() === 1;
}

const CREDIT_TYPES: WalletEntryType[] = ['EARNING', 'BONUS', 'REFERRAL', 'GOODWILL_CREDIT', 'REFUND', 'TOPUP'];
const DEBIT_TYPES: WalletEntryType[] = ['PAYOUT', 'PENALTY', 'EXPIRY', 'CAMPAIGN_DEBIT', 'PACKAGE_DEBIT'];

const sum = (rows: AccrualRow[], pick: (row: AccrualRow) => Decimal): Decimal =>
  rows.reduce((total, row) => total.plus(pick(row)), new D(0));

export const statementReference = (period: string, walletId: string): string => `PA/${period}/${walletId}`;

function publicBaseUrl(): string {
  return env.BASE_URL ?? (env.NODE_ENV !== 'production' ? `http://localhost:${env.PORT}` : '');
}

/**
 * The advice for one publisher and one month, from the accruals and the
 * wallet. Null when nothing was earned — no paper for an empty month.
 */
export async function buildPaymentAdvice(
  publisherId: string,
  window: MonthWindow,
  now = new Date(),
): Promise<{ advice: PaymentAdvice; statement: NewStatement; walletId: string; ownerUserId: string | null } | null> {
  const rows = await listAccrualsForPeriod(publisherId, window.start, window.end);
  if (rows.length === 0) return null;

  const [publisher, wallet, entity] = await Promise.all([
    findPublisherBilling(publisherId),
    findWalletFor({ kind: 'PUBLISHER', id: publisherId }),
    repository.getLegalEntity(),
  ]);
  if (!publisher || !wallet) return null;

  const [opening, closing, credits, debits, all] = await Promise.all([
    sumEntries(wallet.id, undefined, undefined, window.start),
    sumEntries(wallet.id, undefined, undefined, window.end),
    sumEntries(wallet.id, CREDIT_TYPES, window.start, window.end),
    sumEntries(wallet.id, DEBIT_TYPES, window.start, window.end),
    sumEntries(wallet.id, undefined, window.start, window.end),
  ]);

  const gross = sum(rows, (row) => new D(row.gross));
  const commission = sum(rows, (row) => new D(row.commission));
  const taxWithheld = sum(rows, (row) => new D(row.taxWithheld));
  const net = sum(rows, (row) => new D(row.net));
  const reference = statementReference(window.period, wallet.id);

  const advice: PaymentAdvice = {
    reference,
    period: window.period,
    periodLabel: window.label,
    supplier: {
      name: entity.tradeName ?? entity.legalName ?? 'ADX',
      gstin: entity.gstin,
      address: [entity.registeredAddress, entity.city, entity.stateName].filter(Boolean).join(', ') || null,
    },
    publisher: {
      name: publisher.name,
      gstin: publisher.gstin,
      address: [publisher.address, publisher.city, publisher.state].filter(Boolean).join(', ') || null,
    },
    rows: rows.map((row) => ({
      date: row.forDate,
      listing: row.listing.city ? `${row.listing.title}, ${row.listing.city}` : row.listing.title,
      gross: money(row.gross),
      commission: money(row.commission),
      taxWithheld: money(row.taxWithheld),
      net: money(row.net),
    })),
    totals: {
      gross: money(gross),
      commission: money(commission),
      taxWithheld: money(taxWithheld),
      net: money(net),
      days: rows.length,
    },
    wallet: {
      openingBalance: money(opening.total),
      closingBalance: money(closing.total),
      credits: money(credits.total),
      debits: money(new D(debits.total).abs()),
    },
    generatedAt: now,
  };

  const statement: NewStatement = {
    reference,
    walletId: wallet.id,
    periodStart: window.start,
    periodEnd: window.end,
    openingBalance: new D(opening.total),
    credits: new D(credits.total),
    debits: new D(debits.total).abs(),
    taxWithheld,
    closingBalance: new D(closing.total),
    entryCount: all.count,
    pdfPath: null,
    csvPath: null,
  };

  return { advice, statement, walletId: wallet.id, ownerUserId: publisher.userId };
}

/**
 * Renders and stores one publisher's advice for the month. Idempotent per
 * (wallet, month): a rerun refreshes the figures and the file on the same
 * row. Without a user behind the publisher (an agent still holds the
 * account) the PDF is rendered on demand instead, since a stored file has
 * to belong to somebody.
 */
export async function generatePublisherStatement(
  publisherId: string,
  window: MonthWindow,
  now = new Date(),
): Promise<Statement | null> {
  return (await generateStatement(publisherId, window, now))?.statement ?? null;
}

/** The generated row with what the notice needs: who owns it, the net figure, the name on the advice. */
async function generateStatement(
  publisherId: string,
  window: MonthWindow,
  now: Date,
): Promise<{ statement: Statement; ownerUserId: string | null; net: Money; partyName: string } | null> {
  const built = await buildPaymentAdvice(publisherId, window, now);
  if (!built) return null;

  let pdfPath: string | null = null;
  if (built.ownerUserId) {
    const pdf = await renderPaymentAdvicePdf(built.advice);
    const stored = await storeGeneratedFile(built.ownerUserId, {
      content: pdf,
      filename: `payment-advice-${window.period}.pdf`,
      mimeType: 'application/pdf',
      purpose: 'STATEMENT',
      baseUrl: publicBaseUrl(),
    });
    pdfPath = stored.url;
  }
  const statement = await repository.upsertStatement({ ...built.statement, pdfPath });
  return { statement, ownerUserId: built.ownerUserId, net: built.advice.totals.net, partyName: built.advice.publisher.name };
}

/** Where the app opens a statement from the notice — the PDF door, which checks the owner itself. */
export const statementDeepLink = (statementId: string): string => `${publicBaseUrl()}/api/v1/payouts/wallet/statements/${statementId}/pdf`;

/**
 * Lot F (E7-1): the publisher is told their advice is ready — one `notify`
 * call per statement upserted: the in-app PAYOUT row and the email the
 * seeded `statement-ready` template names (month, net, url, partyName,
 * reference), the email subject to the PAYOUT × EMAIL preference (the
 * matrix is per type, not per event — `notifications.types.ts`). A
 * publisher with no app account yet has nobody to tell. Best effort: the
 * advice stands whether or not the notice went.
 */
async function tellPublisherStatementReady(
  generated: { statement: Statement; ownerUserId: string | null; net: Money; partyName: string },
  window: MonthWindow,
): Promise<void> {
  if (!generated.ownerUserId) return;
  try {
    await notify(
      'STATEMENT_READY',
      generated.ownerUserId,
      {
        month: window.label,
        net: generated.net,
        url: statementDeepLink(generated.statement.id),
        partyName: generated.partyName,
        reference: generated.statement.reference,
      },
      {
        inApp: {
          type: 'PAYOUT',
          title: `Payment advice for ${window.label}`,
          subtitle: `₹${generated.net} net`,
          message: `Your ADX payment advice for ${window.label} is ready. Net paid into your wallet: ₹${generated.net}.`,
          suggestedAction: 'Open the statement',
          relatedId: generated.statement.id,
          // E9: the tap opens the statement; the modal reads the facts off the payload.
          relatedType: 'STATEMENT',
          payload: { statementId: generated.statement.id, month: window.label, net: generated.net },
        },
      },
    );
  } catch (err) {
    logger.warn('Statement-ready notice was not sent', { statementId: generated.statement.id, err });
  }
}

export type MonthlyStatementsRun = { period: string; generated: number; skipped: number; failed: number };

/** Every publisher who earned in the month, each told once. Tolerant: one failure does not stop the rest. */
export async function runMonthlyStatements(window: MonthWindow, now = new Date()): Promise<MonthlyStatementsRun> {
  const publisherIds = await publisherIdsWithAccruals(window.start, window.end);
  let generated = 0;
  let skipped = 0;
  let failed = 0;
  for (const publisherId of publisherIds) {
    try {
      const result = await generateStatement(publisherId, window, now);
      if (result) {
        generated += 1;
        await tellPublisherStatementReady(result, window);
      } else {
        skipped += 1;
      }
    } catch (err) {
      failed += 1;
      logger.error('Payment advice failed', { tag: 'monthlyStatements', publisherId, period: window.period, err });
    }
  }
  return { period: window.period, generated, skipped, failed };
}

/* ── Reading them back ──────────────────────────────────────────────── */

export type StatementView = {
  id: string;
  reference: string;
  period: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: Money;
  credits: Money;
  debits: Money;
  taxWithheld: Money;
  closingBalance: Money;
  entryCount: number;
  hasPdf: boolean;
  generatedAt: Date;
};

export const shapeStatement = (row: Statement): StatementView => ({
  id: row.id,
  reference: row.reference,
  period: row.periodStart.toISOString().slice(0, 7),
  periodStart: row.periodStart,
  periodEnd: row.periodEnd,
  openingBalance: money(row.openingBalance),
  credits: money(row.credits),
  debits: money(row.debits),
  taxWithheld: money(row.taxWithheld),
  closingBalance: money(row.closingBalance),
  entryCount: row.entryCount,
  hasPdf: Boolean(row.pdfPath),
  generatedAt: row.generatedAt,
});

/** The statement, only if the caller owns the wallet behind it or is an admin. */
async function statementFor(statementId: string, actor: { userId: string; isAdmin: boolean }) {
  const statement = await repository.findStatement(statementId);
  if (!statement) throw new ApiError(404, 'NOT_FOUND', 'Statement not found');
  const party = await partyContext(statement.walletId);
  if (!party) throw new ApiError(404, 'NOT_FOUND', 'Statement not found');
  if (!actor.isAdmin && party.userId !== actor.userId) {
    throw new ApiError(404, 'NOT_FOUND', 'Statement not found');
  }
  return { statement, party };
}

export async function listStatementsForUser(userId: string): Promise<StatementView[]> {
  const wallet = await findWalletFor({ kind: 'PUBLISHER', id: await publisherIdForUser(userId) });
  if (!wallet) return [];
  const rows = await repository.listStatementsForWallet(wallet.id, 60);
  return rows.map(shapeStatement);
}

async function publisherIdForUser(userId: string): Promise<string> {
  // The wallet is found by publisher id; the publisher by user. Two hops,
  // through the module that owns each.
  const publisher = await findPublisherForUser(userId);
  if (!publisher) throw new ApiError(404, 'NOT_FOUND', 'You do not have a publisher profile');
  return publisher.id;
}

/**
 * The PDF for one statement: the stored file when there is one, otherwise
 * rendered now from the same accruals (and stored, when there is somebody
 * to own it).
 */
export async function statementPdf(
  statementId: string,
  actor: { userId: string; isAdmin: boolean },
): Promise<{ url: string } | { buffer: Buffer; filename: string }> {
  const { statement, party } = await statementFor(statementId, actor);
  if (statement.pdfPath) return { url: statement.pdfPath };

  const window = monthWindow(statement.periodStart.getUTCFullYear(), statement.periodStart.getUTCMonth() + 1);
  const built = await buildPaymentAdvice(party.entityId, window, statement.generatedAt);
  if (!built) throw new ApiError(404, 'NOT_FOUND', 'Nothing was earned in this period');
  const buffer = await renderPaymentAdvicePdf(built.advice);
  const filename = `payment-advice-${window.period}.pdf`;

  if (built.ownerUserId) {
    try {
      const stored = await storeGeneratedFile(built.ownerUserId, {
        content: buffer,
        filename,
        mimeType: 'application/pdf',
        purpose: 'STATEMENT',
        baseUrl: publicBaseUrl(),
      });
      await repository.updateStatement(statement.id, { pdfPath: stored.url });
    } catch (err) {
      logger.warn('Could not store the payment advice; served unstored', { statementId, err });
    }
  }
  return { buffer, filename };
}
