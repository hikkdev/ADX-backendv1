import crypto from 'crypto';
import { getEffectiveRazorpayConfig, type RazorpayConfig } from '../../../shared/integrations';
import { verifyHmacSignature } from '../../../shared/security';
import { fromPaise, headerValue, toPaise } from './gateway';
import type {
  CreateOrderInput,
  CreateOrderResult,
  FetchedPayment,
  GatewayAdapter,
  GatewayPaymentStatus,
  GatewayReadiness,
  GatewayRefundStatus,
  ParsedWebhook,
  RefundInput,
  RefundResult,
  WebhookEvent,
  WebhookRequest,
} from './gateway';
import { gatewayError, gatewayFetch, type FetchLike } from './http';

/**
 * Razorpay — the gateway that goes live first (Q110).
 *
 *   Orders API      POST /v1/orders, amount in paise, Basic auth key:secret
 *   Checkout        the app opens Razorpay's checkout with the order id and
 *                   key id; the handler returns payment id + signature =
 *                   HMAC-SHA256(order_id|payment_id, key secret), hex
 *   Payments API    GET /v1/payments/:id; POST /v1/payments/:id/capture for
 *                   a payment the account authorises first
 *   Refunds API     POST /v1/payments/:id/refund, amount in paise
 *   Webhooks        X-Razorpay-Signature = HMAC-SHA256(raw body, webhook
 *                   secret), hex; X-Razorpay-Event-Id for idempotency
 *
 * One host serves both modes; the key prefix (rzp_test_ / rzp_live_) is what
 * decides. `testMode` is kept beside the keys for the console's record.
 */

export const RAZORPAY_HOST = 'https://api.razorpay.com';
const SIGNATURE_HEADER = 'x-razorpay-signature';
const EVENT_ID_HEADER = 'x-razorpay-event-id';

type RazorpayPayment = {
  id: string;
  order_id?: string | null;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  amount: number;
  currency: string;
  method?: string | null;
  error_description?: string | null;
  error_reason?: string | null;
};

type RazorpayRefund = {
  id: string;
  payment_id: string;
  amount: number;
  status: 'pending' | 'processed' | 'failed';
};

const paymentStatus = (status: RazorpayPayment['status']): GatewayPaymentStatus =>
  status === 'captured' ? 'CAPTURED' : status === 'authorized' ? 'AUTHORIZED' : status === 'failed' ? 'FAILED' : status === 'refunded' ? 'REFUNDED' : 'CREATED';

const refundStatus = (status: RazorpayRefund['status']): GatewayRefundStatus =>
  status === 'processed' ? 'PROCESSED' : status === 'failed' ? 'FAILED' : 'PENDING';

function toFetched(payment: RazorpayPayment): FetchedPayment {
  return {
    gatewayPaymentId: payment.id,
    gatewayOrderId: payment.order_id ?? null,
    status: paymentStatus(payment.status),
    amount: fromPaise(payment.amount),
    currency: payment.currency,
    method: payment.method ?? null,
    failureReason: payment.error_description ?? payment.error_reason ?? null,
    raw: payment,
  };
}

export function createRazorpayAdapter(
  loadConfig: () => Promise<RazorpayConfig> = getEffectiveRazorpayConfig,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): GatewayAdapter {
  const authHeaders = (cfg: RazorpayConfig) => ({
    Authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`,
    'Content-Type': 'application/json',
  });

  async function readiness(): Promise<GatewayReadiness> {
    const cfg = await loadConfig();
    const missing = (['keyId', 'keySecret', 'webhookSecret'] as const).filter((key) => !cfg[key]);
    return { configured: missing.length === 0, testMode: cfg.testMode ?? true, missing };
  }

  return {
    name: 'RAZORPAY',
    readiness,

    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      const cfg = await loadConfig();
      const amount = toPaise(input.amount);
      const result = await gatewayFetch(fetchImpl, 'Razorpay', `${RAZORPAY_HOST}/v1/orders`, {
        method: 'POST',
        headers: authHeaders(cfg),
        body: JSON.stringify({
          amount,
          currency: input.currency,
          receipt: input.paymentId,
          notes: { reference: input.reference, advertiserId: input.customer.id, description: input.description },
        }),
      });
      if (result.status < 200 || result.status >= 300) throw gatewayError('Razorpay', result, 'Could not create the order');
      const order = result.json as { id: string; amount: number; currency: string };
      return {
        gatewayOrderId: order.id,
        checkout: { orderId: order.id, keyId: cfg.keyId, amount: order.amount ?? amount, currency: order.currency ?? input.currency },
      };
    },

    async verifySignature({ gatewayOrderId, gatewayPaymentId, signature }): Promise<boolean> {
      const cfg = await loadConfig();
      if (!cfg.keySecret) return false;
      const expected = crypto.createHmac('sha256', cfg.keySecret).update(`${gatewayOrderId}|${gatewayPaymentId}`).digest('hex');
      const offered = signature.trim().toLowerCase();
      const left = Buffer.from(expected, 'utf8');
      const right = Buffer.from(offered, 'utf8');
      return left.length === right.length && crypto.timingSafeEqual(left, right);
    },

    async fetchPayment(gatewayPaymentId: string): Promise<FetchedPayment> {
      const cfg = await loadConfig();
      const result = await gatewayFetch(fetchImpl, 'Razorpay', `${RAZORPAY_HOST}/v1/payments/${encodeURIComponent(gatewayPaymentId)}`, {
        method: 'GET',
        headers: authHeaders(cfg),
      });
      if (result.status < 200 || result.status >= 300) throw gatewayError('Razorpay', result, 'Could not read the payment');
      return toFetched(result.json as RazorpayPayment);
    },

    async capture({ gatewayPaymentId, amount, currency }): Promise<FetchedPayment> {
      const cfg = await loadConfig();
      const result = await gatewayFetch(fetchImpl, 'Razorpay', `${RAZORPAY_HOST}/v1/payments/${encodeURIComponent(gatewayPaymentId)}/capture`, {
        method: 'POST',
        headers: authHeaders(cfg),
        body: JSON.stringify({ amount: toPaise(amount), currency }),
      });
      if (result.status < 200 || result.status >= 300) throw gatewayError('Razorpay', result, 'Could not capture the payment');
      return toFetched(result.json as RazorpayPayment);
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const cfg = await loadConfig();
      const result = await gatewayFetch(fetchImpl, 'Razorpay', `${RAZORPAY_HOST}/v1/payments/${encodeURIComponent(input.gatewayPaymentId)}/refund`, {
        method: 'POST',
        headers: authHeaders(cfg),
        body: JSON.stringify({ amount: toPaise(input.amount), receipt: input.refundId, notes: { reason: input.note } }),
      });
      if (result.status < 200 || result.status >= 300) throw gatewayError('Razorpay', result, 'Could not refund the payment');
      const refund = result.json as RazorpayRefund;
      return { gatewayRefundId: refund.id, status: refundStatus(refund.status), raw: refund };
    },

    async parseWebhook(request: WebhookRequest): Promise<ParsedWebhook> {
      const cfg = await loadConfig();
      const verdict = verifyHmacSignature({
        rawBody: request.rawBody,
        signature: headerValue(request.headers, SIGNATURE_HEADER),
        secret: cfg.webhookSecret,
      });
      if (!verdict.ok) return { ok: false, reason: verdict.reason };

      const body = request.body as
        | { event?: string; payload?: { payment?: { entity?: RazorpayPayment }; refund?: { entity?: RazorpayRefund }; order?: { entity?: { id?: string } } } }
        | null;
      if (!body || typeof body.event !== 'string') return { ok: false, reason: 'UNPARSEABLE' };

      const payment = body.payload?.payment?.entity;
      const refund = body.payload?.refund?.entity;
      const orderId = payment?.order_id ?? body.payload?.order?.entity?.id ?? null;
      const eventType = body.event;

      const base: WebhookEvent = {
        eventId: headerValue(request.headers, EVENT_ID_HEADER) ?? `${eventType}:${refund?.id ?? payment?.id ?? orderId ?? 'unknown'}`,
        eventType,
        kind: 'IGNORED',
        gatewayOrderId: orderId,
        gatewayPaymentId: payment?.id ?? refund?.payment_id ?? null,
        gatewayRefundId: refund?.id ?? null,
        status: null,
        refundStatus: null,
        amount: null,
        method: null,
        failureReason: null,
      };

      if (eventType.startsWith('payment.') && payment) {
        const fetched = toFetched(payment);
        return {
          ok: true,
          payload: body,
          event: {
            ...base,
            kind: eventType === 'payment.captured' || eventType === 'payment.failed' || eventType === 'payment.authorized' ? 'PAYMENT' : 'IGNORED',
            status: fetched.status,
            amount: fetched.amount,
            method: fetched.method,
            failureReason: fetched.failureReason,
          },
        };
      }
      if (eventType.startsWith('refund.') && refund) {
        return {
          ok: true,
          payload: body,
          event: { ...base, kind: 'REFUND', refundStatus: refundStatus(refund.status), amount: fromPaise(refund.amount) },
        };
      }
      return { ok: true, payload: body, event: base };
    },
  };
}
