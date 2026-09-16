/**
 * Revenue — what an advertiser pays, and what a publisher keeps.
 *
 * The pricing engine decides what a publisher *lists at*. This decides what
 * happens to that number afterwards: ADX's commission out of the publisher's
 * earnings, the fees an advertiser pays on top, GST on each line, and the price
 * lock that holds a rate while somebody decides.
 *
 * Commission is never added to the advertiser's price. That one fact explains
 * most of the shape here.
 *
 * See docs/revenue-model.md.
 */
export { revenueRouter } from './revenue.routes';
export { quote, resolveCommission, lockPrice, heldRate, lockDuration } from './revenue.service';
/**
 * Lot B (B1): the accrual's late resolution for a spot authorised before the
 * commission stamp existed. Wired into `payouts` through its
 * CommissionResolverPort in bootstrap, because `revenue` already reaches
 * `advertisers`, which reaches `payouts`.
 */
export { commissionForListing } from './revenue.service';
export type { Quote, QuoteLine, CommissionSource, ResolvedCommission } from './revenue.service';

/** Lot I: for `support` — the subscription a publisher is running on, the fact that makes them a paid subscriber; the batch form (I4-B) is the inbox's one-query read. */
export { runningSubscriptionForPublisher, runningSubscriptionsForPublishers } from './revenue.service';

/**
 * Lot J (B1): the publisher plan catalogue and the self-service orders.
 * `publisherPlansByTier` is what `support`'s live-chat entitlement reads
 * (one query, every tier); the four order exports are the payments lane's
 * door, the same shape `packages` gives it; the sweep is the daily job's.
 */
export {
  publisherPlansByTier,
  listPlans,
  findPlan,
  findSubscriptionOrder,
  assertMayPaySubscriptionOrder,
  assertSubscriptionOrderPayable,
  assertSubscriptionOrderActivatable,
  markSubscriptionOrderPaid,
  runPublisherSubscriptionSweep,
} from './publisher-plans.service';
export type { PlanByTier, PlanView, OrderActor, OrderView, Term, TermRule, PricingRates, PolicyView } from './publisher-plans.service';
export type { OrderRow as SubscriptionOrderRow } from './publisher-plans.repository';

/**
 * Lot J2: the tax row (`taxSettings` — GST for both subscription pricing
 * paths; `packages` reads it so there is one configurable GST), the
 * pure helpers both paths share (`assertCycleOffered`, `fractionToPercent`,
 * `prorationAmount`), and the grace-aware reads `support` asks
 * (`entitledSubscriptionForPublisher`, the batch form for the inbox). The
 * commission resolution keeps reading `runningSubscriptionForPublisher`:
 * a rate is what was paid for, and a grace day is a courtesy on the copy,
 * never on the take.
 */
export { taxSettings } from './revenue.service';
export { assertCycleOffered, fractionToPercent, policyView, prorationAmount, entitledSubscriptionForPublisher, entitledSubscriptionsForPublishers } from './publisher-plans.service';
export type { EntitledSubscription, Proration } from './publisher-plans.service';

/** Lot B (Q13): the SAC codes and GST rates `invoices` prints beside each line. */
export { invoiceTaxCodes } from './revenue.service';
export type { InvoiceTaxCodes } from './revenue.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
