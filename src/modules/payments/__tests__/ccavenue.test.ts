import { describe, expect, it, vi } from 'vitest';
import { ccavenueDecrypt, ccavenueEncrypt, createCcavenueAdapter } from '../gateways/ccavenue';

/**
 * The CCAvenue adapter: AES-128-CBC with MD5(working key) and the fixed IV
 * per their integration kit, the redirect flow's encRequest, the encResp
 * that comes back, and the status / refund API behind DoWebTrans.
 */

const config = { merchantId: '12345', accessCode: 'AVXX', workingKey: 'A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6', testMode: true };

const order = {
  paymentId: 'pay_local_1',
  reference: 'PAY-2026-000482',
  amount: '34810.00',
  currency: 'INR',
  customer: { id: 'adv_1', name: 'Anita', email: 'anita@example.com', mobile: '+919999999999' },
  description: 'Campaign ADX-CMP-2026-482913',
  // E9: the API's own return page, under the intent's one-time return token — never a UI page.
  returnUrl: 'https://api.adx.local/api/v1/payments/pay_local_1/return?t=tok_return',
  notifyUrl: 'https://api.adx.local/api/v1/webhooks/ccavenue',
};

/** The kit's own vector shape: encrypt then decrypt is the identity, and the ciphertext is hex. */
describe('ccavenue crypto', () => {
  it('round-trips under the working key and produces hex', () => {
    const cipher = ccavenueEncrypt('merchant_id=12345&order_id=pay_local_1&amount=34810.00', config.workingKey);
    expect(cipher).toMatch(/^[0-9a-f]+$/);
    expect(ccavenueDecrypt(cipher, config.workingKey)).toBe('merchant_id=12345&order_id=pay_local_1&amount=34810.00');
  });

  it('is deterministic — the fixed IV means the same plaintext encrypts the same way', () => {
    expect(ccavenueEncrypt('a=1', config.workingKey)).toBe(ccavenueEncrypt('a=1', config.workingKey));
    expect(ccavenueEncrypt('a=1', config.workingKey)).not.toBe(ccavenueEncrypt('a=1', 'another-working-key'));
  });

  it('refuses ciphertext under the wrong key', () => {
    const cipher = ccavenueEncrypt('order_id=pay_local_1', config.workingKey);
    expect(() => ccavenueDecrypt(cipher, 'ffffffffffffffffffffffffffffffff')).toThrow();
  });
});

describe('ccavenue adapter', () => {
  it('answers not configured when the merchant id, access code or working key is missing', async () => {
    const adapter = createCcavenueAdapter(async () => ({ merchantId: '12345', testMode: true }), vi.fn());
    expect(await adapter.readiness()).toEqual({ configured: false, testMode: true, missing: ['accessCode', 'workingKey'] });
  });

  it('builds the encrypted request for the redirect flow — no network call', async () => {
    const fetchImpl = vi.fn();
    const adapter = createCcavenueAdapter(async () => config, fetchImpl);
    const result = await adapter.createOrder(order);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.gatewayOrderId).toBe('pay_local_1');
    expect(result.checkout).toMatchObject({
      accessCode: 'AVXX',
      redirectUrl: 'https://test.ccavenue.com/transaction/transaction.do?command=initiateTransaction',
      returnUrl: 'https://api.adx.local/api/v1/payments/pay_local_1/return?t=tok_return',
    });
    // The page the app is handed for afterwards is the API return page for this payment, carrying the token.
    const returnUrl = new URL(result.checkout['returnUrl'] as string);
    expect(returnUrl.pathname).toBe('/api/v1/payments/pay_local_1/return');
    expect(returnUrl.searchParams.get('t')).toBe('tok_return');
    const plain = ccavenueDecrypt(result.checkout['encRequest'] as string, config.workingKey);
    const fields = Object.fromEntries(new URLSearchParams(plain));
    expect(fields).toMatchObject({
      merchant_id: '12345',
      order_id: 'pay_local_1',
      currency: 'INR',
      amount: '34810.00',
      redirect_url: 'https://api.adx.local/api/v1/webhooks/ccavenue',
      cancel_url: 'https://api.adx.local/api/v1/webhooks/ccavenue',
      billing_name: 'Anita',
      merchant_param1: 'PAY-2026-000482',
    });
  });

  it('points at the live host when test mode is off', async () => {
    const adapter = createCcavenueAdapter(async () => ({ ...config, testMode: false }), vi.fn());
    const result = await adapter.createOrder(order);
    expect(result.checkout['redirectUrl']).toBe('https://secure.ccavenue.com/transaction/transaction.do?command=initiateTransaction');
  });

  it('verifies a returned encResp: it decrypts under our key and names our order and tracking id', async () => {
    const adapter = createCcavenueAdapter(async () => config, vi.fn());
    const encResp = ccavenueEncrypt('order_id=pay_local_1&tracking_id=3130&order_status=Success&amount=34810.00&payment_mode=Net Banking', config.workingKey);
    expect(await adapter.verifySignature({ gatewayOrderId: 'pay_local_1', gatewayPaymentId: '3130', signature: encResp })).toBe(true);
    expect(await adapter.verifySignature({ gatewayOrderId: 'pay_local_1', gatewayPaymentId: '9999', signature: encResp })).toBe(false);
    expect(await adapter.verifySignature({ gatewayOrderId: 'pay_local_1', gatewayPaymentId: '3130', signature: 'deadbeef' })).toBe(false);
  });

  it('reads the order status through DoWebTrans, decrypting the JSON answer', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const enc = ccavenueEncrypt(
        JSON.stringify({ order_no: 'pay_local_1', reference_no: '3130', order_status: 'Successful', order_amt: 34810.0, order_card_name: 'Net Banking', order_fail_message: '' }),
        config.workingKey,
      );
      return new Response(`status=0&enc_response=${enc}`, { status: 200 });
    });
    const adapter = createCcavenueAdapter(async () => config, fetchImpl);

    const payment = await adapter.fetchPayment('3130', 'pay_local_1');

    expect(calls[0]!.url).toBe('https://apitest.ccavenue.com/apis/servlet/DoWebTrans');
    const form = new URLSearchParams(calls[0]!.init!.body as string);
    expect(form.get('command')).toBe('orderStatusTracker');
    expect(form.get('access_code')).toBe('AVXX');
    expect(JSON.parse(ccavenueDecrypt(form.get('enc_request')!, config.workingKey))).toEqual({ order_no: 'pay_local_1', reference_no: '3130' });
    expect(payment).toMatchObject({ gatewayPaymentId: '3130', gatewayOrderId: 'pay_local_1', status: 'CAPTURED', amount: '34810.00', method: 'Net Banking' });
  });

  it('refunds through DoWebTrans and reads the refund status back', async () => {
    const fetchImpl = vi.fn(async () => {
      const enc = ccavenueEncrypt(JSON.stringify({ refund_status: 0, reason: '' }), config.workingKey);
      return new Response(`status=0&enc_response=${enc}`, { status: 200 });
    });
    const adapter = createCcavenueAdapter(async () => config, fetchImpl);
    const result = await adapter.refund({ gatewayPaymentId: '3130', gatewayOrderId: 'pay_local_1', amount: '5000.00', refundId: 'prf_1', note: 'Unused days' });
    expect(result).toMatchObject({ gatewayRefundId: 'prf_1', status: 'PROCESSED' });
    const form = new URLSearchParams((fetchImpl.mock.calls[0] as unknown[])[1] as string | undefined ? ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body as string : '');
    expect(form.get('command')).toBe('refundOrder');
    expect(JSON.parse(ccavenueDecrypt(form.get('enc_request')!, config.workingKey))).toEqual({ reference_no: '3130', refund_amount: '5000.00', refund_ref_no: 'prf_1' });
  });

  it('reports a refund the gateway refused as FAILED with its reason', async () => {
    const fetchImpl = vi.fn(async () => {
      const enc = ccavenueEncrypt(JSON.stringify({ refund_status: 1, reason: 'Refund amount exceeds the order amount' }), config.workingKey);
      return new Response(`status=0&enc_response=${enc}`, { status: 200 });
    });
    const adapter = createCcavenueAdapter(async () => config, fetchImpl);
    const result = await adapter.refund({ gatewayPaymentId: '3130', gatewayOrderId: 'pay_local_1', amount: '99999.00', refundId: 'prf_2', note: 'x' });
    expect(result.status).toBe('FAILED');
  });

  describe('the encResp callback', () => {
    it('is accepted when it decrypts under the working key, and normalised', async () => {
      const adapter = createCcavenueAdapter(async () => config, vi.fn());
      const encResp = ccavenueEncrypt(
        'order_id=pay_local_1&tracking_id=3130&bank_ref_no=UTR1&order_status=Success&failure_message=&payment_mode=Net Banking&amount=34810.00&currency=INR',
        config.workingKey,
      );
      const parsed = await adapter.parseWebhook({ rawBody: undefined, body: { encResp, orderNo: 'pay_local_1' }, headers: {} });
      expect(parsed.ok && parsed.event).toMatchObject({
        eventId: 'pay_local_1:3130:Success',
        kind: 'PAYMENT',
        gatewayOrderId: 'pay_local_1',
        gatewayPaymentId: '3130',
        status: 'CAPTURED',
        amount: '34810.00',
        method: 'Net Banking',
      });
    });

    it('reads Failure and Aborted as FAILED with the message', async () => {
      const adapter = createCcavenueAdapter(async () => config, vi.fn());
      const encResp = ccavenueEncrypt('order_id=pay_local_1&tracking_id=3131&order_status=Aborted&failure_message=Customer cancelled&amount=34810.00', config.workingKey);
      const parsed = await adapter.parseWebhook({ rawBody: undefined, body: { encResp }, headers: {} });
      expect(parsed.ok && parsed.event).toMatchObject({ kind: 'PAYMENT', status: 'FAILED', failureReason: 'Customer cancelled' });
    });

    it('fails closed: no working key, no encResp, or a body that does not decrypt', async () => {
      const unconfigured = createCcavenueAdapter(async () => ({ merchantId: '1', accessCode: 'x', testMode: true }), vi.fn());
      expect(await unconfigured.parseWebhook({ rawBody: undefined, body: { encResp: 'abcd' }, headers: {} })).toEqual({ ok: false, reason: 'NO_SECRET' });
      const adapter = createCcavenueAdapter(async () => config, vi.fn());
      expect(await adapter.parseWebhook({ rawBody: undefined, body: {}, headers: {} })).toEqual({ ok: false, reason: 'NO_SIGNATURE' });
      const forged = ccavenueEncrypt('order_id=pay_local_1&tracking_id=1&order_status=Success', 'ffffffffffffffffffffffffffffffff');
      expect(await adapter.parseWebhook({ rawBody: undefined, body: { encResp: forged }, headers: {} })).toEqual({ ok: false, reason: 'MISMATCH' });
    });
  });
});
