import { randomBytes } from 'crypto';
import { env } from '../../config/env';
import { money } from '../../shared/money';
import { getEffectiveRazorpayConfig } from '../../shared/integrations';
import { getAdvertiser } from '../advertisers';
import { findPublisherContact } from '../publishers';
import { findSubscriptionOrder } from '../revenue';
import { toPaise } from './gateways/gateway';
import { consumeCheckoutToken, mintCheckoutToken } from './checkout-tokens';
import type { PaymentView } from './payments.repository';
import { prismaPaymentsRepository as repository } from './prisma-payments.repository';
import { payerOf } from './payer';

/**
 * The two browser pages the gateway flow needs (E7-2).
 *
 * `GET /payments/:id/checkout?t=` — the phones have no Razorpay SDK, so the
 * app opens this in the system browser. One self-contained document whose
 * only external asset is Razorpay's own `checkout.js`; it opens Checkout
 * with the intent's order, and the handler posts the gateway's answer to
 * `POST /payments/:id/confirm` under a second one-time token. Then "Paid —
 * return to the ADX app", or the failure with a retry link.
 *
 * `GET /payments/:id/return?t=` — where Cashfree and CCAvenue send the
 * browser afterwards. Before this it was `FRONTEND_URL/payments/:id/return`,
 * which no UI serves. A plain page reading the payment's status: no secrets,
 * no script. E9 (the E7 verifier): a bare payment id is a guessable URL, so
 * without the intent's one-time return token the page prints only the
 * status word; the reference, the amount and the gateway's failure text
 * appear only under `?t=` — the token the gateways' return URLs carry, the
 * same family as the checkout page's, spent on first use.
 *
 * Both are rendered here rather than by an app for the reason the landing
 * page is: the reader is a phone's browser with no session, and every
 * asset a slow connection has to fetch first is a payment abandoned.
 */

export const RAZORPAY_CHECKOUT_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
/** One host serves both modes; the key's prefix says which the page is in. */
export const RAZORPAY_API_HOST = 'https://api.razorpay.com';
const RAZORPAY_TEST_PREFIX = 'rzp_test_';

export const apiBase = (): string => env.BASE_URL ?? `http://localhost:${env.PORT}`;

/** The public URL the intent hands the app for a Razorpay payment. */
export const checkoutUrlFor = (paymentId: string, token: string): string =>
  `${apiBase()}/api/v1/payments/${encodeURIComponent(paymentId)}/checkout?t=${encodeURIComponent(token)}`;

/** The redirect target every gateway is given — the same page for all three, under the intent's return token when one is given. */
export const returnUrlFor = (paymentId: string, token?: string): string =>
  `${apiBase()}/api/v1/payments/${encodeURIComponent(paymentId)}/return${token ? `?t=${encodeURIComponent(token)}` : ''}`;

/**
 * E9: the CCAvenue browser redirect — the encResp arrives at the webhook
 * with the customer's own browser, so the handler mints a return token of
 * its own for the page it sends them on to. `status` is a hint for the
 * log; the page reads the row.
 */
export async function returnRedirectUrlFor(paymentId: string, status: string): Promise<string> {
  const url = new URL(returnUrlFor(paymentId, await mintCheckoutToken('return', paymentId)));
  url.searchParams.set('status', status);
  return url.toString();
}

export type RenderedPage = {
  status: number;
  html: string;
  /** The Content-Security-Policy the page is served under. */
  csp: string;
};

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const e = escapeHtml;

const nonceOf = (): string => randomBytes(16).toString('base64');

/**
 * Locked down to the page's own inline script and style by nonce, and
 * Razorpay's hosts for the script, its iframe and the calls it makes. The
 * confirm goes to `'self'`. Nothing else may load, frame or be framed.
 */
export function checkoutCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://checkout.razorpay.com`,
    `style-src 'nonce-${nonce}'`,
    `connect-src 'self' ${RAZORPAY_API_HOST} https://checkout.razorpay.com https://lumberjack.razorpay.com`,
    `frame-src ${RAZORPAY_API_HOST} https://checkout.razorpay.com`,
    "img-src 'self' https://*.razorpay.com data:",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The status pages carry no script and load nothing. */
export function statusCsp(nonce: string): string {
  return ["default-src 'none'", `style-src 'nonce-${nonce}'`, "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join('; ');
}

const STYLE = [
  ':root{color-scheme:light}',
  'body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;color:#14181f}',
  'main{max-width:420px;margin:0 auto;padding:32px 20px}',
  '.card{background:#fff;border-radius:16px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}',
  'h1{font-size:20px;margin:0 0 8px}',
  'p{margin:8px 0;line-height:1.5}',
  '.muted{color:#5b6472;font-size:14px}',
  '.amount{font-size:28px;font-weight:600;margin:12px 0}',
  '.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#fff3cd;color:#7a5a00;margin-left:8px}',
  '.ok{color:#137a3f}.fail{color:#b42318}',
  'button,a.btn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:14px;border:0;border-radius:12px;background:#1f5eff;color:#fff;font-size:16px;font-weight:600;text-decoration:none;margin-top:16px;cursor:pointer}',
  'button[disabled]{opacity:.5}',
  '[hidden]{display:none!important}',
].join('');

type StatusPage = {
  title: string;
  headline: string;
  body: string;
  tone: 'ok' | 'fail' | 'neutral';
  reference?: string | null;
  retryUrl?: string | null;
};

export function renderStatusPage(page: StatusPage, nonce = nonceOf()): { html: string; csp: string } {
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>${e(page.title)} — ADX</title><style nonce="${nonce}">${STYLE}</style></head><body><main><div class="card">`,
    `<h1 class="${page.tone === 'neutral' ? '' : page.tone}">${e(page.headline)}</h1>`,
    page.reference ? `<p class="muted">${e(page.reference)}</p>` : '',
    `<p>${e(page.body)}</p>`,
    page.retryUrl ? `<a class="btn" href="${e(page.retryUrl)}">Try again</a>` : '',
    '</div></main></body></html>',
  ].join('');
  return { html, csp: statusCsp(nonce) };
}

export type CheckoutPageData = {
  paymentId: string;
  reference: string;
  description: string;
  keyId: string;
  orderId: string;
  /** Minor units, as Checkout wants them. */
  amount: number;
  currency: string;
  /** The rupee figure the page prints. */
  amountLabel: string;
  prefill: { name: string; email: string; contact: string };
  theme: { color: string };
  testMode: boolean;
  confirmUrl: string;
  confirmToken: string;
  retryUrl: string;
};

/**
 * The page itself. The data Checkout needs rides in a JSON script block the
 * inline script reads — nothing is interpolated into JavaScript — and the
 * JSON is escaped so a `</script>` in a company name cannot end the block.
 */
export function renderCheckoutPage(data: CheckoutPageData, nonce = nonceOf()): { html: string; csp: string } {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const script = `
(function () {
  var cfg = JSON.parse(document.getElementById('adx-checkout').textContent);
  var card = document.getElementById('card');
  var outcome = document.getElementById('outcome');
  var headline = document.getElementById('headline');
  var body = document.getElementById('body');
  var retry = document.getElementById('retry');
  var pay = document.getElementById('pay');
  function show(tone, title, text, canRetry) {
    card.hidden = true;
    outcome.hidden = false;
    headline.className = tone;
    headline.textContent = title;
    body.textContent = text;
    retry.hidden = !canRetry;
  }
  function confirm(response) {
    show('', 'Confirming your payment\\u2026', 'Do not close this page.', false);
    fetch(cfg.confirmUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_order_id: response.razorpay_order_id,
        razorpay_signature: response.razorpay_signature,
        checkoutToken: cfg.confirmToken
      })
    })
      .then(function (res) { return res.json().then(function (json) { return { ok: res.ok, status: res.status, json: json }; }); })
      .then(function (result) {
        if (result.ok) {
          show('ok', 'Paid', 'Return to the ADX app \\u2014 your campaign is being booked.', false);
          return;
        }
        var err = (result.json && result.json.error) || {};
        var message = err.message || 'The payment could not be confirmed.';
        if (result.status === 409 && err.code === 'CONFLICT' && /not captured/i.test(message)) {
          show('', 'Still processing', 'Your bank has not confirmed yet. Return to the ADX app \\u2014 it updates itself when the payment lands.', false);
          return;
        }
        show('fail', 'Payment failed', message, true);
      })
      .catch(function () {
        show('fail', 'Could not reach ADX', 'Check your connection and try again. If you were charged, the app will update itself.', true);
      });
  }
  if (typeof Razorpay !== 'function') {
    show('fail', 'Could not load Razorpay', 'Check your connection and try again.', true);
    return;
  }
  var rzp = new Razorpay({
    key: cfg.keyId,
    amount: cfg.amount,
    currency: cfg.currency,
    order_id: cfg.orderId,
    name: 'ADX',
    description: cfg.description,
    prefill: cfg.prefill,
    theme: cfg.theme,
    handler: confirm,
    modal: { ondismiss: function () { show('fail', 'Payment not completed', 'You closed the payment window before paying.', true); } }
  });
  rzp.on('payment.failed', function (response) {
    var error = (response && response.error) || {};
    show('fail', 'Payment failed', error.description || 'The bank declined the payment.', true);
  });
  pay.addEventListener('click', function () { rzp.open(); });
  rzp.open();
})();`;
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="robots" content="noindex">',
    `<title>Pay ${e(data.reference)} — ADX</title><style nonce="${nonce}">${STYLE}</style>`,
    `<script src="${RAZORPAY_CHECKOUT_SCRIPT}"></script>`,
    '</head><body><main>',
    `<div class="card" id="card"><h1>Pay ${e(data.reference)}${data.testMode ? '<span class="badge">Test mode</span>' : ''}</h1>`,
    `<p class="muted">${e(data.description)}</p><p class="amount">₹${e(data.amountLabel)}</p>`,
    '<p class="muted">Razorpay opens in a moment. If it does not, tap the button.</p>',
    '<button id="pay" type="button">Pay now</button></div>',
    `<div class="card" id="outcome" hidden><h1 id="headline"></h1><p id="body"></p><a class="btn" id="retry" href="${e(data.retryUrl)}" hidden>Try again</a></div>`,
    '</main>',
    `<script id="adx-checkout" type="application/json">${json}</script>`,
    `<script nonce="${nonce}">${script}</script>`,
    '</body></html>',
  ].join('');
  return { html, csp: checkoutCsp(nonce) };
}

/* ------------------------------------------------------------------ */
/* The pages                                                           */
/* ------------------------------------------------------------------ */

const isSettled = (status: PaymentView['status']): boolean => status === 'CAPTURED' || status === 'REFUNDED' || status === 'PARTIALLY_REFUNDED';

/** `detailed` (E9): the request carried the intent's return token — the reference, amount and failure text may be printed. */
function paidPage(payment: PaymentView, detailed = true): RenderedPage {
  return {
    status: 200,
    ...renderStatusPage({
      title: 'Paid',
      headline: 'Paid',
      tone: 'ok',
      reference: detailed ? `${payment.reference} · ₹${money(payment.amount)}` : null,
      body: `Return to the ADX app — ${
        payment.campaignId ? 'your campaign is being booked' : payment.subscriptionOrderId ? 'your subscription is being activated' : 'your plan is being activated'
      }.`,
    }),
  };
}

function failedPage(payment: PaymentView, detailed = true): RenderedPage {
  return {
    status: 200,
    ...renderStatusPage({
      title: 'Payment failed',
      headline: 'Payment failed',
      tone: 'fail',
      reference: detailed ? payment.reference : null,
      body: `${detailed ? `${payment.failureReason ?? 'The gateway reported the payment failed.'} ` : ''}Nothing was charged. Return to the ADX app to start a new payment.`,
    }),
  };
}

function notFoundPage(): RenderedPage {
  return {
    status: 404,
    ...renderStatusPage({ title: 'Not found', headline: 'Payment not found', tone: 'fail', body: 'This link does not match a payment. Return to the ADX app and try again.' }),
  };
}

/**
 * What the page prints and prefills: the advertiser's company for a campaign
 * or a sale; Lot J (B2) — the publisher's name and the plan line (`Plus plan
 * — SUB-2026-000123`) for a subscription payment, read from the order.
 */
async function pageLinesFor(payment: PaymentView): Promise<{ description: string; prefill: CheckoutPageData['prefill'] }> {
  const payer = payerOf(payment);
  if (payer.kind === 'PUBLISHER') {
    const [publisher, order] = await Promise.all([
      findPublisherContact(payer.id),
      payment.subscriptionOrderId ? findSubscriptionOrder(payment.subscriptionOrderId) : null,
    ]);
    return {
      description: order ? `${order.planName} plan — ${order.reference}` : 'Subscription payment',
      prefill: { name: publisher?.name ?? '', email: publisher?.email ?? '', contact: publisher?.mobile ?? '' },
    };
  }
  const advertiser = await getAdvertiser(payer.id);
  return {
    description: payment.campaignId ? 'Campaign booking' : 'Plan payment',
    prefill: { name: advertiser.companyName ?? advertiser.name ?? '', email: advertiser.email ?? '', contact: advertiser.mobile ?? '' },
  };
}

/**
 * The checkout: the token opens the door once, the page mints its confirm
 * token and a fresh checkout token for its retry link, and a payment that
 * is already settled or failed gets the plain page instead of Checkout.
 */
export async function checkoutPage(paymentId: string, token: string | undefined): Promise<RenderedPage> {
  if (!(await consumeCheckoutToken('checkout', paymentId, token))) {
    return {
      status: 401,
      ...renderStatusPage({
        title: 'Link expired',
        headline: 'This payment link has expired',
        tone: 'fail',
        body: 'It was already opened, or it is more than twenty minutes old. Return to the ADX app and tap Pay again.',
      }),
    };
  }
  const payment = await repository.findPayment(paymentId);
  if (!payment) return notFoundPage();
  if (isSettled(payment.status)) return paidPage(payment);
  if (payment.status === 'FAILED') return failedPage(payment);
  if (payment.gateway !== 'RAZORPAY' || !payment.gatewayOrderId) {
    return {
      status: 409,
      ...renderStatusPage({
        title: 'Not a Razorpay payment',
        headline: 'This payment does not open here',
        tone: 'fail',
        reference: payment.reference,
        body: `${payment.gateway} payments open on the gateway's own page. Return to the ADX app.`,
      }),
    };
  }

  const [cfg, lines, confirmToken, retryToken] = await Promise.all([
    getEffectiveRazorpayConfig(),
    pageLinesFor(payment),
    mintCheckoutToken('confirm', payment.id),
    mintCheckoutToken('checkout', payment.id),
  ]);
  const keyId = cfg.keyId ?? '';
  return {
    status: 200,
    ...renderCheckoutPage({
      paymentId: payment.id,
      reference: payment.reference,
      description: lines.description,
      keyId,
      orderId: payment.gatewayOrderId,
      amount: toPaise(money(payment.amount)),
      currency: payment.currency,
      amountLabel: money(payment.amount),
      prefill: lines.prefill,
      theme: { color: '#1f5eff' },
      testMode: keyId.startsWith(RAZORPAY_TEST_PREFIX),
      confirmUrl: `${apiBase()}/api/v1/payments/${encodeURIComponent(payment.id)}/confirm`,
      confirmToken,
      retryUrl: checkoutUrlFor(payment.id, retryToken),
    }),
  };
}

/**
 * The redirect target: Paid, Failed, or still processing. Public. E9: the
 * status word alone to a bare id; the reference, amount and failure text
 * only when the return token is spent here — once, for this payment.
 */
export async function returnPage(paymentId: string, token?: string): Promise<RenderedPage> {
  const detailed = await consumeCheckoutToken('return', paymentId, token);
  const payment = await repository.findPayment(paymentId);
  if (!payment) return notFoundPage();
  if (isSettled(payment.status)) return paidPage(payment, detailed);
  if (payment.status === 'FAILED') return failedPage(payment, detailed);
  return {
    status: 200,
    ...renderStatusPage({
      title: 'Processing',
      headline: 'Still processing',
      tone: 'neutral',
      reference: detailed ? payment.reference : null,
      body: 'The gateway has not confirmed yet. Return to the ADX app — it updates itself when the payment lands.',
    }),
  };
}
