import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * E7-2 — the browser pages the phones' Razorpay flow rides on.
 *
 * `react-native-razorpay` is not installed, so the app opens
 * `GET /payments/:id/checkout?t=` in the system browser. What is pinned:
 * the token opens the door once and only for its own payment; the page is
 * self-contained but for Razorpay's `checkout.js`, carries the order, the
 * key, the amount in paise and the prefill in a JSON block the inline
 * script reads, mints its own confirm token and a retry link, and is served
 * under a Content-Security-Policy; a settled or failed payment gets the
 * plain page; and `GET /payments/:id/return` says Paid / Failed / Still
 * processing from the row alone, with no secret on it.
 */

const { store, redis, repository, advertisers, publishers, revenue, integrations } = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    },
    repository: { findPayment: vi.fn() },
    advertisers: { getAdvertiser: vi.fn() },
    // Lot J (B2): a publisher's plan payment — the name on the page and the plan line.
    publishers: { findPublisherContact: vi.fn() },
    revenue: { findSubscriptionOrder: vi.fn() },
    integrations: { getEffectiveRazorpayConfig: vi.fn() },
  };
});

vi.mock('../../../shared/cache', () => ({ redis }));
vi.mock('../prisma-payments.repository', () => ({ prismaPaymentsRepository: repository }));
vi.mock('../../advertisers', () => advertisers);
vi.mock('../../publishers', () => publishers);
vi.mock('../../revenue', () => revenue);
vi.mock('../../../shared/integrations', () => integrations);

import { CHECKOUT_TOKEN_TTL_SECONDS, consumeCheckoutToken, mintCheckoutToken } from '../checkout-tokens';
import { checkoutPage, checkoutUrlFor, renderCheckoutPage, returnPage, returnRedirectUrlFor, returnUrlFor } from '../checkout-page.service';
import { confirmSchema } from '../payments.schema';

const NOW = new Date('2026-09-12T10:00:00Z');

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay_1',
  reference: 'PAY-2026-000482',
  advertiserId: 'adv_1',
  publisherId: null,
  campaignId: 'cmp_1',
  packageSaleId: null,
  subscriptionOrderId: null,
  gateway: 'RAZORPAY',
  gatewayOrderId: 'order_ABC',
  gatewayPaymentId: null,
  amount: new Decimal('34810.00'),
  currency: 'INR',
  method: null,
  status: 'CREATED',
  failureReason: null,
  topUpId: null,
  walletEntryId: null,
  ledgerTransactionId: null,
  invoiceId: null,
  createdByUserId: 'usr_owner',
  createdAt: NOW,
  capturedAt: null,
  updatedAt: NOW,
  refunds: [] as unknown[],
  ...over,
});

/** The JSON block the page's script reads. */
function pageData(html: string): Record<string, any> {
  const match = html.match(/<script id="adx-checkout" type="application\/json">(.*?)<\/script>/s);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

const nonceOf = (csp: string): string => csp.match(/script-src 'nonce-([^']+)'/)![1]!;

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  repository.findPayment.mockResolvedValue(payment());
  advertisers.getAdvertiser.mockResolvedValue({ id: 'adv_1', name: 'Anita', companyName: "Anita's <Coffee>", email: 'a@x.com', mobile: '+919999999999', userId: 'usr_owner' });
  integrations.getEffectiveRazorpayConfig.mockResolvedValue({ keyId: 'rzp_test_abc', keySecret: 's', webhookSecret: 'w', testMode: true });
  publishers.findPublisherContact.mockResolvedValue({ id: 'pub_1', userId: 'usr_pub', name: 'Sharma Stores', email: 'p@x.com', mobile: '+918888888888' });
  revenue.findSubscriptionOrder.mockResolvedValue({ id: 'ord_1', reference: 'SUB-2026-000123', publisherId: 'pub_1', planName: 'Plus', tier: 'PLUS', status: 'PENDING_PAYMENT', publisher: { id: 'pub_1', name: 'Sharma Stores', userId: 'usr_pub', displayId: 'PUB-1' } });
});

/** Lot J (B2): the publisher's payment for a plan order. */
const subscriptionPayment = (over: Record<string, unknown> = {}) =>
  payment({ advertiserId: null, publisherId: 'pub_1', campaignId: null, subscriptionOrderId: 'ord_1', amount: new Decimal('2948.82'), createdByUserId: 'usr_pub', ...over });

describe('the one-time tokens', () => {
  it('live twenty minutes, spend once, and open only the payment they were minted for', async () => {
    const token = await mintCheckoutToken('checkout', 'pay_1');
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining('payments:checkout-token:pay_1:'), '1', 'EX', CHECKOUT_TOKEN_TTL_SECONDS);
    expect(CHECKOUT_TOKEN_TTL_SECONDS).toBe(20 * 60);
    // Only the hash is stored.
    expect([...store.keys()][0]).not.toContain(token);

    expect(await consumeCheckoutToken('checkout', 'pay_2', token)).toBe(false);
    expect(await consumeCheckoutToken('confirm', 'pay_1', token)).toBe(false);
    expect(await consumeCheckoutToken('checkout', 'pay_1', token)).toBe(true);
    expect(await consumeCheckoutToken('checkout', 'pay_1', token)).toBe(false);
    expect(await consumeCheckoutToken('checkout', 'pay_1', undefined)).toBe(false);
  });

  it('is the door in the checkout URL the intent hands the app', () => {
    expect(checkoutUrlFor('pay_1', 'tok/en')).toMatch(/\/api\/v1\/payments\/pay_1\/checkout\?t=tok%2Fen$/);
    expect(returnUrlFor('pay_1')).toMatch(/\/api\/v1\/payments\/pay_1\/return$/);
  });
});

describe('GET /payments/:id/checkout', () => {
  it('refuses a spent, unknown or foreign token with a plain 401 page, before reading the payment', async () => {
    const page = await checkoutPage('pay_1', 'nope');
    expect(page.status).toBe(401);
    expect(page.html).toContain('This payment link has expired');
    expect(page.html).not.toContain('checkout.razorpay.com');
    expect(repository.findPayment).not.toHaveBeenCalled();
  });

  it('opens Razorpay Checkout with the order, key, amount in paise and the prefill, under a CSP', async () => {
    const token = await mintCheckoutToken('checkout', 'pay_1');
    const page = await checkoutPage('pay_1', token);

    expect(page.status).toBe(200);
    // The only external asset.
    expect(page.html.match(/<script src="([^"]+)"/g)).toEqual(['<script src="https://checkout.razorpay.com/v1/checkout.js"']);
    expect(page.html).not.toMatch(/<link /);
    const data = pageData(page.html);
    expect(data).toMatchObject({
      paymentId: 'pay_1',
      orderId: 'order_ABC',
      keyId: 'rzp_test_abc',
      amount: 3481000,
      currency: 'INR',
      amountLabel: '34810.00',
      prefill: { name: "Anita's <Coffee>", email: 'a@x.com', contact: '+919999999999' },
      theme: { color: expect.stringMatching(/^#/) },
      testMode: true,
    });
    expect(data.confirmUrl).toMatch(/\/api\/v1\/payments\/pay_1\/confirm$/);
    // The page's own confirm token, minted and live.
    expect(await consumeCheckoutToken('confirm', 'pay_1', data.confirmToken)).toBe(true);
    // A fresh checkout token behind the retry link — the one in the URL is spent.
    const retryToken = new URL(data.retryUrl).searchParams.get('t')!;
    expect(retryToken).not.toBe(token);
    expect(await consumeCheckoutToken('checkout', 'pay_1', retryToken)).toBe(true);
    expect(await consumeCheckoutToken('checkout', 'pay_1', token)).toBe(false);
    // Nothing secret on the page.
    expect(page.html).not.toContain('keySecret');
    expect(page.html).not.toContain('webhookSecret');

    // The policy: the page's own script and style by nonce, Razorpay's hosts, the confirm to self.
    const nonce = nonceOf(page.csp);
    expect(page.csp).toContain("default-src 'none'");
    expect(page.csp).toContain(`script-src 'nonce-${nonce}' https://checkout.razorpay.com`);
    expect(page.csp).toContain("connect-src 'self' https://api.razorpay.com");
    expect(page.csp).toContain('frame-src https://api.razorpay.com https://checkout.razorpay.com');
    expect(page.csp).toContain("frame-ancestors 'none'");
    expect(page.html).toContain(`<script nonce="${nonce}">`);
    expect(page.html).toContain(`<style nonce="${nonce}">`);
    // The handler posts Razorpay's own field names plus the confirm token.
    expect(page.html).toContain('razorpay_payment_id: response.razorpay_payment_id');
    expect(page.html).toContain('razorpay_order_id: response.razorpay_order_id');
    expect(page.html).toContain('razorpay_signature: response.razorpay_signature');
    expect(page.html).toContain('checkoutToken: cfg.confirmToken');
    expect(page.html).toContain('Return to the ADX app');
    expect(page.html).toContain('Test mode');
  });

  it("Lot J (B2): prints the publisher's name and the plan line for a subscription payment, and never asks advertisers", async () => {
    repository.findPayment.mockResolvedValue(subscriptionPayment());
    const page = await checkoutPage('pay_1', await mintCheckoutToken('checkout', 'pay_1'));
    expect(page.status).toBe(200);
    const data = pageData(page.html);
    expect(data).toMatchObject({
      paymentId: 'pay_1',
      amount: 294882,
      amountLabel: '2948.82',
      description: 'Plus plan — SUB-2026-000123',
      prefill: { name: 'Sharma Stores', email: 'p@x.com', contact: '+918888888888' },
    });
    expect(page.html).toContain('Plus plan — SUB-2026-000123');
    expect(page.html).toContain('Sharma Stores');
    expect(publishers.findPublisherContact).toHaveBeenCalledWith('pub_1');
    expect(revenue.findSubscriptionOrder).toHaveBeenCalledWith('ord_1');
    expect(advertisers.getAdvertiser).not.toHaveBeenCalled();
    // The confirm token and the retry link work as they do for an advertiser.
    expect(await consumeCheckoutToken('confirm', 'pay_1', data.confirmToken)).toBe(true);
    expect(new URL(data.retryUrl).searchParams.get('t')).toBeTruthy();
  });

  it('Lot J (B2): a settled subscription payment gets the plain page naming the subscription', async () => {
    repository.findPayment.mockResolvedValue(subscriptionPayment({ status: 'CAPTURED', gatewayPaymentId: 'pay_XYZ' }));
    const page = await checkoutPage('pay_1', await mintCheckoutToken('checkout', 'pay_1'));
    expect(page.html).toContain('<h1 class="ok">Paid</h1>');
    expect(page.html).toContain('your subscription is being activated');
    expect(page.html).not.toContain('checkout.razorpay.com');
    // The return page says the same, and works unchanged under its token.
    const token = await mintCheckoutToken('return', 'pay_1');
    const back = await returnPage('pay_1', token);
    expect(back.html).toContain('Paid');
    expect(back.html).toContain('PAY-2026-000482');
    expect(back.html).toContain('2948.82');
    expect(back.html).toContain('your subscription is being activated');
    expect((await returnPage('pay_1')).html).not.toContain('PAY-2026-000482');
  });

  it('reads test mode off the key prefix, not the console flag', async () => {
    integrations.getEffectiveRazorpayConfig.mockResolvedValue({ keyId: 'rzp_live_abc', keySecret: 's', webhookSecret: 'w', testMode: true });
    const page = await checkoutPage('pay_1', await mintCheckoutToken('checkout', 'pay_1'));
    expect(pageData(page.html).testMode).toBe(false);
    expect(page.html).not.toContain('Test mode');
  });

  it('answers the plain page for a payment already settled, failed, or not Razorpay', async () => {
    repository.findPayment.mockResolvedValue(payment({ status: 'CAPTURED' }));
    let page = await checkoutPage('pay_1', await mintCheckoutToken('checkout', 'pay_1'));
    expect(page.status).toBe(200);
    expect(page.html).toContain('<h1 class="ok">Paid</h1>');
    expect(page.html).not.toContain('checkout.razorpay.com');

    repository.findPayment.mockResolvedValue(payment({ status: 'FAILED', failureReason: 'Card declined' }));
    page = await checkoutPage('pay_1', await mintCheckoutToken('checkout', 'pay_1'));
    expect(page.html).toContain('Payment failed');
    expect(page.html).toContain('Card declined');

    repository.findPayment.mockResolvedValue(payment({ gateway: 'CASHFREE' }));
    page = await checkoutPage('pay_1', await mintCheckoutToken('checkout', 'pay_1'));
    expect(page.status).toBe(409);

    repository.findPayment.mockResolvedValue(null);
    page = await checkoutPage('pay_1', await mintCheckoutToken('checkout', 'pay_1'));
    expect(page.status).toBe(404);
  });

  it('cannot be broken out of by a company name — the JSON block escapes the script terminator and the HTML is escaped', () => {
    const { html } = renderCheckoutPage({
      paymentId: 'pay_1',
      reference: 'PAY-1',
      description: 'Campaign booking',
      keyId: 'rzp_test_x',
      orderId: 'order_1',
      amount: 100,
      currency: 'INR',
      amountLabel: '1.00',
      prefill: { name: '</script><script>alert(1)</script>', email: '', contact: '' },
      theme: { color: '#000' },
      testMode: true,
      confirmUrl: 'http://x/confirm',
      confirmToken: 'ct',
      retryUrl: 'http://x/retry?t="><b>',
    });
    expect(html).not.toContain('</script><script>alert');
    expect(pageData(html).prefill.name).toBe('</script><script>alert(1)</script>');
    expect(html).toContain('href="http://x/retry?t=&quot;&gt;&lt;b&gt;"');
  });
});

describe('GET /payments/:id/return', () => {
  /* E9 (the E7 verifier): a bare payment id is a guessable URL, so it prints
     only the status word. The reference, the amount and the gateway's
     failure text appear only under the intent's one-time return token. */
  it('prints only the status word to a bare payment id', async () => {
    repository.findPayment.mockResolvedValue(payment({ status: 'CAPTURED', gatewayPaymentId: 'pay_XYZ' }));
    let page = await returnPage('pay_1');
    expect(page.status).toBe(200);
    expect(page.html).toContain('Paid');
    expect(page.html).not.toContain('PAY-2026-000482');
    expect(page.html).not.toContain('34810');
    expect(page.html).not.toContain('pay_XYZ');
    expect(page.html).not.toContain('<script');
    expect(page.csp).toContain("default-src 'none'");
    expect(page.csp).not.toContain('razorpay');

    repository.findPayment.mockResolvedValue(payment({ status: 'FAILED', failureReason: 'Bank declined' }));
    page = await returnPage('pay_1');
    expect(page.html).toContain('Payment failed');
    expect(page.html).not.toContain('Bank declined');
    expect(page.html).not.toContain('PAY-2026-000482');

    repository.findPayment.mockResolvedValue(payment({ status: 'AUTHORIZED' }));
    page = await returnPage('pay_1');
    expect(page.html).toContain('Still processing');
    expect(page.html).toContain('the app updates itself'.replace('the app', 'it'));
    expect(page.html).not.toContain('PAY-2026-000482');

    repository.findPayment.mockResolvedValue(null);
    expect((await returnPage('pay_x')).status).toBe(404);
  });

  it('prints the reference, the amount and the failure text under the return token — once, and only for its own payment', async () => {
    repository.findPayment.mockResolvedValue(payment({ status: 'CAPTURED' }));
    let token = await mintCheckoutToken('return', 'pay_1');
    let page = await returnPage('pay_1', token);
    expect(page.html).toContain('Paid');
    expect(page.html).toContain('PAY-2026-000482');
    expect(page.html).toContain('34810.00');
    // Spent: the same link reloaded shows the status word alone.
    page = await returnPage('pay_1', token);
    expect(page.html).not.toContain('PAY-2026-000482');

    repository.findPayment.mockResolvedValue(payment({ status: 'FAILED', failureReason: 'Bank declined' }));
    token = await mintCheckoutToken('return', 'pay_1');
    page = await returnPage('pay_1', token);
    expect(page.html).toContain('Payment failed');
    expect(page.html).toContain('Bank declined');

    // A token minted for another payment, or a spent checkout token, opens nothing.
    const foreign = await mintCheckoutToken('return', 'pay_2');
    expect((await returnPage('pay_1', foreign)).html).not.toContain('Bank declined');
    const wrongKind = await mintCheckoutToken('checkout', 'pay_1');
    expect((await returnPage('pay_1', wrongKind)).html).not.toContain('Bank declined');
  });

  it('is the target every gateway is given, carrying the token; the CCAvenue browser redirect mints one of its own', async () => {
    expect(returnUrlFor('pay_1')).toMatch(/\/api\/v1\/payments\/pay_1\/return$/);
    expect(returnUrlFor('pay_1', 'tok_r')).toMatch(/\/api\/v1\/payments\/pay_1\/return\?t=tok_r$/);
    const redirect = new URL(await returnRedirectUrlFor('pay_1', 'captured'));
    expect(redirect.pathname).toBe('/api/v1/payments/pay_1/return');
    expect(redirect.searchParams.get('status')).toBe('captured');
    const t = redirect.searchParams.get('t');
    expect(t).toBeTruthy();
    expect(await consumeCheckoutToken('return', 'pay_1', t!)).toBe(true);
  });
});

describe('the confirm body', () => {
  it("takes the app's names or Razorpay's, and the page's token", () => {
    expect(confirmSchema.parse({ gatewayPaymentId: 'pay_X', signature: 'sig' })).toEqual({ gatewayPaymentId: 'pay_X', signature: 'sig', gatewayOrderId: null, checkoutToken: null });
    expect(confirmSchema.parse({ razorpay_payment_id: 'pay_X', razorpay_order_id: 'order_1', razorpay_signature: 'sig', checkoutToken: 'ct' })).toEqual({
      gatewayPaymentId: 'pay_X',
      signature: 'sig',
      gatewayOrderId: 'order_1',
      checkoutToken: 'ct',
    });
    expect(confirmSchema.safeParse({ razorpay_order_id: 'order_1' }).success).toBe(false);
  });
});
