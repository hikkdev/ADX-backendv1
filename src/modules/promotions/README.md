# promotions

LM-1 (27 Sep 2026) — the placements ADX sells. The owner: *"I will sell them
to advertisers. For example: someone wants to promote an event or some
advertiser wants their space advertised above all similar listings."*

Two products, one module:

- **Display ads** in **ad slots** (the listing page sidebar, the Explore and
  home banners, the advertiser app's home banner). An advertiser books a slot
  for dates, uploads artwork, pays; ADX reviews the artwork; it runs, rotating
  with the other ads in the slot, labelled **"Ad"**; the buyer sees
  impressions and clicks. Rejected → refunded in full.
- **Sponsored listings** ("boosts"). A publisher pays to have their own live
  listing shown first — `SEARCH_TOP` (top of the search results it matches)
  and/or `SIMILAR_TOP` (top of the "Similar listing" row), labelled
  **"Sponsored"**. No review: the listing is already approved.

## The inventory — defaults ADX edits in the console

Seeded once by `prisma/seed.ts` (create-only; an edited row is never
overwritten) and edited on the desk (Growth › Promotions). **These figures
are defaults, not rules** — every rate, limit and minimum is ADX's to change.

| Slot key | Where | Artwork spec | ₹/day | At once |
| --- | --- | --- | --- | --- |
| `WEB_LISTING_SIDEBAR` | website listing page, below the booking card | `AD_SIDEBAR` | 1,500 | 3 |
| `WEB_EXPLORE_BANNER` | website Explore page | `AD_BANNER` | 2,500 | 2 |
| `WEB_HOME_BANNER` | website home page | `AD_BANNER` | 3,000 | 2 |
| `APP_ADVERTISER_HOME_BANNER` | advertiser app home | `PROMO_WIDE` | 2,000 | 3 |

| Placement | ₹/day | At once (per city + category) |
| --- | --- | --- |
| `SEARCH_TOP` | 800 | 2 |
| `SIMILAR_TOP` | 400 | 3 |

The artwork specs are `media`'s (`MEDIA_SPECS`, the list `GET /media/specs`
answers) — this module keeps no copy, so a slot's `specDetail` and the
upload check can never disagree with the library.

## Price and capacity

- **Price** — flat rate per day × days (a boost sums its placements' rates),
  + GST at `revenue.taxSettings().mediaGstPct` (18% until ADX changes it),
  each to the paisa. A booking keeps the rate it was quoted; an ad is
  re-priced at the slot's current rate when it is submitted.
- **Dates** — whole UTC days, `startDate`/`endDate` the first and LAST day at
  00:00Z (the AV-1 convention). Today may be the start; at most 186 days long
  and 365 days ahead.
- **Capacity, per day** (AV-1's rule: the busiest day decides) — an ad slot's
  `maxConcurrent`; a boost placement's `maxConcurrent` in the listing's city
  (its `cityId`, else its spelling) and category. A booking holds its days
  from PENDING_PAYMENT (for its hour) to its end. Submitting past the limit is
  **409 `SLOT_FULL` `{ fullDays: ['2026-10-12', …] }`**; a boost is **409
  `PLACEMENT_FULL` `{ full: [...], fullByPlacement: { SEARCH_TOP: [...],
  SIMILAR_TOP: [...] } }`**. The count is re-read after the write: two buyers
  racing for the last place do not both keep it.

## Lifecycle

```
ad:    DRAFT → PENDING_PAYMENT → PENDING_REVIEW → SCHEDULED → LIVE → ENDED
                                     ↘ REJECTED (refunded in full)
boost:         PENDING_PAYMENT → SCHEDULED → LIVE → ENDED
any:   → CANCELLED — before its start: refunded in full; once started: stops, nothing refunded
```

- Unpaid for **60 minutes** → CANCELLED, its days freed.
- An ad paid for but not reviewed before its last day → CANCELLED, refunded.
- Approving on or after the first day (or paying a boost that starts today)
  goes straight to LIVE.
- The job `src/jobs/promotions.job.ts` (every 5 min, Redis lock skipped when
  Redis is down) runs `runPromotionsLifecycle`; every transition is guarded on
  the status it leaves.
- The buyer hears on approve / reject / live / ended / stopped:
  `notifications` events `PROMOTION_APPROVED|REJECTED|LIVE|ENDED|CANCELLED`
  (push + email templates, the in-app row beside them).

## Money

- **Wallet**: an ad from the advertiser wallet, a boost from the publisher
  wallet (the one earnings land in). `PROMOTION_DEBIT` under ledger
  `PROMOTION_SPEND`, wallet − / `platform:revenue` +, keyed
  `promotion-debit:ad:<id>` (a rejected-and-resubmitted ad is a second round,
  keyed apart) / `promotion-debit:boost:<id>`. Paid from settled money only —
  goodwill is left out of the check (402 `INSUFFICIENT_FUNDS` with the
  shortfall), so a full refund cannot turn goodwill into cash.
- **Refunds**: `REFUND`, wallet + / `platform:revenue` −, keyed on the payment
  undone.
- **Gateway**: `POST /payments/intents { adBookingId | listingBoostId, gateway }`.
  `payments` asks this module (through its `PromotionPaymentsPort`, wired in
  bootstrap) to guard and price the intent, credits the payer's wallet on
  capture, then this module settles the booking out of that balance — the
  same keyed debit, so the wallet route, a second confirm and a replayed
  webhook are one charge. A booking that lapsed while the buyer was on the
  gateway page is refused; the money stays spendable (Q118).
- **Invoice**: a paid ad gets a tax invoice (proforma until the entity has a
  GSTIN) through `invoices.issueInvoiceForAdvertising` — one line "Advertising
  on ADX — {slot}, {dates} ({ADB-…})", SAC 998366 — and a credit note when it
  is refunded. **A boost is not invoiced**: an Invoice names an advertiser,
  and a publisher's receipt is a later lot (the same gap a plan order has).

## Routes

Buyer reads (signed in or not):

| Method | Path | Answer |
| --- | --- | --- |
| GET | `/promotions/slots` | `[{ key, label, description, surfaces, spec, specDetail, ratePerDay, minDays, maxConcurrent }]` (active) |
| GET | `/promotions/slots/:key/availability?from&to` | `{ slotKey, maxConcurrent, days: [{ date, booked, left }], nextFreeDate }` (≤ 186 days; `nextFreeDate` looks up to 186 days past `to`) |
| GET | `/promotions/boost/placements` | `[{ placement, label, ratePerDay, minDays, maxConcurrent }]` |
| GET | `/promotions/boost/availability?listingId&from&to&placements=` | `{ listingId, placements: [{ placement, maxConcurrent, days: [{ date, booked, left }] }] }` in the listing's city + category |

Advertiser (the account's own advertiser; its agent under the act rule — a
write needs a live grant; ADX on behalf naming `advertiserId`):

| Method | Path | What |
| --- | --- | --- |
| POST | `/promotions/ads` | `{ slotKey, advertiserId?, title, headline?, ctaLabel?, targetUrl, cityIds?, startDate, endDate }` → 201 DRAFT with its quote and `fullDays`. `cityIds` take a City id or a slug (what `/app/geo/cities` answers) and are stored as City ids (400 on an unknown one); the view answers `cities: [{ id, slug, name }]` |
| PATCH | `/promotions/ads/:id` | any field (DRAFT / REJECTED; a REJECTED one goes back to DRAFT). `slotKey` only while DRAFT — re-priced; artwork of another spec is let go |
| POST | `/promotions/ads/:id/artwork` | multipart `file` (+ `altText`) → checked by `media.storeMediaFile` against the slot's spec (400 `INVALID_IMAGE` naming each problem), a MediaAsset with `ownerAdvertiserId`; the old one archived |
| POST | `/promotions/ads/:id/submit` | DRAFT → PENDING_PAYMENT (409 `ARTWORK_REQUIRED`, 409 `SLOT_FULL`) |
| POST | `/promotions/ads/:id/pay-from-wallet` | → PENDING_REVIEW; idempotent |
| POST | `/promotions/ads/:id/cancel` | `{ reason? }` |
| GET | `/promotions/ads/mine?advertiserId&status` | the buyer's ads |
| GET | `/promotions/ads/:id` | the view + `stats: { impressions, clicks, ctr, byDay[] }`, `slot`, `media`, `quote`, `payBy` |

Publisher (own listing only; ADX may act):

| Method | Path | What |
| --- | --- | --- |
| GET | `/promotions/boost/quote?listingId&placements&startDate&endDate` | `{ days, ratePerDay: { SEARCH_TOP, SIMILAR_TOP }, subtotal, gstPct, gstAmount, total, full, fullByPlacement }` |
| POST | `/promotions/boosts` | `{ listingId, placements, startDate, endDate }` → 201 PENDING_PAYMENT (409 `PLACEMENT_FULL`) |
| POST | `/promotions/boosts/:id/pay-from-wallet` | → SCHEDULED / LIVE; idempotent |
| POST | `/promotions/boosts/:id/cancel` | `{ reason? }` |
| GET | `/promotions/boosts/mine`, `/promotions/boosts/:id` | the publisher's boosts (+ stats) |

Desk (ADMIN; `growth.view` read, `growth.edit` slots/placements/prices and
boost cancellation, `content.approve` artwork):
`GET/POST /promotions/admin/slots`, `PATCH /promotions/admin/slots/:idOrKey`,
`GET /promotions/admin/placements`, `PATCH /promotions/admin/placements/:placement`,
`GET /promotions/admin/ads?status&slotKey&q&sort&page&pageSize` (the list
contract, counts per status), `GET /promotions/admin/ads/:id`,
`POST /promotions/admin/ads/:id/approve { note? }`,
`POST /promotions/admin/ads/:id/reject { reason }` (refund + credit note),
`GET /promotions/admin/boosts?status&placement&q…`, `GET /promotions/admin/boosts/:id`,
`POST /promotions/admin/boosts/:id/cancel { reason, refund }`,
`GET /promotions/admin/stats?from&to` (totals, revenue, by slot / placement,
top ads; the last 30 days by default). Every write is audited.

Events: `POST /app/promotions/events { events: [{ kind, adBookingId | boostId, surface }] }`
(≤ 50; public; 120/min per IP; 202 `{ counted, dropped }`). An event for
anything not running today is dropped. `PromotionStat`'s unique index does
not bite on the NULL half of the pair, so the counter increments or creates
and every read sums `count`.

## Sponsored in browse

`listings` declares a `SponsoredPort`; `registerPromotionsModule()` fills it
(bootstrap). Page one of `GET /listings/browse` in the default order (no
`near`, `sort=NEWEST`) puts up to `SEARCH_TOP.maxConcurrent` running boosts
first — only those whose listing passes the page's own filters — marked
`sponsored: true, boostId`, lifted out of their organic place on that page
(page one may therefore carry up to that many extra cards). `?similarTo=` and
`GET /listings/:id/similar` do the same with `SIMILAR_TOP` from the similar
set. Cached 30 s per placement; cleared on a desk or buyer change.

## Switches

`promotions.ads`, `promotions.boosts` (KILL_SWITCH, launch on): off, the buyer
routes answer 503 `FEATURE_OFF`, the sponsored port answers nothing and
`runningAdsForSlot` answers no ads. `promotions.desk` covers the desk, the
counter and the job.

## Exports

`promotionRouter`, `appPromotionRouter`, `registerPromotionsModule`,
`runPromotionsLifecycle`, the payment targets (`adPaymentTarget`,
`settleAdPayment`, `boostPaymentTarget`, `settleBoostPayment`),
`runningAdsForSlot`, `listActiveSlots`, `listAllSlots`, the defaults.

## Dependencies

`advertisers` (act rule, booking gates, the advertiser), `publishers` (the
publisher of a session), `wallets` (`move`, `snapshot`), `revenue` (GST),
`invoices` (the advertising line), `media` (specs, `storeMediaFile`),
`uploads` (the multipart door), `identifiers` (ADB-/BST-), `notifications`,
`feature-flags`, `listings` (the port). `payments` reaches this module only
through its port.
