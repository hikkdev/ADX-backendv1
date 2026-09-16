import crypto from 'crypto';
import { getEffectiveCashfreeConfig, type CashfreeConfig } from '../../../shared/integrations';
import { money } from '../../../shared/money';
import { headerValue } from './gateway';
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
 * Cashfree Payments (PG), API version 2023-08-01 — an adapter in test mode
 * until its credentials arrive (Q110).
 *
 *   Orders      POST /pg/orders, amount in rupees, x-client-id / x-client-
 *               secret headers; answers `payment_session_id`, which the app
 *               hands to Cashfree's checkout SDK. Our Payment id is the
 *               merchant order id.
 *   Payments    GET /pg/orders/{order_id}/payments — every attempt on the
 *               order; SUCCESS is the capture.
 *   Refunds     POST /pg/orders/{order_id}/refunds, keyed on our refund id.
 *   Webhooks    x-webhook-signature = base64(HMAC-SHA256(timestamp + raw
 *               body, secret)), x-webhook-timestamp beside it. The secret is
 *               the client secret unless a dedicated webhook secret is set.
 *
 * Test mode targets sandbox.cashfree.com; live is api.cashfree.com.
 */

export const CASHFREE_SANDBOX_HOST = 'https://sandbox.cashfree.com';
export const CASHFREE_LIVE_HOST = 'https://api.cashfree.com';
const API_VERSION = '2023-08-01';
const SIGNATURE_HEADER = 'x-webhook-signature';
const TIMESTAMP_HEADER = 'x-webhook-timestamp';

type CashfreePayment = {
  cf_payment_id: number | string;
  order_id?: string;
  payment_status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'USER_DROPPED' | 'CANCELLED' | 'VOID' | 'NOT_ATTEMPTED' | 'FLAGGED';
  payment_amount: number;
  payment_currency?: string;
  payment_group?: string | null;
  payment_message?: string | null;
};

type CashfreeRefund = {
  cf_refund_id: string | number;
  refund_id: string;
  cf_payment_id?: number | string;
  order_id?: string;
  refund_status: 'SUCCESS' | 'PENDING' | 'CANCELLED' | 'ONHOLD';
  refund_amount: number;
};

const paymentStatus = (status: CashfreePayment['payment_status']): GatewayPaymentStatus =>
  status === 'SUCCESS' ? 'CAPTURED' : status === 'PENDING' || status === 'NOT_ATTEMPTED' ? 'CREATED' : 'FAILED';

const refundStatus = (status: CashfreeRefund['refund_status']): GatewayRefundStatus =>
  status === 'SUCCESS' ? 'PROCESSED' : status === 'CANCELLED' ? 'FAILED' : 'PENDING';

/** Cashfree wants the national number; the platform stores +91… */
const nationalNumber = (mobile: string | null): string => (mobile ?? '').replace(/^\+?91/, '').replace(/\D/g, '');

function toFetched(payment: CashfreePayment, orderId: string | null): FetchedPayment {
  return {
    gatewayPaymentId: String(payment.cf_payment_id),
    gatewayOrderId: payment.order_id ?? orderId,
    status: paymentStatus(payment.payment_status),
    amount: money(payment.payment_amount),
    currency: payment.payment_currency ?? 'INR',
    method: payment.payment_group ?? null,
    failureReason: paymentStatus(payment.payment_status) === 'FAILED' ? (payment.payment_message ?? payment.payment_status) : null,
    raw: payment,
  };
}

export function createCashfreeAdapter(
  loadConfig: () => Promise<CashfreeConfig> = getEffectiveCashfreeConfig,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): GatewayAdapter {
  const host = (cfg: CashfreeConfig) => ((cfg.testMode ?? true) ? CASHFREE_SANDBOX_HOST : CASHFREE_LIVE_HOST);
  const headers = (cfg: CashfreeConfig) => ({
    'x-client-id': cfg.appId ?? '',
    'x-client-secret': cfg.secretKey ?? '',
    'x-api-version': API_VERSION,
    'Content-Type': 'application/json',
  });

  async function readiness(): Promise<GatewayReadiness> {
    const cfg = await loadConfig();
    const missing = (['appId', 'secretKey'] as const).filter((key) => !cfg[key]);
    return { configured: missing.length === 0, testMode: cfg.testMode ?? true, missing };
  }

  return {
    name: 'CASHFREE',
    readiness,

    async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
      const cfg = await loadConfig();
      const result = await gatewayFetch(fetchImpl, 'Cashfree', `${host(cfg)}/pg/orders`, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify({
          order_id: input.paymentId,
          order_amount: Number(input.amount),
          order_currency: input.currency,
          order_note: `${input.reference} — ${input.description}`.slice(0, 200),
          customer_details: {
            customer_id: input.customer.id,
            customer_name: input.customer.name,
            customer_phone: nationalNumber(input.customer.mobile) || '9999999999',
            ...(input.customer.email ? { customer_email: input.customer.email } : {}),
          },
          order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
          order_tags: { reference: input.reference },
        }),
      });
      if (result.status < 200 || result.status >= 300) throw gatewayError('Cashfree', result, 'Could not create the order');
      const order = result.json as { cf_order_id: string | number; order_id: string; payment_session_id: string };
      return {
        gatewayOrderId: order.order_id ?? input.paymentId,
        checkout: {
          paymentSessionId: order.payment_session_id,
          orderId: order.order_id ?? input.paymentId,
          cfOrderId: String(order.cf_order_id),
          environment: (cfg.testMode ?? true) ? 'sandbox' : 'production',
        },
      };
    },

    /** Cashfree's checkout has no client-side signature; the webhook or the order read is the confirmation. */
    async verifySignature(): Promise<boolean> {
      return false;
    },

    async fetchPayment(gatewayPaymentId: string, gatewayOrderId: string | null): Promise<FetchedPayment> {
      const cfg = await loadConfig();
      if (!gatewayOrderId) throw gatewayError('Cashfree', { status: 0, json: null, text: '' }, 'A Cashfree payment is read through its order');
      const result = await gatewayFetch(fetchImpl, 'Cashfree', `${host(cfg)}/pg/orders/${encodeURIComponent(gatewayOrderId)}/payments`, {
        method: 'GET',
        headers: headers(cfg),
      });
      if (result.status < 200 || result.status >= 300) throw gatewayError('Cashfree', result, 'Could not read the order');
      const payments = (Array.isArray(result.json) ? result.json : []) as CashfreePayment[];
      const wanted = payments.find((row) => String(row.cf_payment_id) === gatewayPaymentId) ?? payments.find((row) => row.payment_status === 'SUCCESS') ?? payments[0];
      if (!wanted) throw gatewayError('Cashfree', result, 'No payment on this order yet');
      return toFetched(wanted, gatewayOrderId);
    },

    async refund(input: RefundInput): Promise<RefundResult> {
      const cfg = await loadConfig();
      if (!input.gatewayOrderId) throw gatewayError('Cashfree', { status: 0, json: null, text: '' }, 'A Cashfree refund is raised against the order');
      const result = await gatewayFetch(fetchImpl, 'Cashfree', `${host(cfg)}/pg/orders/${encodeURIComponent(input.gatewayOrderId)}/refunds`, {
        method: 'POST',
        headers: headers(cfg),
        body: JSON.stringify({ refund_amount: Number(input.amount), refund_id: input.refundId, refund_note: input.note.slice(0, 100) }),
      });
      if (result.status < 200 || result.status >= 300) throw gatewayError('Cashfree', result, 'Could not refund the payment');
      const refund = result.json as CashfreeRefund;
      return { gatewayRefundId: String(refund.cf_refund_id), status: refundStatus(refund.refund_status), raw: refund };
    },

    async parseWebhook(request: WebhookRequest): Promise<ParsedWebhook> {
      const cfg = await loadConfig();
      const secret = cfg.webhookSecret || cfg.secretKey;
      if (!secret) return { ok: false, reason: 'NO_SECRET' };
      const signature = headerValue(request.headers, SIGNATURE_HEADER);
      const timestamp = headerValue(request.headers, TIMESTAMP_HEADER);
      if (!signature || !timestamp) return { ok: false, reason: 'NO_SIGNATURE' };
      if (!request.rawBody || request.rawBody.length === 0) return { ok: false, reason: 'NO_BODY' };

      const expected = crypto.createHmac('sha256', secret).update(timestamp + request.rawBody.toString('utf8')).digest('base64');
      const left = Buffer.from(expected, 'utf8');
      const right = Buffer.from(signature.trim(), 'utf8');
      if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return { ok: false, reason: 'MISMATCH' };

      const body = request.body as
        | { type?: string; data?: { order?: { order_id?: string }; payment?: CashfreePayment; refund?: CashfreeRefund } }
        | null;
      if (!body || typeof body.type !== 'string') return { ok: false, reason: 'UNPARSEABLE' };

      const orderId = body.data?.order?.order_id ?? body.data?.refund?.order_id ?? body.data?.payment?.order_id ?? null;
      const payment = body.data?.payment;
      const refund = body.data?.refund;
      const base: WebhookEvent = {
        eventId: `${body.type}:${refund?.cf_refund_id ?? payment?.cf_payment_id ?? orderId ?? 'unknown'}`,
        eventType: body.type,
        kind: 'IGNORED',
        gatewayOrderId: orderId,
        gatewayPaymentId: payment ? String(payment.cf_payment_id) : refund?.cf_payment_id ? String(refund.cf_payment_id) : null,
        gatewayRefundId: refund ? String(refund.cf_refund_id) : null,
        status: null,
        refundStatus: null,
        amount: null,
        method: null,
        failureReason: null,
      };

      if (body.type.startsWith('PAYMENT_') && payment) {
        const fetched = toFetched(payment, orderId);
        return {
          ok: true,
          payload: body,
          event: { ...base, kind: 'PAYMENT', status: fetched.status, amount: fetched.amount, method: fetched.method, failureReason: fetched.failureReason },
        };
      }
      if (body.type.startsWith('REFUND_') && refund) {
        return { ok: true, payload: body, event: { ...base, kind: 'REFUND', refundStatus: refundStatus(refund.refund_status), amount: money(refund.refund_amount) } };
      }
      return { ok: true, payload: body, event: base };
    },
  };
}
