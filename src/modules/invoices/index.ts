/**
 * Invoices — Lot B (Q13/Q34): the legal entity, the tax invoices, proformas
 * and credit notes ADX issues to advertisers, the invoices publishers raise
 * on ADX, and the monthly payment advices publishers download.
 *
 * It owns the paper, not the money. A hold, a capture, a refund are
 * `advertisers`' and the desk's; this describes them, once, in a consecutive
 * series, and never edits a document after it is issued — a void is a credit
 * note. The lines are read off the booking as it was authorised and the
 * same `revenue.quote` that priced it, so an invoice cannot disagree with
 * the amount that was charged.
 */
import { registerCampaignInvoicingPort } from '../campaigns';
import { registerPackageInvoicingPort } from '../packages';
import {
  creditNoteForCampaign,
  issueInvoiceForCampaign,
  issueInvoiceForPackage,
  markCampaignInvoicePaid,
} from './invoices.service';

export {
  invoiceFinanceRouter,
  advertiserInvoiceRouter,
  publisherInvoiceRouter,
  statementRouter,
} from './invoices.routes';

/**
 * Supplies the ports `campaigns` and `packages` declare — they cannot import
 * this module without a cycle, since it reads theirs. Called by
 * bootstrap/register-modules; unregistered, the checkout books without
 * invoicing and the desk's `POST /finance/invoices/issue` catches up.
 */
export function registerInvoicesModule(): void {
  registerCampaignInvoicingPort({
    issueForCampaign: (campaignId, byUserId) => issueInvoiceForCampaign(campaignId, { byUserId }),
    markCampaignPaid: (campaignId) => markCampaignInvoicePaid(campaignId),
    creditNoteForCampaign: (campaignId, reason, byUserId) => creditNoteForCampaign(campaignId, reason, byUserId),
  });
  registerPackageInvoicingPort({
    issueForPackageSale: (saleId, byUserId) => issueInvoiceForPackage(saleId, { byUserId }),
  });
}

/**
 * Lot C's door: the gateway payment or the recorded top-up that settled an
 * invoice. Idempotent.
 */
export { markInvoicePaid, liveInvoiceFor, issueInvoiceForCampaign, issueInvoiceForPackage, voidInvoice } from './invoices.service';
export type { InvoiceView, InvoiceListView } from './invoices.service';

/** Run by the scheduler on the first of the month: the previous month's payment advices. */
export {
  runMonthlyStatements,
  generatePublisherStatement,
  previousMonth,
  monthWindow,
  monthWindowFor,
  isFirstOfMonthIST,
} from './statements.service';
export type { MonthWindow, MonthlyStatementsRun, StatementView } from './statements.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
