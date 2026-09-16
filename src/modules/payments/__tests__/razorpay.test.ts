import crypto from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { createRazorpayAdapter } from '../gateways/razorpay';

/**
 * The Razorpay adapter, against recorded fixtures and signature vectors.
 *
 * Nothing here reaches the network: `fetch` is a stub that records what the
 * adapter sent and answers with what Razorpay's docs say it answers.
 */

const config = { keyId: 'rzp_test_abc', keySecret: 'secret_xyz', webhookSecret: 'whsec_123', testMode: true };

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
  returnUrl: 'https://app.adx.local/pay/return',
  notifyUrl: 'https://api.adx.local/api/v1/webhooks/razorpay',
};

describe('razorpay adapter', () => {
  it('answers not configured, naming the empty fields, when keys are missing', async () => {
    const adapter = createRazorpayAdapter(async () => ({ keyId: 'rzp_test_abc' }), vi.fn());
    expect(await adapter.readiness()).toEqual({ configured: false, testMode: true, missing: ['keySecret', 'webhookSecret'] });
  });

  it('creates an order in paise with Basic auth and hands the app the order id and key id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { id: 'order_ABC', amount: 3481000, currency: 'INR', receipt: 'pay_local_1' } }));
    const adapter = createRazorpayAdapter(async () => config, fetchImpl);

    const result = await adapter.createOrder(order);

    expect(result.gatewayOrderId).toBe('order_ABC');
    expect(result.checkout).toEqual({ orderId: 'order_ABC', keyId: 'rzp_test_abc', amount: 3481000, currency: 'INR' });
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/orders');
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Basic ${Buffer.from('rzp_test_abc:secret_xyz').toString('base64')}`);
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ amount: 3481000, currency: 'INR', receipt: 'pay_local_1' });
  });

  it('turns a gateway error into GATEWAY_FAILED in the gateway\'s own words', async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 400,
      body: { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be at least INR 1.00' } },
    }));
    const adapter = createRazorpayAdapter(async () => config, fetchImpl);
    await expect(adapter.createOrder(order)).rejects.toMatchObject({
      statusCode: 502,
      code: 'GATEWAY_FAILED',
      message: 'Razorpay: BAD_REQUEST_ERROR: The amount must be at least INR 1.00',
    });
  });

  it('verifies the checkout signature — HMAC-SHA256 of order_id|payment_id — and refuses a forgery', async () => {
    const adapter = createRazorpayAdapter(async () => config, vi.fn());
    const signature = crypto.createHmac('sha256', 'secret_xyz').update('order_ABC|pay_XYZ').digest('hex');

    expect(await adapter.verifySignature({ gatewayOrderId: 'order_ABC', gatewayPaymentId: 'pay_XYZ', signature })).toBe(true);
    expect(await adapter.verifySignature({ gatewayOrderId: 'order_ABC', gatewayPaymentId: 'pay_XYZ', signature: signature.toUpperCase() })).toBe(true);
    expect(await adapter.verifySignature({ gatewayOrderId: 'order_ABC', gatewayPaymentId: 'pay_OTHER', signature })).toBe(false);
    expect(await adapter.verifySignature({ gatewayOrderId: 'order_ABC', gatewayPaymentId: 'pay_XYZ', signature: 'nope' })).toBe(false);
  });

  it('reads a payment back with its status, method and amount in rupees', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      status: 200,
      body: { id: 'pay_XYZ', order_id: 'order_ABC', status: 'captured', amount: 3481000, currency: 'INR', method: 'upi', error_description: null },
    }));
    const adapter = createRazorpayAdapter(async () => config, fetchImpl);

    const payment = await adapter.fetchPayment('pay_XYZ', 'order_ABC');
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/payments/pay_XYZ');
    expect(payment).toMatchObject({ gatewayPaymentId: 'pay_XYZ', gatewayOrderId: 'order_ABC', status: 'CAPTURED', amount: '34810.00', method: 'upi' });
  });

  it('captures an authorised payment for the amount', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { id: 'pay_XYZ', order_id: 'order_ABC', status: 'captured', amount: 3481000, currency: 'INR', method: 'card' } }));
    const adapter = createRazorpayAdapter(async () => config, fetchImpl);

    const captured = await adapter.capture!({ gatewayPaymentId: 'pay_XYZ', amount: '34810.00', currency: 'INR' });
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/payments/pay_XYZ/capture');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ amount: 3481000, currency: 'INR' });
    expect(captured.status).toBe('CAPTURED');
  });

  it('refunds through the refunds API, keyed on our refund id, and reports the gateway status', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { id: 'rfnd_1', payment_id: 'pay_XYZ', amount: 500000, status: 'processed' } }));
    const adapter = createRazorpayAdapter(async () => config, fetchImpl);

    const result = await adapter.refund({ gatewayPaymentId: 'pay_XYZ', gatewayOrderId: 'order_ABC', amount: '5000.00', refundId: 'prf_1', note: 'Unused days' });
    expect(calls[0]!.url).toBe('https://api.razorpay.com/v1/payments/pay_XYZ/refund');
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({ amount: 500000, receipt: 'prf_1' });
    expect(result).toMatchObject({ gatewayRefundId: 'rfnd_1', status: 'PROCESSED' });
  });

  describe('webhook', () => {
    const captured = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_XYZ', order_id: 'order_ABC', status: 'captured', amount: 3481000, currency: 'INR', method: 'upi' } } },
    };
    const sign = (body: Buffer, secret = 'whsec_123') => crypto.createHmac('sha256', secret).update(body).digest('hex');

    it('accepts a body signed with the webhook secret and normalises the capture', async () => {
      const adapter = createRazorpayAdapter(async () => config, vi.fn());
      const rawBody = Buffer.from(JSON.stringify(captured));
      const parsed = await adapter.parseWebhook({
        rawBody,
        body: captured,
        headers: { 'x-razorpay-signature': sign(rawBody), 'x-razorpay-event-id': 'evt_1' },
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.event).toMatchObject({
        eventId: 'evt_1',
        eventType: 'payment.captured',
        kind: 'PAYMENT',
        gatewayOrderId: 'order_ABC',
        gatewayPaymentId: 'pay_XYZ',
        status: 'CAPTURED',
        amount: '34810.00',
        method: 'upi',
      });
    });

    it('fails closed: no secret, no signature, a wrong secret', async () => {
      const rawBody = Buffer.from(JSON.stringify(captured));
      const headers = { 'x-razorpay-signature': sign(rawBody, 'other'), 'x-razorpay-event-id': 'evt_1' };

      const unconfigured = createRazorpayAdapter(async () => ({ ...config, webhookSecret: undefined }), vi.fn());
      expect(await unconfigured.parseWebhook({ rawBody, body: captured, headers })).toEqual({ ok: false, reason: 'NO_SECRET' });

      const adapter = createRazorpayAdapter(async () => config, vi.fn());
      expect(await adapter.parseWebhook({ rawBody, body: captured, headers: { 'x-razorpay-event-id': 'evt_1' } })).toEqual({ ok: false, reason: 'NO_SIGNATURE' });
      expect(await adapter.parseWebhook({ rawBody, body: captured, headers })).toEqual({ ok: false, reason: 'MISMATCH' });
    });

    it('reads a failure with its reason, a refund with its status, and marks anything else IGNORED', async () => {
      const adapter = createRazorpayAdapter(async () => config, vi.fn());
      const send = async (body: unknown, eventId: string) => {
        const rawBody = Buffer.from(JSON.stringify(body));
        return adapter.parseWebhook({ rawBody, body, headers: { 'x-razorpay-signature': sign(rawBody), 'x-razorpay-event-id': eventId } });
      };

      const failed = await send(
        { event: 'payment.failed', payload: { payment: { entity: { id: 'pay_F', order_id: 'order_ABC', status: 'failed', amount: 3481000, currency: 'INR', method: 'card', error_description: 'Card declined' } } } },
        'evt_2',
      );
      expect(failed.ok && failed.event).toMatchObject({ kind: 'PAYMENT', status: 'FAILED', failureReason: 'Card declined' });

      const refunded = await send(
        { event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_1', payment_id: 'pay_XYZ', amount: 500000, status: 'processed' } } } },
        'evt_3',
      );
      expect(refunded.ok && refunded.event).toMatchObject({ kind: 'REFUND', gatewayRefundId: 'rfnd_1', gatewayPaymentId: 'pay_XYZ', refundStatus: 'PROCESSED', amount: '5000.00' });

      const other = await send({ event: 'order.paid', payload: { order: { entity: { id: 'order_ABC' } } } }, 'evt_4');
      expect(other.ok && other.event).toMatchObject({ kind: 'IGNORED', eventType: 'order.paid', gatewayOrderId: 'order_ABC' });
    });

    it('derives an event id from the body when the header is absent, so a retry is still one event', async () => {
      const adapter = createRazorpayAdapter(async () => config, vi.fn());
      const rawBody = Buffer.from(JSON.stringify(captured));
      const parsed = await adapter.parseWebhook({ rawBody, body: captured, headers: { 'x-razorpay-signature': sign(rawBody) } });
      expect(parsed.ok && parsed.event.eventId).toBe('payment.captured:pay_XYZ');
    });
  });
});
