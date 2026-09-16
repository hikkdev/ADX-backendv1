/**
 * Campaigns — DR 02's booking flow, which is campaign management.
 *
 * Seventeen screens collect a brief; the brief buys spots; paid spots become
 * orders and DR 03's fulfilment chain takes over. This module owns the first
 * two of those and hands off at the third.
 *
 * It does not own money — `advertisers` owns the wallet and `revenue` owns the
 * arithmetic, and both are called rather than reimplemented. It does not own
 * fulfilment either: `orders` does, and a campaign spot points at an order
 * rather than duplicating one.
 *
 * What it does own, and nothing else does: what an advertiser was trying to
 * achieve, which inventory suits it and why, and what the campaign actually did.
 */
export { campaignRouter, trackingRouter } from './campaigns.routes';

/**
 * Lot B (Q41): the refund desk's campaign queue, mounted by bootstrap at
 * /finance/campaign-refunds. A cancel after capture records what is owed;
 * finance releases it here and the wallet is credited through `advertisers`.
 */
export { campaignRefundRouter } from './refunds/campaign-refunds.controller';
export { openCampaignRefund, releaseCampaignRefund, rejectCampaignRefund, listCampaignRefunds } from './refunds/campaign-refunds.service';
export type { CampaignRefundRow, CampaignRefundView } from './campaigns.repository';
export type { CancelOutcome } from './checkout.service';

/**
 * Run by the scheduler. Campaigns cross their own start and end dates without
 * anybody pressing anything, and the money moves when they do.
 */
export { runCampaignTransitions } from './checkout.service';

/**
 * Used by `suspension` for Lot A's STOP_OPEN_WORK. Cancelling the work is one
 * thing; saying what it owes back is another, and both live here because this
 * module owns the spots and the flight. Neither touches a wallet.
 */
export { cancelSpotsForOrders, cancelAdvertiserCampaigns, unusedDays } from './checkout.service';

/**
 * Used by `account-lifecycle` for Lot A's closure review (Q21): the same
 * SCHEDULED-or-LIVE campaigns, listed rather than cancelled, so the review and
 * the act read the same filter.
 */
export { listOpenCampaignsForAdvertiser } from './checkout.service';
export type { CampaignRefund } from './checkout.service';

/** Also scheduled: yesterday's numbers, frozen before the world moves on. */
export { snapshotDailyMetrics } from './analytics.service';

/**
 * Lot B (Q13): the invoice. `invoices` reads the booking snapshot through
 * `findCampaignForInvoice`; the checkout reaches back through the port —
 * registered by bootstrap — because this module cannot import `invoices`
 * without a cycle. See invoicing.port.ts.
 */
export { findCampaignForInvoice } from './checkout.service';
export type { CampaignInvoiceSnapshot } from './checkout.service';
export { registerCampaignInvoicingPort } from './invoicing.port';
export type { CampaignInvoicingPort } from './invoicing.port';

/**
 * Lot D (Q104): `reviews` lets the campaign's advertiser rate a spot that ran
 * to the end. `assertMayAct` is the same ownership rule every campaign route
 * applies; `findCampaignSpotForReview` is the narrow read behind it.
 */
export { assertMayAct, findCampaignSpotForReview } from './campaigns.service';
export type { Actor as CampaignActor } from './campaigns.service';
/**
 * E7-2: the other direction — GET /campaigns/:id marks each spot reviewed
 * or not through the port bootstrap fills with `reviews.reviewIdsForCampaignSpots`,
 * because this module cannot import `reviews` back.
 */
export { registerSpotReviewPort } from './spot-review.port';
export type { SpotReviewPort, SpotReviewMark } from './spot-review.port';

/**
 * Lot D (Q120): the print gate. `orders.markPrintReady` asks whether an
 * order's artwork is approved through the port bootstrap registers, because
 * `orders` cannot import this module. `resetLaunchWarnings` is for tests.
 */
export { creativeGateForOrder, currentCreatives, outstandingCreatives } from './moderation.service';
export { resetLaunchWarnings } from './checkout.service';
export type { CreativeCheck } from './moderation.service';

/**
 * Lot C (Q88/Q110): `payments` prices a campaign for a gateway order through
 * `campaignPaymentQuote` and, once the gateway captured and the wallet is
 * credited, authorises it through `authorizeCampaignById`; the lifecycle job
 * sweeps lapsed 24-hour reservations with `expireSpotReservations`.
 */
export { campaignPaymentQuote, authorizeCampaignById, expireSpotReservations, RESERVATION_HOURS } from './checkout.service';
export type { CampaignPaymentQuote, AuthorizeResult } from './checkout.service';

/** Used by the console's campaign screens and by the apps. */
export type { CampaignAnalytics, PortfolioAnalytics } from './analytics.service';
export type { CampaignReview } from './checkout.service';
export type { InventoryMatch } from './inventory.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
