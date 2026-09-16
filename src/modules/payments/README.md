# payments

The gateway — Lot C (Q110/Q118/Q12), Lot J-B2 for publishers. One `Payment`
per attempt to pay a campaign, a package sale or a publisher's subscription
order through Razorpay, Cashfree or CCAvenue; the refunds back to the card or
UPI an advertiser's came from; and the webhook door the gateways call.

Not to be confused with `payouts`, which is money leaving ADX to publishers,
agents and print partners. This is money arriving from advertisers and — for
a plan — from publishers.

## Who pays, for what

A payment names **exactly one payer** (`advertiserId` or `publisherId`) and
**exactly one target**:

| Target | Payer | Resolved through | Settled by |
| --- | --- | --- | --- |
| `campaignId` | the advertiser (or their agent) | `campaigns.campaignPaymentQuote` — the authorise's own checks, so no order opens for a campaign that could not then be authorised; then the booking gates, funds excepted | `campaigns.authorizeCampaignById` (the hold, the orders, the insertion-order gate, the invoice) |
| `packageSaleId` | the advertiser (or their agent) | `packages.findSale` + `assertMayActOnSale` + `assertPayable` + `assertSaleTermsAccepted`; then the booking gates | `advertisers.payForPackage` + `packages.markPaid({ method: 'GATEWAY' })` |
| `subscriptionOrderId` (Lot J-B2) | **the order's publisher only** — `revenue.assertMayPaySubscriptionOrder`, the same publisher-of-session lookup the order routes make; an admin records an offline payment on the order instead | `revenue.findSubscriptionOrder` + `assertSubscriptionOrderPayable` (PENDING_PAYMENT; a PAID order is 409); behind `revenue.publisher-plans` (503 `FEATURE_OFF` when off). No advertiser gate applies | the publisher wallet's subscription debit + `revenue.markSubscriptionOrderPaid({ method: 'GATEWAY', reference })` |

The description on the gateway order and the checkout page names the target:
`Campaign ADX-CMP-… — name`, `Growth plan — PKG-…`, `Plus plan — SUB-2026-…`.
The customer the adapter is given is the advertiser's company or the
publisher (`publishers.findPublisherContact`).

## Money passes through the wallet (Q110)

A capture never goes straight to the target. It is a gateway **TOPUP** into
the **payer's** wallet — wallet + / `platform:cash` −, keyed
`topup:gateway:<gateway payment id>` with the gateway's payment as the
reference: `advertisers.recordGatewayTopUp` for an advertiser (which also
writes their TopUp row for reconciliation), the same movement through
`wallets.move` on the PUBLISHER wallet for a publisher (no TopUp row —
`topUpId` stays null, `walletEntryId` / `ledgerTransactionId` carry the
trail) — and the target is then settled **out of that balance by the same
call the wallet path makes**: `campaigns.authorizeCampaignById`,
`advertisers.payForPackage` + `packages.markPaid({ method: 'GATEWAY' })`, or,
Lot J-B2, the publisher wallet debit `revenue`'s own pay route makes
(PACKAGE_DEBIT under PACKAGE_SPEND, wallet − / `platform:revenue` +, keyed
`subscription-debit:<orderId>`, `requireFunds`) followed by
`revenue.markSubscriptionOrderPaid({ method: 'GATEWAY', reference:
<PAY reference> })`, which activates the subscription once. The invoice a
campaign or a sale issued is stamped with the payment through
`invoices.markInvoicePaid(invoiceId, { paymentId })`; **a subscription
payment issues no invoice** — `invoices` names an advertiser, and a
publisher's receipt is a later lot (revenue README, "Not here").

So every rail tells the ledger one story, and a capture whose target can no
longer be applied — the spots were booked out while the advertiser was on the
gateway page, the sale was cancelled, the order can no longer activate
(`ALREADY_ON_PLAN`, a frozen publisher wallet) — leaves the payer with
**spendable balance** rather than money in limbo (Q118). Ops are told
(`Payment captured but not applied`) and apply it by hand, or authorise on
behalf. An order the publisher meanwhile paid from the wallet reads as
settled: the debit's key and the order's PAID status make a retried webhook,
a second confirm and the wallet route one charge between them.

The full total is always collected, even when the wallet already holds
something: simpler for the payer to read than a shortfall, impossible to
double-charge on a retry, and the surplus stays spendable.

The payer hears at every turn — `Payment received`, `Payment failed` — the
advertiser as a BOOKING notice, the publisher (Lot J-B2) as a SYSTEM notice
on the login their record names, `relatedId` the order.

## Owned routes

| Method | Path | Guard | What |
| --- | --- | --- | --- |
| GET | `/api/v1/payments/gateways` | `authenticate` | Which gateways are configured and whether in test mode; an ADMIN also sees which fields are empty (names, never values) |
| POST | `/api/v1/payments/intents` | `authenticate` | `{ campaignId \| packageSaleId \| subscriptionOrderId, gateway }` — exactly one of the three (400 names all three otherwise) → **201** `{ payment, checkout, checkoutUrl }`. A campaign or a sale: the advertiser or their agent (the campaign's `assertMayAct`, the sale's); priced through `campaigns.campaignPaymentQuote` — the same checks the authorise makes, so no order is opened for a campaign that could not then be authorised — or the sale read (payable, terms accepted); then the booking gates, funds excepted (suspension, profile, KYC, platform agreement). A subscription order (Lot J-B2): the order's publisher only (403 for another publisher, an advertiser or an admin), PENDING_PAYMENT only (409), `revenue.publisher-plans` on; the Payment carries `publisherId` + `subscriptionOrderId` with `advertiserId` null and the description names the plan and the SUB reference. 409 `GATEWAY_NOT_CONFIGURED` when the keys are missing. Audited `PAYMENT_INTENT_CREATED`. E7-2: for RAZORPAY `checkoutUrl` (also `checkout.checkoutUrl`) is the checkout page below under a one-time token — twenty minutes, single use, hash in Redis; null for the redirect-flow gateways |
| GET | `/api/v1/payments/:id/checkout?t=` | **none** — the one-time token | E7-2: the page the phones open in the system browser (`react-native-razorpay` is not installed). One self-contained HTML document whose only external asset is `https://checkout.razorpay.com/v1/checkout.js`; opens Razorpay Checkout with the intent's order id, key id, amount in paise, prefill (name, email, contact — the advertiser's company, or Lot J-B2 the publisher's name) and theme from a JSON block the inline script reads; the line under the reference is `Campaign booking`, `Plan payment`, or for a subscription payment the plan and the SUB reference (`Plus plan — SUB-2026-000123`). The handler posts `{ razorpay_payment_id, razorpay_order_id, razorpay_signature, checkoutToken }` to the confirm below under a second one-time token minted with the page, then shows **Paid — return to the ADX app** or the failure with a retry link (a fresh checkout token). Served under a `Content-Security-Policy` (nonce'd script and style, Razorpay's hosts, `connect-src 'self'`), `no-store`, `noindex`. The key prefix (`rzp_test_`) decides the mode the page shows. A spent, expired or foreign token is a plain 401 page; a settled or failed payment gets the plain status page instead of Checkout |
| GET | `/api/v1/payments/:id/return?t=` | **none** — the one-time return token, optional | E7-2: the redirect target Cashfree and CCAvenue land on — was `FRONTEND_URL/payments/:id/return`, which no UI served. A plain page reading the payment's status (no secrets, no script): **Paid**, **Failed**, or **Still processing — the app updates itself**. E9: a bare payment id prints **only the status word**; the reference, the amount and the gateway's failure text appear only when `?t=` carries the intent's one-time `return` token (the same family as the checkout page's, minted with the intent, spent on first use, bound to this payment). The adapters' `returnUrl` carries it; the CCAvenue browser redirect mints one of its own |
| GET | `/api/v1/payments` | `authenticate` + ADMIN | The register on the list contract: `?status&gateway&advertiserId&publisherId&campaignId&packageSaleId&subscriptionOrderId&q&sort&page&pageSize`, counts by status; every row carries `advertiserId` / `publisherId` and `campaignId` / `packageSaleId` / `subscriptionOrderId` |
| GET | `/api/v1/payments/:id` | `authenticate` | Owner (the advertiser or, Lot J-B2, the publisher), the person who raised it, or ADMIN |
| POST | `/api/v1/payments/:id/confirm` | `authenticate`, **or** the checkout page's one-time `checkoutToken` in the body (E7-2) | `{ gatewayPaymentId, signature }` or Razorpay's own `{ razorpay_payment_id, razorpay_order_id, razorpay_signature }` — the checkout handler (CCAvenue's `encResp` rides in `signature`). An order id that is not the payment's is 400. Verified, then the payment is **read back from the gateway**, captured where the account authorises first, and settled. 400 `PAYMENT_SIGNATURE_INVALID`, 402 on a failed payment, 409 while the gateway has not captured. Idempotent: a captured payment confirmed again only re-checks its target. Under the token the confirmation is recorded as the person who raised the intent; a spent or foreign token is 401 `CHECKOUT_TOKEN_INVALID`. Mounted ahead of the router's `authenticate` with the two pages |
| POST | `/api/v1/payments/:id/refund` | `authenticate` + ADMIN + `finance.approve` | `{ amount, reason, refundRequestId? }` through the adapter's refund API → `PaymentRefund`; see refunds below. Advertiser payments only — a subscription payment is 409 (Lot J-B2). Audited `PAYMENT_REFUNDED` with the status before and after. Answers `{ refund, payment }` — T-B: `refund` as the Payment view lists a refund (`toRefundView`, money as a string), `payment` as `GET /payments/:id` answers it (`toPaymentView`, with `refundable` and `refunds[]`) |
| GET | `/api/v1/advertisers/:id/payments` | `authenticate` (`assertMayActFor` READ) | The advertiser's own payments — owner, attributed agent, ADMIN |
| POST | `/api/v1/webhooks/razorpay` | none — the signature | `X-Razorpay-Signature` over the raw body, `X-Razorpay-Event-Id` |
| POST | `/api/v1/webhooks/cashfree` | none — the signature | `x-webhook-signature` = base64 HMAC-SHA256(`x-webhook-timestamp` + raw body) |
| POST | `/api/v1/webhooks/ccavenue` | none — the working key | The form post carrying `encResp`; a browser (`Accept: text/html`) is redirected on to `/api/v1/payments/:id/return?t=…&status=` (E7-2 — the API's own page; `status` is a hint, the page reads the row; E9 — `t` is a fresh return token, so the browser that paid sees the reference and amount) |

`campaigns` gained `POST /campaigns/:id/submit-for-payment` and the on-behalf
authorise in the same lot — see that README.

## Owned Prisma entities

`Payment` (`reference` PAY-YYYY-NNNNNN; exactly one of `advertiserId` /
`publisherId` and one of `campaignId` / `packageSaleId` /
`subscriptionOrderId` — Lot J; `gateway`, `gatewayOrderId`,
`gatewayPaymentId`; status CREATED → AUTHORIZED → CAPTURED → FAILED /
REFUNDED / PARTIALLY_REFUNDED; the `topUpId`, `walletEntryId`,
`ledgerTransactionId` and `invoiceId` the capture wrote), `PaymentRefund`
(PENDING / PROCESSED / FAILED, `gatewayRefundId`, `refundRequestId`),
`WebhookEvent` (unique per `(gateway, eventId)`).

## Public exports (`index.ts`)

- `paymentRouter`, `advertiserPaymentRouter`, `paymentWebhookRouter`.
- E7-2 internals, not exported: `checkout-tokens.ts` (the one-time tokens — `payments:<kind>-token:<paymentId>:<sha256>` in Redis, 20 minutes, one atomic DEL to spend) and `checkout-page.service.ts` (the two pages, their CSPs, `checkoutUrlFor` / `returnUrlFor`).
- `registerPaymentsModule()` — supplies `advertisers`' `OriginalMethodRefundPort`.
- `listGateways`, `getPayment`, `toPaymentView` and the types.
- `payer.ts` (internal, a leaf both services import): `advertiserOf` — the
  advertiser-only paths' guard — and `payerOf`, the branch the two-party
  paths take (Lot J-B2).

## Dependencies

`advertisers` (the wallet door: `recordGatewayTopUp`, `payForPackage`,
`bookingEligibility`, `getAdvertiser`, the refund request reads and
`markRefundPaid` / `failRefund`), `campaigns` (`campaignPaymentQuote`,
`authorizeCampaignById`), `packages` (`findSale`, `assertMayActOnSale`,
`assertPayable`, `assertSaleTermsAccepted`, `markPaid`), `revenue` (Lot
J-B2: `findSubscriptionOrder`, `assertMayPaySubscriptionOrder`,
`assertSubscriptionOrderPayable`, `markSubscriptionOrderPaid`), `publishers`
(`findPublisherForUser` for the actor, `findPublisherContact` for the
customer and the notices), `feature-flags` (`isFeatureEnabled` on
`revenue.publisher-plans`), `invoices` (`liveInvoiceFor`, `markInvoicePaid`),
`wallets` (the publisher's TOPUP and subscription debit; the direct refund's
own legs) + `ledger`, `notifications`, `users` (`listAdminUserIds`),
`shared/integrations` (the per-gateway config), `shared/security`
(`verifyHmacSignature`).

## The adapters (`gateways/`)

`gateway.ts` is the port: `readiness`, `createOrder`, `verifySignature`,
`fetchPayment`, `capture?`, `refund`, `parseWebhook`. Every adapter is built
over `fetch` — no vendor SDK — and answers `{ configured: false, missing }`
cleanly when its keys are missing, which the service turns into 409
`GATEWAY_NOT_CONFIGURED`. Config comes from the `integrations` row
(`/settings/integrations`), falling back to `.env`:

| Gateway | Section / env | Test mode | Notes |
| --- | --- | --- | --- |
| Razorpay | `razorpay.keyId / keySecret / webhookSecret / testMode` — `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_TEST_MODE` | One host; the key prefix (`rzp_test_` / `rzp_live_`) decides. The flag is the console's record | Orders API (paise, Basic auth); checkout signature = HMAC-SHA256(`order_id|payment_id`, key secret); `POST /v1/payments/:id/capture` when the account authorises first; refunds API keyed on our refund id as `receipt` |
| Cashfree PG | `cashfree.appId / secretKey / webhookSecret? / testMode` — `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_WEBHOOK_SECRET`, `CASHFREE_TEST_MODE` | `sandbox.cashfree.com` while on, `api.cashfree.com` off | API version 2023-08-01; our Payment id is the merchant `order_id`; `payment_session_id` goes to the app; the webhook is signed with the secret key unless a dedicated webhook secret is set. Distinct from `CASHFREE_PAYOUT_KEY`, which is `payouts`' rail |
| CCAvenue | `ccavenue.merchantId / accessCode / workingKey / testMode` — `CCAVENUE_MERCHANT_ID`, `CCAVENUE_ACCESS_CODE`, `CCAVENUE_WORKING_KEY`, `CCAVENUE_TEST_MODE` | `test.ccavenue.com` + `apitest.ccavenue.com` while on, `secure.ccavenue.com` + `api.ccavenue.com` off | Redirect flow: `createOrder` makes no network call — it returns the AES-128-CBC `encRequest` (key = MD5(working key), IV 0x00…0x0f, per their kit), the access code and the transaction URL. The `encResp` posted back is the webhook; it is trusted because it decrypts under the working key into a record naming our order. Status and refunds go through `DoWebTrans` (`orderStatusTracker`, `refundOrder`) |

**Test mode (Q110).** Razorpay goes live first. Cashfree and CCAvenue ship as
adapters targeting their sandbox hosts (`testMode` defaults **on**) until the
credentials arrive; switching a section's `testMode` off in `/integrations`
points it at the live host. Stripe's section stays in `integrations` and is
unused.

## Webhooks

Signature-checked before anything is written, failing closed on every path —
no secret, no signature, no body, mismatch — with **401**. A verified body the
adapter cannot read is answered **200** (`UNPARSEABLE`) so the gateway stops
retrying. Every verified event is a `WebhookEvent` row, once per
`(gateway, eventId)`; a retry of an applied event answers with what it did,
and one recorded but not applied (the process died mid-way) is applied on
the retry. `payment.captured` settles as above; `payment.authorized` is
captured first where the adapter can; `payment.failed` marks FAILED and tells
the advertiser; `refund.processed` / `refund.failed` finalise or undo a
pending refund. An event naming an order the platform does not know is
recorded and answered `NO_PAYMENT`.

The raw body is kept by `create-app` beside the parsed one for every JSON
request (the Digio hook's arrangement); CCAvenue's callback is a form post
and needs no raw body.

## Refunds

**Advertiser payments only.** A subscription payment (Lot J-B2) is **not
refundable through this path** — 409 before anything is written: a
`WalletRefundRequest` is an advertiser wallet's, the direct return debits an
advertiser's wallet against payables, and DR 04 gives no money back off a
plan. Money a publisher wants back leaves through `payouts`, and a plan is
ended in `revenue`.

Two doors on `POST /payments/:id/refund`, both ADMIN + `finance.approve`, both
never more than what is left on the payment:

- **With `refundRequestId`** — paying an APPROVED `WalletRefundRequest` whose
  destination is ORIGINAL_METHOD (Lot B's desk, `advertisers`). The wallet was
  debited at approval (REFUND: wallet − / payables +), so only the gateway leg
  and the PAID stamp happen here: `advertisers.markRefundPaid` posts payables
  − / cash + with the gateway's refund id as the reference. The amount must be
  the request's own; the request must be on this payment's advertiser.
- **Without** — a direct return. The wallet is debited **first** (the same
  REFUND legs, `requireFunds`, 402 when the balance is not there), so the
  books never show money leaving ADX that the advertiser still holds; the cash
  leg posts when the gateway says processed.

Either way a gateway refusal marks the refund FAILED and puts the money back
(the request through `failRefund`, the direct one with an ADJUSTMENT credit).
A refund PENDING at the gateway is finalised by its webhook. The payment goes
PARTIALLY_REFUNDED or REFUNDED as the standing refunds add up.

`WalletRefundRequest` may now name ORIGINAL_METHOD: `advertisers` asks this
module through `OriginalMethodRefundPort` whether the advertiser has a
captured gateway payment with enough left, on a configured gateway.

## Invariants

- No gateway order for a campaign that could not then be authorised, nor for a
  sale that is not payable or whose terms are not accepted.
- The gateway's answer, never the client's, decides a capture: the confirm
  route verifies the signature and then reads the payment back.
- A capture is a TOPUP into the payer's wallet keyed on the gateway's payment
  id; the target is settled by the wallet path's own idempotent calls (the
  order's debit keyed on the order). Nothing is charged twice however many
  times a webhook or a confirm arrives.
- A payment names one payer and one target; the advertiser-only paths
  (refunds, the TopUp row) ask `advertiserOf` and refuse a publisher's
  payment rather than treating it as anyone's.
- An amount that differs from the intent is credited to the wallet and **not**
  applied; ops are told.
- Every admin write is audited against the `Payment` with the status before
  and after; captures and failures are audited under the user who confirmed
  or `system` for a webhook.

## Tests

```bash
npx vitest run src/modules/payments
```

Adapters are tested with recorded fixtures and signature vectors over a stub
`fetch`; the service against an in-memory repository; the checkout and
return pages (`checkout-page.test.ts`) against an in-memory Redis, and the
door on the router (`payments.routes.test.ts`) over supertest.

## Lot J2: the subscription policies

`POST /payments/intents` for a `subscriptionOrderId` (publisher) or a
`packageSaleId` (advertiser) honours the audience's
`settings.subscriptions.<audience>.payment.gatewaysAllowed`
(`app-config`, `getSubscriptionPolicy`): a gateway not listed is refused
**400 `PAYMENT_METHOD_NOT_OFFERED`** naming the ones that are, before any
row is written or any gateway order opened; an empty list closes the
gateway path for that audience (the message then points at the wallet when
`walletAllowed` is on). Campaign payments are untouched — a campaign is not
a subscription.

Two of Lot J's leftovers landed here too:

- **(b) the term rule before the debit at capture.** `settleSubscriptionOrder`
  asks `revenue.assertSubscriptionOrderActivatable(order, now)` before the
  wallet's PACKAGE_DEBIT, so an order that can no longer start (409
  `ALREADY_ON_PLAN`) leaves the capture spendable in the publisher's wallet
  and tells ops, rather than moving money to `platform:revenue` for a plan
  that never activated.
- **(c) the payer hears once.** `settleCapture` notifies the payer
  ("Payment received") only on the CREATED/AUTHORISED → CAPTURED
  transition; a second confirm and a replayed capture webhook re-check the
  target and say nothing.
