import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { requireFeature } from '../feature-flags';
import * as h from './payments.controller';
import type { NextFunction, Request, Response } from 'express';

/** Authenticate when a bearer is offered; let a body carrying the page's one-time token through to the handler. */
function bearerOrCheckoutToken(req: Request, res: Response, next: NextFunction): void {
  if (!req.get('authorization') && typeof req.body?.checkoutToken === 'string') {
    next();
    return;
  }
  authenticate(req, res, next);
}

/**
 * Three routers, mounted by bootstrap where their paths live.
 *
 * `paymentRouter` is the party's side under /payments: which gateways are
 * on, the intent, the client-side confirmation and the read. No role gate
 * on those — an advertiser and their agent both pay, and who may touch a
 * payment is decided per row in the service. The register and the refund
 * are ADMIN, the refund `finance.approve` on top: it is money leaving ADX.
 *
 * `paymentWebhookRouter` carries no token at all: the gateway's signature
 * is the authentication, checked in each adapter and failing closed.
 */

export const paymentRouter = Router();

/*
 * E7-2: the two browser pages and the token confirm sit AHEAD of the
 * router's authenticate. The phones open Razorpay in the system browser,
 * which carries no bearer: the checkout page's door is a one-time token in
 * the link, the confirm it posts rides a second one, and the return page —
 * the redirect the other gateways land on — is public and answers only the
 * payment's status. A confirm that arrives with a bearer is authenticated
 * as before; one without is refused unless it carries the page's token.
 */
paymentRouter.get('/:id/checkout', asyncHandler(h.checkoutPageHandler));
paymentRouter.get('/:id/return', asyncHandler(h.returnPageHandler));
paymentRouter.post('/:id/confirm', bearerOrCheckoutToken, asyncHandler(h.confirmHandler));

paymentRouter.use(authenticate);

paymentRouter.get('/gateways', asyncHandler(h.gatewaysHandler));
/* G10: the kill switch on money arriving — no new intent while `payments.gateways` is off; a payment already in flight still confirms and reads. */
paymentRouter.post('/intents', requireFeature('payments.gateways'), asyncHandler(h.createIntentHandler));
/* The register — ADMIN, on the list contract. Declared before /:id so nothing reads "gateways" or "intents" as an id. */
paymentRouter.get('/', requireRole('ADMIN'), asyncHandler(h.listPaymentsHandler));
paymentRouter.get('/:id', asyncHandler(h.getPaymentHandler));
paymentRouter.post('/:id/refund', requireRole('ADMIN'), requirePermission('finance.approve'), asyncHandler(h.refundHandler));

/* ── /advertisers/:id/payments — the advertiser's own record ───────── */

export const advertiserPaymentRouter = Router();
advertiserPaymentRouter.use(authenticate);
advertiserPaymentRouter.get('/:id/payments', asyncHandler(h.advertiserPaymentsHandler));

/* ── /webhooks/{razorpay,cashfree,ccavenue} ────────────────────────── */

export const paymentWebhookRouter = Router();
paymentWebhookRouter.post('/razorpay', asyncHandler(h.razorpayWebhookHandler));
paymentWebhookRouter.post('/cashfree', asyncHandler(h.cashfreeWebhookHandler));
paymentWebhookRouter.post('/ccavenue', asyncHandler(h.ccavenueWebhookHandler));
