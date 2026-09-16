import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { requireFeature } from '../feature-flags';
import {
  cancelOrderHandler,
  createOrderHandler,
  getOrderHandler,
  listOrdersHandler,
  listPlansHandler,
  listSubscriptionsPageHandler,
  mySubscriptionHandler,
  payOrderHandler,
  quoteOrderHandler,
  recordOrderPaymentHandler,
  setAutoRenewHandler,
  startTrialHandler,
  updatePlanHandler,
} from './publisher-plans.controller';
import {
  createFeeHandler,
  endSubscriptionHandler,
  getTaxHandler,
  grantOverrideHandler,
  grantSubscriptionHandler,
  heldRateHandler,
  listCommissionRatesHandler,
  listFeesHandler,
  listOverridesHandler,
  lockPriceHandler,
  quoteHandler,
  setCommissionRateHandler,
  updateFeeHandler,
  updateTaxHandler,
} from './revenue.controller';

export const revenueRouter = Router();
revenueRouter.use(authenticate);

/* ── Quote ───────────────────────────────────────────────────────────
 * ADMIN only. The response names ADX's take rate and where it came from,
 * which neither side of the marketplace should be able to read: the
 * advertiser is not meant to see commission at all, and a publisher learning
 * that a neighbour holds a promotional rate is its own commercial problem.
 * The trimmed advertiser-facing version belongs with the cart.
 */
revenueRouter.post('/quote', requireRole('ADMIN'), asyncHandler(quoteHandler));

/* ── Price locks ─────────────────────────────────────────────────────
 * The advertiser comes from the session, never the body, so these are open
 * to any signed-in caller with an advertiser account.
 */
revenueRouter.post('/price-locks', asyncHandler(lockPriceHandler));
revenueRouter.get('/price-locks/:listingId', asyncHandler(heldRateHandler));

/* ── Commission, ops only ────────────────────────────────────────────── */
revenueRouter.get('/commission', requireRole('ADMIN'), asyncHandler(listCommissionRatesHandler));
revenueRouter.post('/commission', requireRole('ADMIN'), asyncHandler(setCommissionRateHandler));

/* ── Lot J (B1): the publisher plan catalogue and the self-service orders ──
 * The catalogue reads for anyone signed in — the phone draws the cards from
 * it — and its editor is ADMIN, audited in the service. The order routes and
 * the phone's own screen sit behind the `revenue.publisher-plans` kill
 * switch; who may act on an order is decided per order in the service.
 */
revenueRouter.get('/plans', asyncHandler(listPlansHandler));
revenueRouter.patch('/plans/:tier', requireRole('ADMIN'), asyncHandler(updatePlanHandler));

const publisherPlans = requireFeature('revenue.publisher-plans');
revenueRouter.post('/subscription-orders/quote', publisherPlans, asyncHandler(quoteOrderHandler));
/* Lot J2 (5): the free trial — declared before `/:id` so `trial` is never taken for an order id. */
revenueRouter.post('/subscription-orders/trial', publisherPlans, asyncHandler(startTrialHandler));
revenueRouter.get('/subscription-orders', publisherPlans, requireRole('ADMIN'), asyncHandler(listOrdersHandler));
revenueRouter.post('/subscription-orders', publisherPlans, asyncHandler(createOrderHandler));
revenueRouter.get('/subscription-orders/:id', publisherPlans, asyncHandler(getOrderHandler));
revenueRouter.post('/subscription-orders/:id/pay', publisherPlans, asyncHandler(payOrderHandler));
revenueRouter.post('/subscription-orders/:id/cancel', publisherPlans, asyncHandler(cancelOrderHandler));
revenueRouter.post(
  '/subscription-orders/:id/record-payment',
  publisherPlans,
  requireRole('ADMIN'),
  asyncHandler(recordOrderPaymentHandler)
);

/* The publisher's own screen. Declared before the ADMIN reads so `me` is never taken for an id. */
revenueRouter.get('/subscriptions/me', publisherPlans, asyncHandler(mySubscriptionHandler));
/* Lot J2 (6): the subscriber's auto-renew switch on the running row. */
revenueRouter.patch('/subscriptions/me', publisherPlans, asyncHandler(setAutoRenewHandler));

/* Lot J2 (d): the console's list on the list contract. */
revenueRouter.get('/subscriptions', requireRole('ADMIN'), asyncHandler(listSubscriptionsPageHandler));
revenueRouter.post('/subscriptions', requireRole('ADMIN'), asyncHandler(grantSubscriptionHandler));
revenueRouter.post(
  '/subscriptions/:id/end',
  requireRole('ADMIN'),
  asyncHandler(endSubscriptionHandler)
);

/* ADX giving up its own revenue. Approver recorded, reason required. */
revenueRouter.get('/overrides', requireRole('ADMIN'), asyncHandler(listOverridesHandler));
revenueRouter.post('/overrides', requireRole('ADMIN'), asyncHandler(grantOverrideHandler));

/* ── Fees and tax ────────────────────────────────────────────────────── */
revenueRouter.get('/fees', requireRole('ADMIN'), asyncHandler(listFeesHandler));
revenueRouter.post('/fees', requireRole('ADMIN'), asyncHandler(createFeeHandler));
revenueRouter.patch('/fees/:id', requireRole('ADMIN'), asyncHandler(updateFeeHandler));

revenueRouter.get('/tax', requireRole('ADMIN'), asyncHandler(getTaxHandler));
revenueRouter.patch('/tax', requireRole('ADMIN'), asyncHandler(updateTaxHandler));
