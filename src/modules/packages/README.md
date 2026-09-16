# packages

DR 02's four-step sale: an agent (or the advertiser) chooses a plan, confirms
the cycle and add-ons, a payment link goes out, and the activation receipt
comes back. A subscription that sits **beside** the campaigns an advertiser
books, not inside them — a commercial record with a term, never a gate.

## Routes

All under `/api/v1/packages`, `authenticate` at the router; who may act on a
sale is decided per sale in the service (`assertMayAct`), not per route.

| Method | Path | Who | What |
| --- | --- | --- | --- |
| GET | `/catalogue` (`?includeInactive=true`) | any | the three plans and the add-ons, seeded on first read; every row carries `isActive` and `sortOrder` (E7-3); the flag lists the retired rows too and is honoured for ADMIN only — the agent app's active-only read is unchanged without it |
| PATCH | `/catalogue/plans/:tier { name?, pricePerMonth?, description?, isPopular?, entitlements?, isActive?, sortOrder? }` | ADMIN | Lot D (Q94): the editor; audited `PACKAGE_PLAN_UPDATED` with the diff |
| POST | `/catalogue/add-ons { code, name, pricePerMonth, description?, sortOrder? }` | ADMIN | a new add-on (**201**); 409 on a code that exists; audited `PACKAGE_ADDON_CREATED` |
| PATCH | `/catalogue/add-ons/:code { name?, pricePerMonth?, description?, isActive?, sortOrder? }` | ADMIN | edit, retire, or (E7-3) set `isActive` back to true; audited `PACKAGE_ADDON_UPDATED` |
| POST | `/quote` (`?advertiserId=` for an agent) | any | what a choice costs, from the catalogue; Lot J2: GST from revenue's tax row and the discount from the advertiser policy, `policy` beside the money (`{ cyclesOffered, annualDiscountPct, changePolicy, prorateOnChange, graceDays, trialDays (this tier), payment, autoRenewAllowed }`); 400 `CYCLE_NOT_OFFERED` for a cycle the policy does not offer. Lot K (B2): `term: { rule, startsAt, endsAt, replaces, prorationAmount } \| null` — the rule the activation would apply (`resolveSaleTerm`), like the publisher quote, so no phone predicts it: for the advertiser in the session, or the one an agent names with `?advertiserId=` and holds (403 otherwise, the same check `GET /active` makes; an admin may name anyone); null when nobody is in scope |
| GET | `/active?advertiserId=` | the advertiser, their agent, ADMIN | the live plan — Lot J2: `{ ...plan (or saleId: null), trialAvailable: { tier: days }, policy }`; the plan carries `paidMethod` (TRIAL for a trial) and `autoRenew`; Lot K (B2): `grace: { tier, packageName, endsAt, until } \| null` — with nothing running, the term that ended inside the policy's `graceDays` and is still honoured (`until` = `endsAt + graceDays`); null while one runs, past the window, or with `graceDays` 0 |
| PATCH | `/active { autoRenew }` | the advertiser themselves | Lot J2 (6): the flag on the running sale; 409 `AUTO_RENEW_NOT_OFFERED` "Auto-renew is not offered" while the policy's `autoRenew.allowed` is false; 404 with nothing running; Lot K (B2): 409 `AUTO_RENEW_NOT_OFFERED` "A trial does not renew - buy the plan" when the running sale is a TRIAL, whatever the policy says |
| POST | `/sales/trial { tier }` | the advertiser themselves | Lot J2 (5): a free trial — **201**, a sale ACTIVE at once with total 0, `paidMethod` TRIAL, `endsAt = now + trialDays`, no agent, no incentive, no invoice; 409 `TRIAL_NOT_OFFERED` when the tier's `trialDays` is 0, 409 `TRIAL_ALREADY_USED` once the advertiser has ever held a term (ACTIVE or EXPIRED, sold or trialled). Lot K (B2): **cannot race** — the sale is written in one transaction under `pg_advisory_xact_lock(hashtext(advertiserId))` (`repository.startTrial`, the way `wallets.move` serialises a wallet) and the "never held a term" check is asked again inside it, so two taps arriving together are one 201 and one 409 |
| GET | `/sales` | same | the book, on the list contract (shelves ACTIVE / EXPIRING / EXPIRED) |
| POST | `/sales` | advertiser or their agent | create the sale and send the link (metered) |
| GET | `/sales/:id` | same | the sale, with `agreements: [{ kind: PACKAGE_SALE, accepted, templateVersion, currentVersion, current }]` |
| POST | `/sales/:id/resend`, `/cancel` | same | |
| POST | `/sales/:id/accept-terms` | the advertiser, or their agent under a live PROFILE grant — never an admin | Lot D (Q123): the package terms, rendered server-side and recorded once per sale per version |
| POST | `/sales/:id/pay` | the advertiser only | wallet payment; 403 `AGREEMENT_REQUIRED` until the terms are accepted on the live version; Lot J2: 403 `PAYMENT_METHOD_NOT_OFFERED` when the policy's `payment.walletAllowed` is false |
| POST | `/sales/:id/record-payment` | ADMIN | money that arrived outside ADX; the same 403 |

Lot C (Q110): the third door is `POST /payments/intents { packageSaleId,
gateway }` in `payments`, which applies the same ownership, payability and
terms rules through this module's exports and, on capture, pays the sale out
of the wallet the gateway just credited and marks it paid with method
`GATEWAY` (`paidReference` = the PAY- reference).

`GET /p/:token` — the payment link's public view — is mounted at the
application root, like the campaign scan redirect.

## Owned Prisma entities

- `AdvertiserPackage` — a plan in the catalogue: `tier` (unique), `name`,
  `pricePerMonth`, `entitlements` (JSON), `isActive`, `sortOrder`.
- `PackageAddOn` — an extra, global rather than per plan: `code` (unique).
- `PackageSale`, `PackageSaleLine` — one sale and the receipt's lines.

`AgentIncentive` and `AgentProfile.tier` are read for the "₹2,500 comm." on
the card and never written here (`payouts.recordIncentive` writes the row).

## Invariants

- **A sale keeps its snapshot.** `tier`, `packageName`, `pricePerMonth`, the
  lines and the totals are copies made at the sale, never joins. The
  catalogue editor (Lot D, Q94) therefore only ever changes the *next* sale;
  nothing already sold is re-rated, and a retired plan or add-on stays on
  the receipts that carried it.
- **Entitlements are copy — with one exception.** Named on the plan card,
  returned by the API, and read by no rule, save `liveChat`: since Lot I
  `support.live-chat` (`support/live-chat.entitlement.ts`, `planAllowsLiveChat`)
  reads `entitlements.liveChat`, and `false` keeps a plan's advertisers off
  live chat. The frames otherwise name promises nothing enforces, and a
  screen that looks like configuration and changes nothing is worse than a
  plain promise, so the editor is where the copy is written, not where a
  gate appears. `activePackage` says `enforced: false` (the JSON as a whole
  is not a gate) and `enforcedKeys: ['liveChat']` (the keys that are);
  `activePackagesForAdvertisers` is the same read for a set, two queries
  for the page rather than two per row (I4-B).
- **The terms come before the money (Lot D, Q123).** Both payment doors ask
  `assertSaleTermsAccepted` — an acceptance of the live `PACKAGE_SALE`
  version anchored on this sale — before the wallet is touched or an offline
  payment is recorded. The click is the advertiser's, or their agent's under
  a live grant; the row always names the advertiser as the party and is
  rendered from the template and the sale (`renderPackageTerms`), never from
  client text. A cancelled or expired sale has no terms left to accept.
- **One charge per sale.** `assertPayable` runs before the wallet, `markPaid`
  is idempotent, the term runs from payment; a renewal is the daily sweep's
  next sale, paid once by its own key (Lot J2, below).
- **Only the advertiser pays from the wallet.** Not their agent, not an admin
  acting as them; ops record an offline payment instead.

## The policy (Lot J2)

Every purchase rule is `settings.subscriptions.advertiser` (`app-config`;
the table of fields, defaults and readers is in that module's README),
read through `getSubscriptionPolicy('advertiser')` on every quote,
activation and sweep. Every default is today's behaviour. **GST is not a
policy field**: the quote reads `revenue.taxSettings()` — the tax row
`PATCH /revenue/tax` sets — so there is one configurable GST, and
`priceSale` takes the rates in.

| Field | Here |
| --- | --- |
| `cyclesOffered`, `annualDiscountPct` | `quote` (`assertCycleOffered`, the rates) |
| `changePolicy`, `prorateOnChange` | `resolveSaleTerm` at activation — the term rule below |
| `graceDays` | `entitledPackageForAdvertiser` / `entitledPackagesForAdvertisers` — the live sale, or one that ended (ACTIVE or EXPIRED) within the window (`inGrace`, `graceEndsAt`); what `support`'s live-chat door reads |
| `trialDays` | `startPackageTrial`; `activePackageWithOptions.trialAvailable` |
| `reminderLeadDays` | the daily renewal sweep's reminder |
| `payment.walletAllowed` | `assertWalletPaymentOffered`, asked by `/sales/:id/pay`; `payment.gatewaysAllowed` is `payments`' to honour |
| `autoRenew.allowed` | `setActivePackageAutoRenew` (409) and the sweep (off: nobody is charged) |

### The term rule at activation

`markPaid` asks `resolveSaleTerm(sale, now)` unless a term is handed in:

| Running now (started, not run out) | The paid sale's term |
| --- | --- |
| nothing | starts now |
| the same tier | starts at its end — a same-tier purchase mid-term is a renewal, never a second overlapping term |
| a different tier, `REPLACE_NOW` (the default) | starts now; the running sale is EXPIRED at once with `endsAt = now`; with `prorateOnChange` its unused days come back as an ADJUSTMENT credit on the advertiser wallet against `platform:revenue` — Lot K (B2): **what the sale actually paid** (its `total`) × whole days left ÷ **the term's own whole length in days** (never the month's), rounded down to the paisa and never above the total (Starter's ₹11,798.82 monthly sale, 31-day term, 16 days left: ₹6,089.71; a ₹113,268.67 annual term replaced one day in: ₹112,958.34), keyed `package-proration:<saleId>`, reason "Unused days of <plan>"; **nothing** for a TRIAL (a free term earns no credit) |
| a different tier, `QUEUE_AFTER_TERM` | starts at the running term's end; nothing ends early, nothing is credited |

A sale queued after the current one is ACTIVE with a start still ahead;
`findActiveSale` reads only terms that have started, so the live plan is
the live plan until then.

### The daily renewal sweep (Lot J2, 6)

`jobs/package-renewal.job.ts` (hourly interval, one run per Indian day,
heartbeat `package-renewal`) hands `runPackageRenewals` two duties: an
in-app reminder `reminderLeadDays` before a sale ends, once per sale (the
row it writes is the marker) — "renews from your wallet on <date> for
₹<total>" when the sale's `autoRenew` and the policy's `autoRenew.allowed`
are both on, "renewing is a new sale" otherwise (a TRIAL's says a trial
does not renew); and, while the policy allows it, the renewal of every
sale that lapsed inside the window with `autoRenew` on and no successor
in force — **never a TRIAL sale** (Lot K, B2: a trial is bought, not
extended; the renewal loop skips it): the next sale on the same tier,
add-ons and cycle (the first offered cycle if that one is no longer
offered), priced at today's catalogue, PENDING_PAYMENT with `startsAt` =
the ended term's `endsAt`, no agent and so no incentive; the booking gates
asked (`advertisers.bookingEligibility`); paid through `payForPackage`
(keyed on the sale) and the same `markPaid`, the term handed in and the
flag carried forward; `SUBSCRIPTION_RENEWED`. With the wallet short — or a
gate shut, or the plan retired — `SUBSCRIPTION_RENEWAL_FAILED` once with
the shortfall; the flag stays on and the term lapses into grace like any
other. **Never twice**: the sale queued at that `endsAt`
(`findSaleStartingAt`) is found before one is minted — ACTIVE means done,
PENDING_PAYMENT is retried against the wallet. The five-minute expiry in
`campaign-lifecycle.job.ts` still flips a lapsed sale to EXPIRED, but sends
no "renewing is a new sale" notice for one the sweep will renew. **The
package terms are not asked again on a renewal**: the advertiser accepted
them on the sale they switched auto-renew on, and a renewal is that sale's
next term, not a new choice.

**The day key (Lot K, B2).** The job writes its once-per-Indian-day key
**after** the sweep returns, not before it runs: a sweep that throws leaves
no key and is retried on the next hourly tick the same day; the tick lock
keeps two ticks off the sweep meanwhile.

## Dependencies

- `agreements` — `currentTemplate`, `recordAcceptance`,
  `transactionAcceptance` for the terms (Lot D).
- `access-grants` — `liveGrantFor`, whether an agent may accept the terms.
- `advertisers` — `payForPackage`, `assertNotSuspended`, `getAdvertiserForUser`; Lot J2: `bookingEligibility` for the renewal sweep.
- `app-config` — `getSubscriptionPolicy('advertiser')` (Lot J2).
- `revenue` — `taxSettings` (the one GST), `assertCycleOffered`, `fractionToPercent`, `policyView`, `prorationAmount` (Lot J2).
- `wallets` — `ensureWallet`, `move` for the proration credit (Lot J2).
- `agents` — `findAgentProfile`.
- `notifications`, `payouts` (the PACKAGE_SOLD incentive), `visits` (the
  field visit a sale was made on), `shared/email`, `shared/sms`.
- `invoices` reaches back through `invoicing.port.ts` (Lot B, Q13) for the
  receipt; unregistered, the sale still activates.
