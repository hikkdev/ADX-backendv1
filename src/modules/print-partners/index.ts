/**
 * Print partners — Lot B (Q50/B4b) and Lot H (Q147): the print shops ADX
 * pays to deliver a booking, as payees and, since Lot H, as a floor of
 * their own in the user app.
 *
 * A partner is a User with role PARTNER — inactive until ops activates the
 * account, then signed in by the ordinary OTP — a PrintPartner row ops
 * keeps, and a wallet with the fourth owner key. One PrintJob per order,
 * opened by hand or by the award of a quote request; approving its cost
 * posts PRINT_COST into the partner's wallet with TDS under 194C, and the
 * money leaves through the ordinary withdrawal ladder, raised by the
 * partner themselves or at the desk on their behalf.
 *
 * Reads orders (`getOrderSummary`, `notifyAdmins`); `orders` reads the job
 * back through the `PrintJobPort` it declares, which
 * `registerPrintPartnersModule` fills.
 */
export { printPartnerRouter, printJobRouter, printQuoteRequestsRouter } from './print-partners.routes';

/** Lot N: the print partner's KYC desk — `/print-partner-kyc`; the partner's own routes ride `printPartnerRouter` at `/me/kyc`. */
export { printPartnerKycRouter } from './kyc/print-partner-kyc.routes';
/** Lot N, for bootstrap: claims a Digio webhook whose request id is a print partner's (registered on `publishers`' unmatched-webhook list). */
export { handlePrintPartnerDigioWebhook } from './kyc/print-partner-digio.service';
/** Lot N, for `jobs/kyc-purge.job.ts`: the Digio-path partner images, thirty days after verification. */
export { purgeVerifiedPrintPartnerImages } from './kyc/print-partner-kyc.service';

/**
 * Fills the port `orders` declares: the pickup point for the PICKUP code and
 * the order read, and the collect-prints step marking the job COLLECTED.
 * Called once from bootstrap.
 */
export { registerPrintPartnersModule } from './print-partners.module';

/** O-B: `{ id, label, displayId }` per partner id, for `section-overviews`. */
export { findPrintPartnerLabels } from './print-partners.service';

/**
 * Lot S: `party-imports` creates and merges partners through the desk's own
 * doors — `createPartner` (the User, the wallet, the identifier) and
 * `updatePartner` (the blanks a merge fills) — never a row of its own.
 */
export { createPartner, updatePartner } from './print-partners.service';
export type { CreatePartnerInput, UpdatePartnerInput } from './print-partners.schema';

/** Read by the console and by tests: the order-status gate and the ladder. */
export { PRINTABLE_ORDER_STATUSES } from './print-jobs.service';
export { PRINT_JOB_STATUSES, QUOTE_REQUEST_STATUSES, QUOTE_STATUSES } from './print-partners.repository';
export type { PartnerRow, JobRow, JobWithPartner } from './print-partners.repository';

/** Lot H: the nightly job — OPEN requests past their deadline, re-invited once and then expired. */
export { expireQuoteRequests } from './print-quotes.service';
export type { ExpirySummary } from './print-quotes.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
