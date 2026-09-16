# campaigns

DR 02's booking flow: a brief becomes a cart, the cart becomes a booking, the
booking becomes orders. The header of `index.ts` says what this module owns
and what it deliberately does not — money is `advertisers`' and `wallets`',
the arithmetic is `revenue`'s, fulfilment is `orders`'.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET/POST /campaigns`, `GET/PATCH/DELETE /campaigns/:id` | advertiser, agent, admin | the draft and its seventeen steps; E6: `GET /campaigns/:id` carries `refund: { id, amount, status, reason, releasedAt } \| null` from the `CampaignRefund` the cancel recorded; E7-2: each spot carries `reviewed: boolean` and `reviewId \| null` through `SpotReviewPort` (`spot-review.port.ts`, filled by `reviews` from bootstrap — this module cannot import `reviews` back; unregistered, every spot reads unreviewed); E11-2: `GET /campaigns/:id` carries `landingPage: { id, slug, status, url, publishedAt } \| null` — one narrow read through the `landingPage` relation (`landingPageSummary`), never the blocks; T-B: the detail also carries `city` (`targetLocation`) and `spotCount`, the list row's two derived columns — `campaignDetailView` in the controller is the one view |
| `GET /campaigns/:id/inventory`, `PUT /campaigns/:id/spots` | same | the match and the cart; T-B: the cart write answers the same detail view `GET /campaigns/:id` answers |
| `GET /campaigns/content-categories` | same | Lot D (Q138): the seeded content categories the wizard asks about (`contentCategoryId` on the patch) |
| `POST/DELETE /campaigns/:id/creatives[/:creativeId]` | same | artwork; an upload is a submission (Lot D, Q44) — see below; T-B: the upload answers the desk's row (the artwork with its `campaign` and `spot`), the same read `GET /campaigns/creatives/:creativeId` makes |
| `POST /campaigns/:id/creatives/:creativeId/accept`, `/request-changes { note }` | advertiser or their agent — never an admin | Lot D (Q120): the answer to ADX-designed artwork |
| `GET /campaigns/creatives/review-queue?status=&kind=&flagged=&resubmitted=&q=&sort=&page=&pageSize=` | ADMIN | the desk, on the list contract with status counts; E7-2: `counts` also carries `flagged`, `static`, `video`, `resubmitted`, counted over the same scope as the histogram |
| `GET /campaigns/creatives/:creativeId` | ADMIN | one artwork with its campaign, spot, checks and flags |
| `PATCH /campaigns/:id/creatives/:creativeId/review { decision, note?, checks? }` | ADMIN | APPROVED \| REJECTED \| CHANGES_REQUESTED; a note is required unless approved; audited `CREATIVE_REVIEWED` |
| `POST /campaigns/creatives/review { creativeIds, decision, note? }` | ADMIN | the same decision across up to fifty; one audit row and notification each |
| `GET /campaigns/:id/tracking-codes/:code/image.png?size=` | same | Lot D (Q139): the code's QR, drawn through `qr`, for the artwork to embed |
| `POST /t/:code/e { type: VIEW\|CTA_CLICK\|FORM_SUBMIT, ctaLabel? }` | public, metered by IP | Lot D (Q7): an interaction on the landing page |
| `POST /campaigns/:id/landing-page/generate` | advertiser, their agent, admin (`assertMayAct`) | Lot E (Q7/Q106): drafts the five blocks from the brief through `shared/ai`; **201**; 409 on a PUBLISHED page; 503 `AI_UNAVAILABLE` / 502 `AI_FAILED`; E7-2: 429 `QUOTA_EXHAUSTED` under `ai`'s landing-page quota, an `AiGeneration` row per draft; audited `LANDING_PAGE_GENERATED` with vendor and model; E11-2: answers `url: /p/:slug` beside the blocks, as every builder read does (`withLandingUrl`) |
| `GET /campaigns/:id/landing-page` | same | the page, with `url: /p/:slug` |
| `PATCH /campaigns/:id/landing-page { blocks?, theme? }` | same | an edit is the next `version`, live page or not; audited `LANDING_PAGE_UPDATED`; E11-2: answers `url` beside the blocks |
| `POST /campaigns/:id/landing-page/publish` | same | PUBLISHED with `publishedAt`; needs a hero block; audited `LANDING_PAGE_PUBLISHED` |
| `GET /campaigns/landing-pages?status=&page=&pageSize=` | ADMIN | the review list, on the list contract with status counts, each row beside its campaign — E7-2 (Lot E addendum 2): `LandingPage.campaign` is a relation now, so the campaign is the same query |
| `POST /campaigns/:id/landing-page/unpublish { reason }` | ADMIN | back to DRAFT; audited `LANDING_PAGE_UNPUBLISHED`; the campaign's creator told why; T-B: answers the review list's row — the page with its `campaign` and advertiser (`findLandingPageView`, the list's include) |
| `GET /p/:slug` | public | the page itself, rendered server-side — one document, no external asset; a slug nothing PUBLISHED answers to falls through to the package payment link on the same prefix |
| `GET /campaigns/:id/review`, `POST /campaigns/:id/authorize`, `POST /campaigns/:id/cancel` | same | the bill, the booking, the cancel; E6: the authorise answers `invoice: { id, number, kind, status } \| null` — what `invoices` issued through the port inside the call, null when it could not (the desk's `POST /finance/invoices/issue` catches up) |
| `POST /campaigns/:id/submit-for-payment` | ADMIN or the campaign's agent | Lot C (Q88): the finished brief sent to the advertiser to pay — PENDING_PAYMENT, the spots held 24 h, the advertiser told; audited `CAMPAIGN_SUBMITTED_FOR_PAYMENT`; answers `{ campaign, review, reservedUntil }` — T-B: `campaign` is the detail view `GET /campaigns/:id` answers |
| `POST /campaigns/:id/authorize { confirm, approvedByUserId? }` | ADMIN | Lot C (Q88): authorising on the advertiser's behalf out of their wallet — the reference typed back, a second admin at or above `finance.opsAuthoriseThreshold` (409 `FOUR_EYES`); audited `CAMPAIGN_AUTHORIZED_ON_BEHALF` |
| `GET /campaigns/analytics?days=`, `GET /campaigns/:id/analytics?days=`, tracking codes and redemptions | same | what the campaign did; E11-2: the per-campaign `spend` carries `onTrack: boolean \| null` (spend to date no faster than what was committed — the portfolio's own test; null with nothing committed), and both reads carry `comparison: { window: { days, from, to, previousFrom, previousTo }, totalReach, clickRate, budgetSpent }` — each metric `{ previous, deltaPct, provenance, basis } \| null`, the current window (`days`, default 7, capped at 90, ending today) against the window of the same length immediately before it, both folded from the stored `CampaignDailyMetric` rows in one query (`dailyMetricsFor`); `previous` is that window's value (reach summed, click rate as clicks of scans, spend as money), `deltaPct` one decimal and null when the previous value was zero; the metric is null when the previous window has no rows (or none that carry it — no stated reach, no scans), so a first week prints no delta; provenance MEASURED for spend and the click rate, ESTIMATED for reach; the portfolio reads the rows once across every non-draft campaign it counts |
| `GET /finance/campaign-refunds?status=&campaignId=&page=&pageSize=` | ADMIN | the refund desk's campaign queue, on the list contract (Lot B); E7-3: `campaignId` narrows it to one campaign, the chips counting that filter minus the status facet; E10-1: every row (and the single read) carries `advertiser { id, displayId, name } \| null` beside `campaign`, joined through the campaign in the same second query — null when the campaign is gone |
| `POST /finance/campaign-refunds/:id/release { note? }` | ADMIN + `finance.approve` | credits the unused value back to the wallet; audited `CAMPAIGN_REFUND_RELEASED`; E6: the requester's own release or refusal answers 409 `FOUR_EYES`, the code the batches use |
| `POST /finance/campaign-refunds/:id/reject { reason }` | ADMIN + `finance.approve` | refuses it; audited `CAMPAIGN_REFUND_REJECTED` |

## The refund desk (Lot B, Q41 — `refunds/`)

A campaign cancelled **before** it starts has its hold released; the money
never left. One cancelled **after** capture owes the advertiser its unused
days — whole undelivered days, today included, at each live spot's rate — and
`cancelCampaign` records that as a PENDING `CampaignRefund` rather than
crediting anything. One per campaign: `campaignId` is unique, so a second
cancel finds the first record. Nothing is recorded when nothing is owed.

Finance decides. Releasing goes through `advertisers.creditCampaignRefund`,
which posts the REFUND legs (wallet + / `platform:payables` −, keyed on the
refund) and the statement line in one movement; the record then carries who
released it and which ledger transaction did. Refusing keeps the reason on the
record and moves nothing. `releasedByUserId` / `releasedAt` name the decider
on both outcomes.

Four eyes: the person who requested the refund — whoever cancelled the
campaign — may not release or refuse it. A cancel with no person behind it (a
suspension sweep) is recorded as `system`'s.

## Lot B (Q1): the assist, the visit, and whose campaign it is — package B3b

- `POST /campaigns/:id/authorize` records `CAMPAIGN_ASSIST` for `campaign.agentId`
  (the agent who ran the wizard) at their tier, `advertiserId` set, note = the
  campaign reference — once per campaign, keyed on `Campaign.assistIncentiveId`
  (unique), which is written back before the response. PENDING_VERIFICATION;
  finance releases it. The response carries `incentive: { id, amount } | null`.
  A rate that cannot be priced never fails the launch.
- `POST /campaigns { visitId? }` and `PATCH /campaigns/:id { visitId? }` name the
  field visit the campaign was made on. `visits.assertVisitOutcome` gates it —
  the actor's own visit, in progress or completed today; `null` clears it.
- `GET /campaigns` rows carry `advertiser { id, displayId, name }` for every
  caller, so the agent app's Orders tab can say whose campaign each one is.

## Lot D (Q8/Q107): several markets, behind `multi-market-campaigns`

- `PATCH /campaigns/:id { targetMarkets: string[] }` is the list; the service
  keeps `targetMarket = targetLocation = targetMarkets[0]` for every reader
  that predates it, and — the way the app's MarketArea step does — clears
  `targetLatitude`, `targetLongitude`, `targetRadiusKm` and the POIs when
  markets are set, because the matcher prefers a bounding box over a city
  whenever it can build one. A patch that still sends `targetMarket` alone
  keeps the list in step (`[market]`, or `[]` for null).
- A second market needs the flag (409 `FEATURE_OFF`, bucketed by advertiser);
  the cap is `getPlatformSettings().marketplace.maxMarketsPerCampaign` (400
  above it), enforced in the service because a Zod schema cannot read an
  async setting. Entries are trimmed and de-duplicated case-insensitively;
  each passes `pricing.assertCityAllows(market, 'demand')` — Lot V: a
  catalogued city whose rollout stage has demand off is 400 `CITY_NOT_OPEN`;
  a town the catalogue lacks passes.
- The matcher's city fallback becomes `city IN targetMarkets`
  (case-insensitive) and keeps the `targetMarket` / `targetLocation`
  fallbacks for an empty list. `reviewCampaign` asks for at least one market
  (list or single field) when the method is MARKET_OR_DMA.
- Every campaign read carries `multiMarketWarning: true` above one market —
  advisory, never a refusal, and there is no per-market creative.
- `GET /campaigns/:id/analytics` adds `byMarket` — `bySpot` folded by the
  listing's city (`{ market, spots, spend, scans, clicks }`), spots with no
  city under `null`, last.

## The city key (Lot X-B)

`Campaign.targetMarketCityId` carries the `City` row the first market
denotes — stamped by `patchDraft` whenever `targetMarket` or `targetMarkets`
moves (`pricing.cityKeyFor` on the first market; null for a typed town or a
cleared market), never sent by a caller. The strings stay as typed. Only the
first market is keyed: the multi-market list is a string array (Q107), and
its later entries stay spelling-matched until the day they get a table.

## Lot D (Q104): the review invitation

When `runCampaignTransitions` completes a campaign it sends the advertiser one
BOOKING notification ("How were your spots?", `relatedId` = the campaign).
The review itself is `reviews`' — `POST /campaigns/:id/spots/:spotId/review`,
mounted ahead of this router — and reaches this module through
`assertMayAct` and `findCampaignSpotForReview` (exported for it). A
notification that cannot be written never stalls the tick.

## Lot D (Q44/Q120/Q138): creative moderation — `moderation.service.ts`

Every artwork goes through ops. An upload lands **IN_REVIEW** with
`submittedAt` and two computed checks stored on the row: `DIMENSIONS_MATCH`
(the file's aspect ratio against the spot's stated size, 5% tolerance;
UNKNOWN when either side is unmeasured, never a guess) and `VENUE_STANCE`
(the campaign's `contentCategoryId` against each booked spot's
`ListingContentRule`, read through `listings.getContentRules` — PROHIBITED or
NOT_ALLOWED anywhere FAILs; REQUIRES_APPROVAL is the `VENUE_REQUIRES_APPROVAL`
flag plus a notification to the publisher and never a vote; no category is
the `CONTENT_CATEGORY_MISSING` flag). A QR-tracked campaign whose artwork
names no `trackingCodeId` carries `QR_MISSING`. A re-upload after a refusal
is a new row pointing at the old one (`resubmissionOfId`) — the desk keeps
what it refused — and everything that counts artwork (`creativesUploaded`,
the gates) reads `currentCreatives`, the newest row per slot.

**ADX-designed artwork** (an ADMIN upload with `designedByAdx: true`) lands
**AWAITING_ADVERTISER**; the advertiser or their agent taps accept (→
IN_REVIEW, `advertiserAcceptedAt/ById`) or sends it back with a note (→
CHANGES_REQUESTED, ops told). An admin cannot accept it for them.

**The gate is in two places and neither is the wallet.** `reviewCampaign`
lists unapproved artwork under `outstanding` (`CREATIVES_NOT_APPROVED`) and
`authorizeCampaign` does not block on it — the advertiser pays first.
`runCampaignTransitions` leaves a due SCHEDULED campaign in place while any
creative with a file is short of APPROVED (`blocked` in the tick's count,
"Launch blocked: artwork not approved" to ops once a day per campaign), and
`orders.markPrintReady` refuses 409 `CREATIVE_NOT_APPROVED` through the
`CreativeGatePort` this module fills (`creativeGateForOrder`). Rows that
were UPLOADED on in-flight campaigns were grandfathered APPROVED by the
migration.

## Lot D (Q123): the insertion order

`reviewCampaign` carries `agreements: [{ kind: INSERTION_ORDER, accepted,
templateVersion, currentVersion, current }]` from `agreements.transactionAcceptance`
and adds `AGREEMENT_REQUIRED` to `missing` while `current` is false;
`authorizeCampaign` refuses 403 `AGREEMENT_REQUIRED` after the brief check
and before anything is held. The click is
`POST /advertisers/:id/agreements/insertion-order { campaignId }`, rendered
server-side by `agreements` from the live template and the campaign's spots.

## Lot C (Q88/Q110): PENDING_PAYMENT made real, and the gateway

- `submitForPayment` (ops or the campaign's agent) runs the review, requires
  the brief complete — **not** the insertion order, which is the advertiser's
  own click — sets `status: PENDING_PAYMENT`, `submittedForPaymentAt/ByUserId`,
  stamps `reservedUntil = now + 24 h` on every RESERVED spot and notifies the
  advertiser (`Your campaign is ready to pay`, `relatedId` the campaign). A
  re-send refreshes the hold. The list facet already counts PENDING_PAYMENT.
- **The clash check treats a live reservation as a hold**: `clashingListingIds`
  counts the orders still running on each spot plus other campaigns'
  `RESERVED` spots with `reservedUntil > now`, and excludes the campaign's own.
  `expireSpotReservations` on the lifecycle job's tick clears lapsed stamps
  back to plain RESERVED; the campaign stays PENDING_PAYMENT and payable.
- **Lot G (Q116/136) — slots.** A clash is a spot with *too few slots left*
  over the flight, not a spot with one booking on it: the holds are counted
  against the listing's `slotsTotal` (1 for a static wall, a screen's loop
  above it) with `listings`' one count (`slotsHeldWith`, over the two clauses
  `slotHoldingOrdersWhere` / `liveReservationsWhere`), so checkout counts what
  browse counts. G10 (the verifier's second major): a spot's `quantity` is
  priced per slot and *holds* that many — the count sums quantities (the
  campaign spot behind each running order, the live reservations'
  `quantity`) and `clashingListingIds` takes `{ listingId, quantity }` asks
  (a bare id asks for one, the way the matcher does), clashing when
  `held + quantity > slotsTotal`. The review's `clashes[]` rows carry
  `reason: 'NO_SLOT_LEFT'` and the authorise's 409 says "no slot left for
  these dates" — never "booked". The rate stays per slot per day: a six-slot
  screen at ₹1,000 is ₹1,000 to each advertiser. `placeOrder` is handed
  `forCampaignId` so the campaign's own reservation is not one of the holds
  when its orders are raised, and `quantity` so the order takes the spot's
  slots. `inventory`'s `clashes: true` reads the same way.
- **G10 — the reservation write is under the listing lock** (the verifier's
  first major). `holdReservations(campaignId, until, now)` runs in one
  transaction: the campaign's RESERVED spots are read, every distinct
  listing is locked in id order with `pg_advisory_xact_lock(hashtext(listingId))`
  — the same key placement takes — the holds are counted again under the
  locks (this campaign's own left out, each spot over its own flight, the
  campaign's when it has none), and the `reservedUntil` stamp is written only
  when every spot still fits. Otherwise the repository throws
  `SlotClashError { listingIds }`, nothing is written, and `submitForPayment`
  answers the same 409 CONFLICT `{ clashes }` the review gives — the hold is
  taken before the campaign moves to PENDING_PAYMENT, so a refused send
  leaves the campaign as it was (the G10 verifier's finding).
- `authorizeCampaign` accepts DRAFT and PENDING_PAYMENT. An ADMIN pressing it
  goes through `authorizeOnBehalf`: `confirm` must equal the reference (400),
  and at or above `finance.opsAuthoriseThreshold` (default 50,000)
  `approvedByUserId` must name a *different* admin (409 `FOUR_EYES`).
- The gateway (`payments`) prices through `campaignPaymentQuote` — the same
  guards as the authorise, so no order is opened for a campaign that could not
  then be authorised — and, once the wallet is credited, authorises through
  `authorizeCampaignById`. Nothing in the authorise itself changed: the
  gateway's money is wallet balance by the time it runs.

## Lot D (Q7/Q139): tracking

- `destinationUrl` is optional: a code without one resolves to the campaign's
  PUBLISHED landing page when it has one (Lot E, below), and to the plain
  "Thanks for scanning" page otherwise — the scan counts either way. Codes
  are minted in `authorizeCampaign` **before** the order loop so the artwork
  can embed them; `CampaignCreative.trackingCodeId` says which.
- `POST /t/:code/e` writes a `TrackingEvent` with `hourIst` (the IST hour)
  and, on a CTA press, `ctaLabel`; bots are not counted. `GET
  /campaigns/:id/analytics` folds them under `interactions` (`byDevice`,
  `byHour`, `byCity`, `byCta`, provenance MEASURED) and keeps
  `demographics` UNAVAILABLE. The portfolio view skips the fold.

## Lot E (Q7/Q106/Q139): the landing page — `landing-page.service.ts`

The ADX page stands in when the advertiser gives no destination.

- **One page per campaign** (`LandingPage.campaignId` unique), addressed by a
  `slug` made of the campaign's name and four random characters. `blocks` is
  a JSON array of five closed shapes — `hero`, `offer`, `cta`, `contact`,
  `gallery` — validated by `landingBlockSchema` on every way in, the model's
  draft included. Closed on purpose: the backend renders these into HTML, and
  a block the renderer does not know is a block it cannot escape. Only
  `http(s)` URLs survive the schema, and the renderer checks again.
- **Generate** asks the configured model (`shared/ai.complete()`) for one JSON
  object from the brief — brand, product, industry, goal, audience, where,
  when — and lays it out: hero, offer, a CTA that links to
  `trackingConfig.destinationUrl` when there is one and opens the contact
  form otherwise, a contact block with the form on, and a gallery of three
  empty frames the advertiser fills in through the PATCH. A redraft bumps
  `version`; a PUBLISHED page refuses a redraft (edit it, or have ADX
  unpublish first), because a redraft would replace in one call what a
  printed code already points at.
- **The generation is recorded twice** — on the audit trail
  (`LANDING_PAGE_GENERATED`, with `provider`, `model` and the quota after
  it) and, E7-2 (Lot E addendum 2), as an `AiGeneration` row through `ai`
  (`advertiserId`, `subjectKey` = the campaign id, kind `LANDING_PAGE`,
  `publisherId` null). The same regeneration quota the listing drafts use
  applies: `ai.assertLandingPageQuota` before the model — three free, ten
  with a plan ACTIVE, 429 `QUOTA_EXHAUSTED` when spent — and
  `recordLandingPageGeneration` only after the model answered with a page,
  so an outage or an unreadable answer spends nothing.
- **`GET /p/:slug`** renders the PUBLISHED page as one self-contained document:
  inline styles from the optional `theme` (`primaryColor`, `accentColor`,
  `font`), every string escaped, `noindex`, `Cache-Control: no-store`. The
  only outbound requests a phone makes are the gallery images the advertiser
  chose and the beacon. The beacon reads `c` from the query — the code
  `/t/:code` appended — and posts to `POST /t/:code/e`: `VIEW` on load,
  `CTA_CLICK` with the label on any `[data-cta]` tap (the CTA button, the
  phone and email links), `FORM_SUBMIT` when the name-and-phone form goes in.
  Without a `c` nothing is sent — an unattributed view is not a measurement.
  The form's contents are **not stored**; the submission is counted. No age
  question (Q139).
- **`/t/:code`** with no destination redirects `302 /p/:slug?c=<code>` when
  the page is PUBLISHED; the scan is counted, the redirect to ADX's own page
  is not a CLICK (the page reports its VIEW). A DRAFT page is no page.
- **`/p` is shared** with `packages`' payment link (`/p/:token`), mounted
  after `trackingRouter`. The landing-page handler calls `next()` on a slug
  nothing PUBLISHED answers to, so a token still reaches the payment link;
  slugs are words plus four characters, tokens are long and random.

## G7 (Q109): the Audience Breakdown — `audience` on `GET /campaigns/:id/analytics`

The owner's answer to 109: campaign analytics are ADX's own digital
interactions; the Audience Breakdown is a footfall / data-panel vendor's
(GeoIQ and Azira, behind `shared/audience`, the enabled set and the blend
policy on the integrations row — Y-B). So the per-campaign read carries
`audience`:

- `null` when no vendor is configured — the screen says "no panel backs this"
  (`demographics.basis` says the same) rather than drawing a figure; also
  null with nothing booked, and skipped (`audience: false`) for the portfolio
  view and the daily snapshot.
- Otherwise `{ provenance: 'PANEL', vendor, vendors, provenanceByField,
  agreement, period, basis, spotsWithData, spotsTotal, footfall { daily,
  byHour, byWeekday }, demographics { ageBands, gender, incomeBands,
  affinities } }` — the blended panel for each booked spot (through
  `listings.audienceForSpots`, i.e. the per-(listing, vendor, month)
  `AudienceSnapshot` rows blended by the policy, so each vendor is asked
  once per spot per month) folded by `foldAudience`: **footfall summed**
  across sites (a campaign's audience is every site's catchment), **shares
  and profiles averaged, weighted by days × quantity**; a spot with no panel
  counts in `spotsTotal` and nowhere else. Y-B: the fold carries the
  provenance — `vendors` is the set in force (`vendor` the one name an old
  reader prints), `provenanceByField { footfall, demographics, affinities }`
  is the union across sites (one vendor, or `BLENDED`; a raw single-vendor
  row reads as that vendor's), `agreement.footfall` the mean of the sites'
  vendor agreement on daily footfall (null unless both vendors answered
  somewhere). `period` is the latest month the flight has run in
  (`audiencePeriodFor`) — the start month before it starts, this month with
  no dates.
- Never a failure of the analytics read: a vendor error is a null panel and a
  log line.

## Invariants

- The cart holds a price, never inventory (`revenue` owns the lock).
- A campaign that cannot be paid for fails at authorisation, while somebody is
  still looking at it, not on the morning it goes live.
- Nothing here writes a wallet balance. A hold is placed, captured or released
  through `advertisers`; a refund is a `CampaignRefund` row until finance says
  otherwise.
- The invoice is `invoices`' (Lot B, Q13), reached through
  `invoicing.port.ts` because that module reads this one: the checkout asks
  for it after the hold, the transition marks it paid at capture, the cancel
  asks for the credit note. Every call is best-effort — the booking stands
  whether or not a number was allocated, and `POST /finance/invoices/issue`
  catches up. `findCampaignForInvoice` is the snapshot it itemises.
- `runCampaignTransitions` moves one campaign at a time and a refused
  capture — a frozen advertiser's (Lot A FREEZE_WALLET, refused inside the
  movement since B3a) — is counted `skipped`, logged and left SCHEDULED for
  the next tick. It never stops the other campaigns due on the same tick.
