import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCashfreeAdapter } from '../gateways/cashfree';

/**
 * The Cashfree PG adapter — the sandbox host in test mode, the order that
 * answers a payment_session_id, the timestamped webhook signature, refunds.
 */

const config = { appId: 'app_123', secretKey: 'cf_secret', testMode: true };

function fakeFetch(answer: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = answer(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return { fetchImpl, calls };
}

const order = {
  paymentId: 'pay_local_1',
  reference: 'PAY-2026-000482',
  amount: '34810.00',
  currency: 'INR',
  customer: { id: 'adv_1', name: 'Anita', email: 'anita@example.com', mobile: '+919999999999' },
  description: 'Campaign ADX-CMP-2026-482913',
  // E9: the API's own return page, under the intent's one-time return token — never a UI page.
  returnUrl: 'https://api.adx.local/api/v1/payments/pay_local_1/return?t=tok_return',
  notifyUrl: 'https://api.adx.local/api/v1/webhooks/cashfree',
};

describe('cashfree adapter', () => {
  it('answers not configured when the app id or secret is missing', async () => {
    const adapter = createCashfreeAdapter(async () => ({ testMode: true }), vi.fn());
    expect(await adapter.readiness()).toEqual({ configured: false, testMode: true, missing: ['appId', 'secretKey'] });
  });

  it('targets the sandbox host in test mode and the live host otherwise', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { cf_order_id: 'cf_1', order_id: 'pay_local_1', payment_session_id: 'session_abc' } }));
    await createCashfreeAdapter(async () => config, fetchImpl).createOrder(order);
    expect(calls[0]!.url).toBe('https://sandbox.cashfree.com/pg/orders');
    await createCashfreeAdapter(async () => ({ ...config, testMode: false }), fetchImpl).createOrder(order);
    expect(calls[1]!.url).toBe('https://api.cashfree.com/pg/orders');
  });

  it('creates the order in rupees with the client headers and hands the app the payment session id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { cf_order_id: 'cf_1', order_id: 'pay_local_1', payment_session_id: 'session_abc' } }));
    const result = await createCashfreeAdapter(async () => config, fetchImpl).createOrder(order);

    expect(result).toEqual({ gatewayOrderId: 'pay_local_1', checkout: { paymentSessionId: 'session_abc', orderId: 'pay_local_1', cfOrderId: 'cf_1', environment: 'sandbox' } });
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['x-client-id']).toBe('app_123');
    expect(headers['x-client-secret']).toBe('cf_secret');
    expect(headers['x-api-version']).toBe('2023-08-01');
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
      order_id: 'pay_local_1',
      order_amount: 34810,
      order_currency: 'INR',
      customer_details: { customer_id: 'adv_1', customer_phone: '9999999999' },
      order_meta: { return_url: 'https://api.adx.local/api/v1/payments/pay_local_1/return?t=tok_return', notify_url: 'https://api.adx.local/api/v1/webhooks/cashfree' },
    });
    // The return URL is the API return page for this payment, carrying the token.
    const returnUrl = new URL(JSON.parse(calls[0]!.init!.body as string).order_meta.return_url);
    expect(returnUrl.pathname).toBe('/api/v1/payments/pay_local_1/return');
    expect(returnUrl.searchParams.get('t')).toBe('tok_return');
  });

  it('reads the order\'s payments and reports the successful one', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: [
        { cf_payment_id: 111, order_id: 'pay_local_1', payment_status: 'FAILED', payment_amount: 34810, payment_currency: 'INR', payment_group: 'upi', payment_message: 'Declined' },
        { cf_payment_id: 222, order_id: 'pay_local_1', payment_status: 'SUCCESS', payment_amount: 34810, payment_currency: 'INR', payment_group: 'card' },
      ],
    }));
    const payment = await createCashfreeAdapter(async () => config, fetchImpl).fetchPayment('222', 'pay_local_1');
    expect(calls[0]!.url).toBe('https://sandbox.cashfree.com/pg/orders/pay_local_1/payments');
    expect(payment).toMatchObject({ gatewayPaymentId: '222', gatewayOrderId: 'pay_local_1', status: 'CAPTURED', amount: '34810.00', method: 'card' });
  });

  it('refunds against the order, keyed on our refund id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { cf_refund_id: 'cfr_1', refund_id: 'prf_1', refund_status: 'PENDING', refund_amount: 5000 } }));
    const result = await createCashfreeAdapter(async () => config, fetchImpl).refund({
      gatewayPaymentId: '222',
      gatewayOrderId: 'pay_local_1',
      amount: '5000.00',
      refundId: 'prf_1',
      note: 'Unused days',
    });
    expect(calls[0]!.url).toBe('https://sandbox.cashfree.com/pg/orders/pay_local_1/refunds');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ refund_amount: 5000, refund_id: 'prf_1', refund_note: 'Unused days' });
    expect(result).toMatchObject({ gatewayRefundId: 'cfr_1', status: 'PENDING' });
  });

  describe('webhook', () => {
    const success = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      event_time: '2026-09-12T10:00:00+05:30',
      data: {
        order: { order_id: 'pay_local_1', order_amount: 34810 },
        payment: { cf_payment_id: 222, payment_status: 'SUCCESS', payment_amount: 34810, payment_currency: 'INR', payment_group: 'upi', payment_method: { upi: { upi_id: 'x@upi' } } },
      },
    };
    const sign = (timestamp: string, body: Buffer, secret = 'cf_secret') =>
      crypto.createHmac('sha256', secret).update(timestamp + body.toString('utf8')).digest('base64');

    it('accepts a body signed as base64 HMAC-SHA256(timestamp + body, secret) and normalises the success', async () => {
      const adapter = createCashfreeAdapter(async () => config, vi.fn());
      const rawBody = Buffer.from(JSON.stringify(success));
      const parsed = await adapter.parseWebhook({
        rawBody,
        body: success,
        headers: { 'x-webhook-signature': sign('1757671200', rawBody), 'x-webhook-timestamp': '1757671200' },
      });
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.event).toMatchObject({
        eventId: 'PAYMENT_SUCCESS_WEBHOOK:222',
        kind: 'PAYMENT',
        gatewayOrderId: 'pay_local_1',
        gatewayPaymentId: '222',
        status: 'CAPTURED',
        amount: '34810.00',
        method: 'upi',
      });
    });

    it('prefers a dedicated webhook secret when one is set, and fails closed otherwise', async () => {
      const rawBody = Buffer.from(JSON.stringify(success));
      const withSecret = createCashfreeAdapter(async () => ({ ...config, webhookSecret: 'wh_only' }), vi.fn());
      expect(
        (await withSecret.parseWebhook({ rawBody, body: success, headers: { 'x-webhook-signature': sign('1', rawBody, 'wh_only'), 'x-webhook-timestamp': '1' } })).ok,
      ).toBe(true);
      expect(await withSecret.parseWebhook({ rawBody, body: success, headers: { 'x-webhook-signature': sign('1', rawBody), 'x-webhook-timestamp': '1' } })).toEqual({
        ok: false,
        reason: 'MISMATCH',
      });
      const adapter = createCashfreeAdapter(async () => config, vi.fn());
      expect(await adapter.parseWebhook({ rawBody, body: success, headers: {} })).toEqual({ ok: false, reason: 'NO_SIGNATURE' });
      expect(await createCashfreeAdapter(async () => ({ testMode: true }), vi.fn()).parseWebhook({ rawBody, body: success, headers: { 'x-webhook-signature': 'x', 'x-webhook-timestamp': '1' } })).toEqual({
        ok: false,
        reason: 'NO_SECRET',
      });
    });

    it('reads a failure and a drop as FAILED with the message, a refund with its status', async () => {
      const adapter = createCashfreeAdapter(async () => config, vi.fn());
      const send = async (body: unknown) => {
        const rawBody = Buffer.from(JSON.stringify(body));
        return adapter.parseWebhook({ rawBody, body, headers: { 'x-webhook-signature': sign('9', rawBody), 'x-webhook-timestamp': '9' } });
      };
      const failed = await send({
        type: 'PAYMENT_FAILED_WEBHOOK',
        data: { order: { order_id: 'pay_local_1' }, payment: { cf_payment_id: 333, payment_status: 'FAILED', payment_amount: 34810, payment_message: 'Bank declined' } },
      });
      expect(failed.ok && failed.event).toMatchObject({ kind: 'PAYMENT', status: 'FAILED', failureReason: 'Bank declined', gatewayPaymentId: '333' });

      const refund = await send({
        type: 'REFUND_STATUS_WEBHOOK',
        data: { refund: { cf_refund_id: 'cfr_1', refund_id: 'prf_1', cf_payment_id: 222, order_id: 'pay_local_1', refund_status: 'SUCCESS', refund_amount: 5000 } },
      });
      expect(refund.ok && refund.event).toMatchObject({ kind: 'REFUND', gatewayRefundId: 'cfr_1', gatewayPaymentId: '222', refundStatus: 'PROCESSED', amount: '5000.00' });
    });
  });
});
