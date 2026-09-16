import type { Request, Response } from 'express';
import type { z } from 'zod';
import { ApiError } from '../../shared/errors';
import type { PaymentGateway } from '../../shared/database';
import { assertMayActFor, getAdvertiserForUser } from '../advertisers';
import { findAgentProfile } from '../agents';
import { findPublisherForUser } from '../publishers';
import {
  advertiserPaymentsQuerySchema,
  checkoutQuerySchema,
  confirmSchema,
  createIntentSchema,
  listPaymentsQuerySchema,
  refundSchema,
} from './payments.schema';
import { checkoutPage, returnPage, returnRedirectUrlFor, type RenderedPage } from './checkout-page.service';
import {
  actorFromCheckoutToken,
  confirmPayment,
  createIntent,
  getPayment,
  handleWebhook,
  listGateways,
  listPaymentsPage,
  refundPayment,
  toPaymentView,
  type PaymentActor,
} from './payments.service';

function parse<T>(schema: { safeParse: (v: unknown) => any }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }
  return parsed.data as T;
}

/**
 * Who is asking — the same resolution the booking flow makes. The token's
 * user id is looked up against the three tables (Lot J-B2 adds the
 * publisher, the lookup `revenue`'s order routes make); a client cannot pay
 * as somebody else by naming their id.
 */
async function resolveActor(req: Request): Promise<PaymentActor> {
  const userId = req.user!.sub;
  const [advertiser, agent, publisher] = await Promise.all([getAdvertiserForUser(userId), findAgentProfile(userId), findPublisherForUser(userId)]);
  return {
    userId,
    isAdmin: req.user!.roles.includes('ADMIN'),
    advertiserId: advertiser?.id ?? null,
    publisherId: publisher?.id ?? null,
    agentId: agent?.id ?? null,
  };
}

/* ── /payments ─────────────────────────────────────────────────────── */

export async function gatewaysHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listGateways(req.user!.roles.includes('ADMIN')) });
}

export async function createIntentHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof createIntentSchema>>(createIntentSchema, req.body);
  const actor = await resolveActor(req);
  const result = await createIntent(body, actor);
  res.status(201).json({ success: true, data: result });
}

/**
 * A bearer, or (E7-2) the checkout page's one-time token: the page runs in
 * the system browser with no session. Either way the service verifies the
 * signature and reads the payment back from the gateway before anything
 * moves; the token only decides who the confirmation is recorded as.
 */
export async function confirmHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof confirmSchema>>(confirmSchema, req.body);
  const paymentId = req.params['id'] as string;
  const actor = req.user ? await resolveActor(req) : await actorFromCheckoutToken(paymentId, body.checkoutToken ?? '');
  const payment = await confirmPayment(paymentId, body, actor);
  res.json({ success: true, data: toPaymentView(payment) });
}

/* ── The browser pages (E7-2) ──────────────────────────────────────── */

function sendPage(res: Response, page: RenderedPage): void {
  res.set('Content-Security-Policy', page.csp);
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Robots-Tag', 'noindex');
  res.set('X-Content-Type-Options', 'nosniff');
  res.status(page.status).type('text/html').send(page.html);
}

/** GET /payments/:id/checkout?t= — no bearer; the token is the door. */
export async function checkoutPageHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof checkoutQuerySchema>>(checkoutQuerySchema, req.query);
  sendPage(res, await checkoutPage(req.params['id'] as string, query.t));
}

/** GET /payments/:id/return?t= — public; the status word alone without the intent's return token (E9). */
export async function returnPageHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof checkoutQuerySchema>>(checkoutQuerySchema, req.query);
  sendPage(res, await returnPage(req.params['id'] as string, query.t));
}

export async function getPaymentHandler(req: Request, res: Response): Promise<void> {
  const actor = await resolveActor(req);
  const payment = await getPayment(req.params['id'] as string, actor);
  res.json({ success: true, data: toPaymentView(payment) });
}

/** ADMIN: the register, on the list contract. */
export async function listPaymentsHandler(req: Request, res: Response): Promise<void> {
  const query = parse<z.infer<typeof listPaymentsQuerySchema>>(listPaymentsQuerySchema, req.query);
  res.json({ success: true, data: await listPaymentsPage(query) });
}

/** ADMIN + finance.approve: a refund through the gateway. The service audits it. */
export async function refundHandler(req: Request, res: Response): Promise<void> {
  const body = parse<z.infer<typeof refundSchema>>(refundSchema, req.body);
  const result = await refundPayment(req.params['id'] as string, body, req.user!.sub);
  res.json({ success: true, data: result });
}

/* ── /advertisers/:id/payments ─────────────────────────────────────── */

/** The advertiser's own payments — owner, their attributed agent (read), or an admin. */
export async function advertiserPaymentsHandler(req: Request, res: Response): Promise<void> {
  const advertiserId = req.params['id'] as string;
  await assertMayActFor(req, advertiserId, 'READ');
  const query = parse<z.infer<typeof advertiserPaymentsQuerySchema>>(advertiserPaymentsQuerySchema, req.query);
  res.json({ success: true, data: await listPaymentsPage({ ...query, advertiserId }) });
}

/* ── /webhooks/:gateway ────────────────────────────────────────────── */

/**
 * The provider's server-to-server call. No token — the signature is the
 * authentication, checked in the adapter and failing closed. A verified
 * event is applied once; the answer is always 200 for a verified body so
 * the gateway stops retrying, and 401 for one it cannot verify.
 */
function webhookHandler(gateway: PaymentGateway) {
  return async (req: Request, res: Response): Promise<void> => {
    const result = await handleWebhook(gateway, {
      rawBody: req.rawBody,
      body: req.body,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    res.json({ success: true, data: result });
  };
}

export const razorpayWebhookHandler = webhookHandler('RAZORPAY');
export const cashfreeWebhookHandler = webhookHandler('CASHFREE');

/**
 * CCAvenue posts its encResp to the redirect URL with the customer's own
 * browser, so after the event is applied the browser is sent on to the
 * app's return page rather than left looking at JSON. A server-side call
 * (no Accept: text/html) gets the JSON the other two answer.
 */
export async function ccavenueWebhookHandler(req: Request, res: Response): Promise<void> {
  const result = await handleWebhook('CCAVENUE', {
    rawBody: req.rawBody,
    body: req.body,
    headers: req.headers as Record<string, string | string[] | undefined>,
  });
  const orderNo = typeof req.body?.orderNo === 'string' ? req.body.orderNo : null;
  if (orderNo && (req.get('accept') ?? '').includes('text/html')) {
    const outcome = result.outcome === 'CAPTURED' ? 'captured' : result.outcome === 'FAILED' ? 'failed' : 'pending';
    // E7-2: the API's own return page, which reads the row; `status` is a hint
    // for the log, never trusted. E9: under a fresh return token, so the browser
    // that paid sees the reference and the amount.
    res.redirect(302, await returnRedirectUrlFor(orderNo, outcome));
    return;
  }
  res.json({ success: true, data: result });
}
