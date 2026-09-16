# revenue

What an advertiser pays, and what a publisher keeps.

The `pricing` module decides what a publisher **lists at**. This decides what
happens to that number afterwards. Full rationale in
[`docs/revenue-model.md`](../../../docs/revenue-model.md).

## The one fact that explains the shape

> **Commission comes out of the publisher's earnings. It is never added to the
> advertiser's price.**

So the advertiser sees the publisher's own rate, ADX's take is invisible to
them, and ADX shares in any surge the publisher captures with no separate split
to maintain — a percentage of a bigger number is bigger.

```
Advertiser pays  =  media  +  fees  −  rate discount  +  GST  −  goodwill
Publisher keeps  =  media  −  commission
```

## Why this is not part of `pricing`

Pricing makes a claim about the market; revenue is commercial policy. Merged,
ADX could not change its take rate without re-pricing the market, and could not
re-price the market without changing what publishers are paid. They move for
different reasons and on different timescales.

## Commission: most specific wins

`resolveCommission` checks six sources in order and reports which one it used:

| Order | Source | `commissionSource` |
| --- | --- | --- |
| 1 | Promotional override on the publisher | `PROMOTIONAL_OVERRIDE` |
| 2 | Subscription tier the publisher bought | `SUBSCRIPTION` |
| 3 | Media-type rate for the rental band the spot falls in (Lot B) | `MEDIA_TYPE_SLAB` |
| 4 | Media-type rate (Lot B) | `MEDIA_TYPE` |
| 5 | Category rate | `CATEGORY_RATE` |
| 6 | Platform default — 15% as seeded | `PLATFORM_DEFAULT` |

**The override beats the subscription deliberately.** It exists to win one
particular publisher, usually at a worse rate for ADX than any tier sells;
losing that negotiation to a tier the publisher also happens to hold would
defeat the point of having made it.

**The media-type rows sit between the subscription and the category (Lot B,
Q10/Q38).** A `CommissionRate` may be keyed on `mediaTypeId` — the pricing
engine's own "ad type" — instead of a category, and may carry a rental band
`[minMediaValue, maxMediaValue)` on the **per-day media value per unit the
advertiser is billed for**: after the rate discount, before the campaign
discount and the fees. The floor is inclusive and the ceiling exclusive, so
bands written 0–1000 and 1000–5000 cannot both claim ₹1,000; either bound may
be open. A ₹1,500/month spot and a ₹10 lakh/month spot can carry different
takes without a second table. A banded row beats the unbanded row for the
same media type, and both lose to a subscription because the publisher paid
for that rate.

**There is no fallback any more.** The platform default is a row — category
null, media type null — that the seed writes and the console cannot retire
without replacing. A quote that finds no row refuses with 409
`COMMISSION_DEFAULT_MISSING` rather than pricing the marketplace at a number
nobody chose.

A resolved rate is **stored on the booking**, never re-derived:
`campaigns.checkout.authorizeCampaign` stamps `commissionPct` and
`commissionSource` on every `CampaignSpot` from the same quote that priced the
review — one resolution per spot — and `payouts` accrues at the stamp. A
publisher whose subscription lapses next month is still paid what was agreed
on a campaign booked this month. Spots authorised before the stamp existed are
resolved once by the accrual through `commissionForListing` (at the flight's
start, the rate that would have been stamped) and recorded as
`RESOLVED_AT_ACCRUAL`.

### Writing a rate

`POST /revenue/commission` (ADMIN) takes `{ category?, mediaTypeId?,
minMediaValue?, maxMediaValue?, ratePct, note? }`. Exactly one of `category`
and `mediaTypeId`, or neither for the platform default; a band needs a media
type and a floor below its ceiling. The row with the same key — same
category, or same media type with the same floor and ceiling — is retired and
a new one written, so writing a second band leaves the first and the unbanded
row alone. Audited `COMMISSION_RATE_SET` against the `CommissionRate` row.

## Three things in `quote()` that will bite a reader

**1. Tax is per line, not per total.** Printing carries 5% where the advertising
service carries 18%. One rate over a sum would be wrong in a way the total never
reveals.

**2. A rate discount and a goodwill credit are not the same reduction.** The
discount lowers the taxable value, so GST is charged on what is left. Goodwill
is a *payment* applied to the gross after GST. Collapsing them into one
"discount" field is a tax error, not a rounding one — and goodwill treated as a
discount under-reports GST on money that was genuinely charged.

**3. A percentage fee is charged on the discounted media value.** The discount
reduces what the advertiser is buying; computing the platform fee on the
undiscounted figure would quietly claw part of it back.

## The cart names every mandatory fee

`amountShownInCart` decides whether a fee's *amount* appears before checkout.
Every mandatory fee is **named** in the cart regardless, and `quote()` returns
`disclosedFeeNames` for exactly that.

The commercial intent — a clean cart, the full breakdown at checkout — survives
intact. What does not survive scrutiny is a cart implying the media rate is the
price while mandatory charges appear only at the last step: the CCPA's 2023
dark-pattern guidelines name drip pricing explicitly, and "you can expand the
breakdown at checkout" is the pattern they describe rather than a defence.
Naming them costs the clean cart nothing.

Design fees are the exception the other way: shown with their amount, because an
advertiser deciding whether ADX should make their creative decides in the cart.

## Price locks hold a price, not a site

A lock that reserved inventory would let anyone empty the marketplace by filling
a cart and walking away, and no amount of expiry tuning fixes that.

Thirty minutes ordinarily; a working day above five spots, since a bulk cart
takes longer to assemble. Expiry is by timestamp rather than by a sweeper, so
there is no window in which a stale lock is honoured because a job has not run.

## Authorisation

`POST /revenue/quote` is **ADMIN only**, and that is not incidental. The response
names ADX's take rate and where it came from — which neither side of the
marketplace should read off an endpoint. The advertiser is not meant to see
commission at all, and a publisher learning that a neighbour holds a promotional
rate is its own commercial problem. A trimmed advertiser-facing quote belongs
with the cart.

Price locks resolve the advertiser **from the session**, never from the body. A
lock keyed by a client-supplied id would let anyone hold a price for someone
else and, more usefully to an attacker, read back what that someone was quoted.

## Publisher plans and self-service orders (Lot J-B1)

The owner, 14 Sep 2026: *"add the plans and prices section with default
pricing for now; a control in the admin panel to change and control the
subscription plans and features for both user types."* The advertiser side
is `packages`; this is the publisher side, built to the same shape — a
catalogue ops reprice without a deploy, an order that snapshots it, and a
payment that turns the order into the `PublisherSubscription` the commission
ladder already reads. **Every default below is the owner's to change on the
console** (`PATCH /revenue/plans/:tier`); nothing here is a deploy.

### Routes

All under `/api/v1/revenue`, `authenticate` at the router. The order routes
and the phone's screen sit behind the `revenue.publisher-plans` kill switch
(`requireFeature`); the catalogue read and its editor do not, so ops can
still edit while the switch is off and the commission ladder — which reads
the subscription, not the switch — carries on.

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/plans` (`?includeInactive=true`) | any signed in | the three plans, seeded on first read; every row carries `pricePerMonth`, `ratePct`, `entitlements`, `enforcedKeys`, `isActive`, `sortOrder`, `isPopular`; the flag lists retired plans too and is honoured for ADMIN only |
| PATCH | `/plans/:tier { name?, pricePerMonth?, ratePct?, description?, entitlements?, isPopular?, isActive?, sortOrder? }` | ADMIN | the editor; audited `PUBLISHER_PLAN_UPDATED` with the diff. **Never re-rates a subscription already sold** — each keeps its own copies |
| POST | `/subscription-orders/quote { tier, cycle }` | the publisher (from the session) | what it costs and when the term would start (`term.rule`, `term.startsAt`, `term.replaces`, Lot J2 `term.credit`); Lot J2: `policy` beside the money — `{ cyclesOffered, annualDiscountPct, changePolicy, prorateOnChange, graceDays, trialDays (this tier), payment: { walletAllowed, gatewaysAllowed }, autoRenewAllowed }` — so the phone prints rules it did not compute; 400 `CYCLE_NOT_OFFERED` for a cycle the policy does not offer |
| POST | `/subscription-orders/trial { tier }` | the publisher | Lot J2 (5): a free trial — **201** `{ order, subscription }`, the order PAID at once with total 0 and `paidMethod` TRIAL, the subscription of `trialDays` (source SELF_SERVICE); 409 `TRIAL_NOT_OFFERED` when the tier's `trialDays` is 0, 409 `TRIAL_ALREADY_USED` once the publisher has ever held any subscription or trial (any source, running or not). Lot K (B2): **cannot race** — the order and the subscription are written in one transaction under `pg_advisory_xact_lock(hashtext(publisherId))` (`repository.startTrial`, the way `wallets.move` serialises a wallet) and the "never held anything" check is asked again inside it, so two taps arriving together are one 201 and one 409 |
| POST | `/subscription-orders { tier, cycle }` | the publisher | **201** `{ order, term }`; reference `SUB-YYYY-NNNNNN`; refused 409 `ALREADY_ON_PLAN` by the term rule below |
| GET | `/subscription-orders` (`?status=&publisherId=&q=&page&pageSize`) | ADMIN | the book on the list contract `{ items, total, page, pageSize, counts }`, newest first; `q` over reference, plan name, publisher name |
| GET | `/subscription-orders/:id` | the owning publisher, or ADMIN | the order |
| POST | `/subscription-orders/:id/pay` | the owning publisher only | pays from their own wallet — see below; 402 `INSUFFICIENT_FUNDS`; Lot J2: 403 `PAYMENT_METHOD_NOT_OFFERED` when the policy's `payment.walletAllowed` is false |
| POST | `/subscription-orders/:id/cancel` | the owner or ADMIN | PENDING_PAYMENT only; an admin's cancel is audited `SUBSCRIPTION_ORDER_CANCELLED` |
| POST | `/subscription-orders/:id/record-payment { reference, method }` | ADMIN | money that arrived outside ADX; audited `SUBSCRIPTION_ORDER_RECORDED` |
| GET | `/subscriptions/me` | the publisher | `{ running, grace, upcoming, plan, orders, catalogue, options, canBuy, reason, trialAvailable, policy }` — what the phone's subscription screen reads; `options` says per tier whether it can be bought and which term rule would apply (under `QUEUE_AFTER_TERM` every other tier queues); Lot J2: `running.autoRenew`, `trialAvailable: { tier: days }` for the tiers a first-ever subscriber may still start, and the `policy`; Lot K (B2): `grace: { tier, planName, endsAt, until } \| null` — with nothing running, the term that ended inside the policy's `graceDays` and is still honoured (`until` = `endsAt + graceDays`); null while one runs, past the window, or with `graceDays` 0 |
| PATCH | `/subscriptions/me { autoRenew }` | the publisher | Lot J2 (6): the flag on the running row; 409 `AUTO_RENEW_NOT_OFFERED` "Auto-renew is not offered" while the policy's `autoRenew.allowed` is false (switching off is always allowed); 404 with nothing running; Lot K (B2): 409 `AUTO_RENEW_NOT_OFFERED` "A trial does not renew - buy the plan" when the running row was made by a TRIAL order, whatever the policy says |
| GET | `/subscriptions` (`?state=RUNNING\|UPCOMING\|ENDED&q=&publisherId=&page&pageSize`) | ADMIN | Lot J2 (d): the list contract `{ items, total, page, pageSize, counts }`, counts per state with the facet removed; every row carries `publisher: { id, name, displayId }`, `planName`, `state`, `source`, `autoRenew`; Lot K (B2): `inGrace` (ENDED and still inside the policy's `graceDays`), `graceEndsAt` (`endsAt + graceDays`, null for an open-ended grant) and `createdAt`; `q` over the publisher's name and display id |
| POST | `/subscriptions { publisherId, tier, startsAt, endsAt?, ratePct?, pricePerMonth? }` | ADMIN | the grant; `ratePct` and `pricePerMonth` are filled from the tier's plan when omitted, explicit values still win; audited `SUBSCRIPTION_GRANTED` (Lot J2, a) |
| POST | `/subscriptions/:id/end` | ADMIN | ends the row now; audited `SUBSCRIPTION_ENDED` with the end that moved |
| POST | `/overrides`, POST `/fees`, PATCH `/fees/:id`, PATCH `/tax` | ADMIN | as before; Lot J2 (a): audited by name — `COMMISSION_OVERRIDE_GRANTED`, `FEE_CREATED`, `FEE_UPDATED`, `TAX_SETTINGS_UPDATED` — with `auditDiff` |

### The defaults (the owner's to change)

| Tier | Name | Price / month | Commission granted | Entitlements |
| --- | --- | --- | --- | --- |
| STANDARD | Standard | ₹999 | platform default − 1 point | `{ liveChat: false, prioritySupport: false, featuredListings: 0, analytics: 'BASIC', bookingReportPdf: true }` |
| PLUS | Plus (POPULAR) | ₹2,499 | platform default − 2.5 points | `{ liveChat: true, prioritySupport: false, featuredListings: 1, analytics: 'ADVANCED', bookingReportPdf: true }` |
| PRO | Pro | ₹4,999 | platform default − 5 points | `{ liveChat: true, prioritySupport: true, featuredListings: 3, analytics: 'ADVANCED', bookingReportPdf: true }` |

- **The commission derivation** runs once, at the seed: the platform default
  is this module's own null-category `CommissionRate` row (0.15 as seeded;
  0.15 again when no row stands), so Standard seeds at 0.14, Plus at 0.125,
  Pro at 0.10 — never below 0.05. After that `ratePct` is a column on the
  plan and the editor's to set; a later change to the platform default does
  not move the plans.
- **Entitlements are copy — with one exception**, exactly as on the
  advertiser catalogue: only `liveChat` is read by a rule
  (`support/live-chat.entitlement.ts`, through `publisherPlansByTier()`),
  and `false` keeps a plan's subscribers off live chat. The rest is what the
  card promises and nothing enforces; the plan view says `enforced: false`
  and `enforcedKeys: ['liveChat']`.
- **The cycle**: MONTHLY is one month at face value; ANNUAL is twelve months
  less the policy's `annualDiscountPct` (20 as shipped). GST on what is left
  is **revenue's own tax row** — `TaxSettings.mediaGstPct`, `PATCH
  /revenue/tax`, read through `taxSettings()` by this module and by
  `packages`, so there is one configurable GST and `priceSubscription` takes
  the rates in rather than knowing them. Money is a decimal string on the
  wire, the way `packages` prices a sale.
- **An unpaid order expires after `unpaidOrderExpiryDays`** (7); the
  expiring notice goes out `reminderLeadDays` (7) before a term ends. Both
  from `settings.subscriptions.publisher` (Lot J2).

### The policy (Lot J2)

Every purchase rule is `settings.subscriptions.publisher` (`app-config`;
the table of fields, defaults and readers is in that module's README).
Read through `getSubscriptionPolicy('publisher')` on every quote,
activation and sweep — cached a minute, invalidated by the settings PUT —
so the console changes it and nothing here is a deploy. What this module
does with each field:

| Field | Here |
| --- | --- |
| `cyclesOffered`, `annualDiscountPct` | `quoteSubscriptionOrder` / `createSubscriptionOrder` (`assertCycleOffered`, `subscriptionRates`) |
| `changePolicy`, `prorateOnChange` | `resolveTerm` — the term rule below; `markSubscriptionOrderPaid` posts the credit |
| `graceDays` | `entitledSubscriptionForPublisher` / `entitledSubscriptionsForPublishers` — running, or ended within the window (`inGrace`, `graceEndsAt`); what `support` reads. **The commission resolution keeps reading `runningSubscriptionForPublisher`: a rate is what was paid for, and a grace day is a courtesy on the copy, never on the take.** |
| `trialDays` | `startSubscriptionTrial`; `mySubscription.trialAvailable` |
| `reminderLeadDays`, `unpaidOrderExpiryDays` | the daily sweep |
| `payment.walletAllowed` | `paySubscriptionOrderFromWallet` (403 `PAYMENT_METHOD_NOT_OFFERED`); `payment.gatewaysAllowed` is `payments`' to honour |
| `autoRenew.allowed` | `setMySubscriptionAutoRenew` (409) and the sweep's renewals (off: nobody is charged, the reminder is the plain line) |

### The term rule

Asked at the quote, at the order and again at payment, so what the publisher
was shown is what the activation applies:

| Running now | The bought term |
| --- | --- |
| nothing | starts now (`STARTS_NOW`) |
| the same tier, with an end | starts at that end — a renewal queues (`QUEUED_AFTER_CURRENT`) |
| the same tier, open-ended (an admin grant with no end) | refused at the quote and the order: 409 `ALREADY_ON_PLAN` "Already on this plan" |
| a different tier, `changePolicy: REPLACE_NOW` (the default) | starts now, and the running one **ends now** (`REPLACES_CURRENT`); with `prorateOnChange` the term carries `credit` — Lot K (B2): **what the running term's order actually paid** (`paidTotal`, the linked order's total) × whole days left ÷ **the term's own whole length in days** (`termDays`, never the month's), rounded **down** to the paisa and never above `paidTotal` (Pro's ₹5,898.82 monthly order, 30-day term, 16 days left: ₹3,146.03; a ₹28,308.67 annual term replaced one day in: ₹28,231.11, its total less one day's share) — posted after activation as an ADJUSTMENT credit on the publisher wallet against `platform:revenue`, keyed `subscription-proration:<orderId>`, reason "Unused days of <plan>"; **nothing** for a TRIAL term or an admin grant with no order (a free term earns no credit), for an open-ended term, or under a whole day |
| a different tier, `changePolicy: QUEUE_AFTER_TERM` | starts at the running term's end, like a same-tier renewal (`QUEUED_AFTER_CURRENT`); refused 409 `ALREADY_ON_PLAN` when that term has no end |

`endsAt = startsAt + months`, a 31st rolling back inside a short month.
`assertSubscriptionOrderActivatable(order, now)` is the rule's refusal
alone, exported for every door that debits before it activates (Lot J2, b):
this module's `/pay` asks it before `move()`, and `payments` asks it at
capture before the wallet debit, so a plan that cannot start is never paid
for.

### Paying, and the activation

`POST /subscription-orders/:id/pay` is the publisher's own door — not an
admin's acting as them; ops record an offline payment instead. It is the
twin of the advertiser's package debit through the `wallets` port: the
publisher's wallet − / `platform:revenue` +, a `PACKAGE_DEBIT` entry under a
`PACKAGE_SPEND` transaction, keyed `subscription-debit:<orderId>` so a double
tap is one movement. Refused **402 `INSUFFICIENT_FUNDS`** when the wallet's
**withdrawable** balance is short — money inside its clearing window, held,
or reserved for a withdrawal cannot buy a plan — and again inside the
movement's own transaction (`requireFunds`). The term rule is checked
**before** the wallet, so an order that cannot activate is never charged.

`markSubscriptionOrderPaid(id, { method, reference, term?, autoRenew? }, now)`
is the activation and the payments lane's door (with
`findSubscriptionOrder`, `assertMayPaySubscriptionOrder`,
`assertSubscriptionOrderPayable`, `assertSubscriptionOrderActivatable`): one
transaction in which the order becomes PAID and linked, the
`PublisherSubscription` is created (source `SELF_SERVICE`, `ratePct` and
`pricePerMonth` copied from the order) and a different-tier subscription
still running ends now. **Idempotent** — a second call on a PAID order
returns it unchanged, and the transaction re-reads the order so a race
activates once. The publisher is told (`SUBSCRIPTION_ACTIVATED`, in-app +
EMAIL + PUSH; a trial's copy says it is one). Lot J2: `term` may be handed
in (the sweep's renewal starts when the old term ended, not at "now") and
`autoRenew` carries the flag onto a renewed term; the proration credit,
when the term carries one, is posted after the activation, best-effort and
logged for finance if it cannot be.

### The daily sweep

`jobs/publisher-subscription.job.ts` (hourly interval, one run per Indian
day) hands `runPublisherSubscriptionSweep` four duties, every window from
the policy (Lot J2): the `SUBSCRIPTION_EXPIRING` notice `reminderLeadDays`
before `endsAt`, **once per subscription** — the marker is the in-app row
the notice writes (the subscription id and the title), read back through
`noticeSent`, so no schema and no second send — whose `renewal` line says
"renews from your wallet on <date> for ₹<total>" when the row's
`autoRenew` and the policy's `autoRenew.allowed` are both on, and the plain
"renew in the app" line otherwise; **the renewals** (below);
`SUBSCRIPTION_ENDED` on the day a term lapses, skipped when another term of
the publisher's is in force at that moment (a queued renewal, a replacement,
a renewal this run just bought — nothing ended for them); and every
PENDING_PAYMENT order older than `unpaidOrderExpiryDays` becomes EXPIRED.

**Auto-renew (Lot J2, 6).** While the policy allows it, every subscription
that lapsed inside the window with `autoRenew` on and no successor in force
— **never a TRIAL row** (Lot K, B2: a trial is bought, not extended; its
reminder says so and the renewal loop skips it) — is renewed: the next order on the same tier and the cycle it was bought on
(the first offered cycle if that one is no longer offered), priced at
today's catalogue, `startsAt` = the ended term's `endsAt`; the wallet's
**withdrawable** balance asked for the total; the same keyed debit and
`markSubscriptionOrderPaid` every wallet door makes, with the term handed
in and the flag carried forward; `SUBSCRIPTION_RENEWED` (EMAIL + PUSH +
in-app). With the wallet short — or the plan retired — `SUBSCRIPTION_RENEWAL_FAILED`
once (the in-app row is the marker) with the shortfall; the flag stays on
and the row lapses into grace like any other. **Never twice**: the order
queued at that `endsAt` (`findOrderStartingAt`) is found before one is
minted — PAID means done, PENDING_PAYMENT is retried against the wallet —
and the debit is keyed on the order. With `autoRenew.allowed` off nobody
is charged, whatever a row's flag says. **The retry (Lot K, B2)**: before
the balance is read, `renewSubscription` asks `debitPosted` whether the
keyed debit (`subscription-debit:<orderId>`) is already on the ledger — a
run that debited and then died before activation has paid for the term,
so the next run skips the wallet (a balance that debit just emptied must
not fail it) and completes the activation instead of sending
`SUBSCRIPTION_RENEWAL_FAILED`.

**The day key (Lot K, B2).** The job writes its once-per-Indian-day key
**after** the sweep returns, not before it runs: a sweep that throws leaves
no key and is retried on the next hourly tick the same day; the tick lock
keeps two ticks off the sweep meanwhile.

### Owned Prisma entities (Lot J)

`PublisherSubscriptionPlan` (`tier` unique) and `PublisherSubscriptionOrder`
(`reference` unique, `subscriptionId` unique → `PublisherSubscription`);
`PublisherSubscription.source`. Prisma only in
`prisma-publisher-plans.repository.ts`, which also **reads** `Notification`
rows for the sweep's marker and, Lot K (B2), `LedgerTransaction` by its
idempotency key for the renewal's debit check — never writes either.

### Not here

The tax invoice for a paid order: `invoices` issues for campaigns and
package sales and its `Invoice` names an advertiser, so a publisher's
receipt is a schema change for a later lot. The reference is minted the way
`packages` and `payments` mint theirs rather than through `identifiers`,
whose series are the `PartyType` enum — a `SUBSCRIPTION_ORDER` value there
is the same later change.

## Setup

```
npm run seed:revenue
```

Seeds a platform commission, the four fees and the GST default. Existing active
rates are left alone — replacing a live commission rate is ops's decision, not a
seed script's.

## Not in this module

The cart and checkout, invoicing, GST return formats, and the payment gateway.
This computes what those will charge; it collects nothing.
