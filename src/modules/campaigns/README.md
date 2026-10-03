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
| `PATCH /campaigns/:id { placementPreferences, brandApprovalRequired, contactName, contactEmail, contactPhone }`, `creativeConfig.notes` | same | WG-1 (DR 12 boards 04/05): the placement wishes (`avoidAlcohol / avoidPolitical / avoidCompetitors / note`, null clears), whether the brand signs off the artwork before launch, the campaign contact the production step draws, and the design notes under the ADX brief — stored as stated, read beside the brief; nothing enforces them yet |
| `POST /campaigns/:id/design-quote { amount, note? }` (ADMIN, `content.edit`), `POST /campaigns/:id/design-quote/respond { decision }` (the advertiser or their agent) | — | DQ-1 (DR 12 board 05): ADX's price for designing the artwork on an `ADX_DESIGN_AGENCY` campaign, before payment. QUOTED → ACCEPTED \| DECLINED; an accepted quote is `review.designFee` (taxed as the media is) and a DESIGN line on the invoice; the design-requests desk carries `campaign.designQuote`. Audited `CAMPAIGN_DESIGN_QUOTED` / `…_ACCEPTED` / `…_DECLINED` |
| `POST /campaigns/:id/reserve`, `POST /campaigns/:id/reserve/pay` | same | RF-1 (the owner, 25 Sep 2026): a checkout at or above `settings.booking.reservationFee.minCheckoutValue` is reserved — spots held for `holdHours`, PENDING_PAYMENT, and a fee of `feePct` of the total falls DUE within `payWithinMinutes` (409 `RESERVATION_NOT_OFFERED` under the threshold). `/pay` takes the fee from the wallet into a hold; a gateway pays it through `POST /payments/intents { campaignId, purpose: 'RESERVATION_FEE' }`. Going ahead (`/authorize`, or a gateway payment for `campaignPaymentQuote.total`, now the total less the fee) releases the fee's hold into the full hold (ADJUSTED). A cancel while reserved, or the lapsed day, forfeits it: `retainPct` to platform:revenue as a PENALTY, the rest left in the wallet (RETAINED). An unpaid fee lapses after the hour (LAPSED; the campaign back to DRAFT unless ops had sent it). `GET /campaigns/:id` carries `reservation`; `GET /campaigns/:id/review` carries `reservationFee` (the offer). Audited `CAMPAIGN_RESERVED` / `…_RESERVATION_FEE_PAID` / `…_RESERVATION_FORFEITED` |
| `PUT /campaigns/:id/spots` — `items[].fulfilment` | same | PS-1: a spot's own print choice (`ADX_PRINTS` \| `ADVERTISER_SHIPS`); null means the campaign's. A spot the advertiser ships for takes no PRINTING fee, on the review and on the invoice alike |
| `GET /campaigns/:id/review` — `discountGst` | same | GST-D (the owner, 25 Sep 2026): a discount (manual or promo) comes off the taxable value; the tax is charged on what is paid, and `discountGst` is the tax the discount took with it. The invoice's discount line carries the same negative GST |
| `POST /campaigns/:id/promo { code }`, `DELETE /campaigns/:id/promo` | same | PC-1 (DR 12, 25 Sep 2026): a promo code on and off the booking, DRAFT or PENDING_PAYMENT only (409 CONFLICT after payment). The code must exist (404 `PROMO_NOT_FOUND`) and pass `promo-codes.promoProblem` against this booking's media + fees (409 `PROMO_NOT_APPLICABLE`, the message says why). Both answer the review re-priced: `discount` is what the code takes off (`promo-codes.discountFor`: percent or flat, capped, never more than the base; GST stays as charged on the lines) and `promo: { code, amount }` names it; `GET /campaigns/:id/review` carries the same. At authorise the code is spent — one `PromoRedemption` per campaign, for what it took off, snapshotted into `Campaign.discount` — and a cancel releases it. Audited `CAMPAIGN_PROMO_APPLIED` / `CAMPAIGN_PROMO_REMOVED` |
| `GET /campaigns/content-categories` | same | Lot D (Q138): the seeded content categories the wizard asks about (`contentCategoryId` on the patch) |
| `POST/DELETE /campaigns/:id/creatives[/:creativeId]` | same | artwork; an upload is a submission (Lot D, Q44) — see below; T-B: the upload answers the desk's row (the artwork with its `campaign` and `spot`), the same read `GET /campaigns/creatives/:creativeId` makes |
| `POST /campaigns/:id/creatives/:creativeId/accept`, `/request-changes { note }` | advertiser or their agent — never an admin | Lot D (Q120): the answer to ADX-designed artwork |
| `GET /campaigns/creatives/review-queue?status=&kind=&flagged=&resubmitted=&analysed=&q=&sort=&page=&pageSize=` | ADMIN | the desk, on the list contract with status counts; E7-2: `counts` also carries `flagged`, `static`, `video`, `resubmitted`, counted over the same scope as the histogram; VA-4: `analysed=true|false` is the reading facet, `counts.analysed` / `counts.unanalysed` its numbers, and every row carries `analysis` — its latest vision run or null |
| `GET /campaigns/creatives/:creativeId` | ADMIN | one artwork with its campaign, spot, checks and flags — VA-1: and `analysis`, the latest vision run or null |
| `POST /campaigns/creatives/:creativeId/analyse` | ADMIN | VA-1: ask the vision model — appropriate, relevant, legal, PG/REGULAR/ADULT, unique; **201** the analysis; audited `CREATIVE_ANALYSED` |
| `POST /campaigns/creatives/analyse { creativeIds? }` | ADMIN | VA-4: the batch — the named artworks (up to fifty), or with no body everything IN_REVIEW that is a still image with no reading yet, oldest first; `{ analysed, skipped, failed }`; a video or an empty slot is skipped, a vendor failure is recorded against its one artwork, "switched off" (503) stops the run |
| `PATCH /campaigns/:id/creatives/:creativeId/review { decision, note?, checks? }` | ADMIN | APPROVED \| REJECTED \| CHANGES_REQUESTED; a note is required unless approved; audited `CREATIVE_REVIEWED` |
| `POST /campaigns/creatives/review { creativeIds, decision, note? }` | ADMIN | the same decision across up to fifty; one audit row and notification each |
| `GET /campaigns/:id/tracking-codes/:code/image.png?size=`, `…/image.svg` | same | Lot D (Q139): the code's QR for the artwork to embed. QR-1: drawn by the QR engine when it hosts the code — GenQR's styled artwork (the SVG carries dots, frame, caption, logo; the PNG colours only) encoding the short URL the hoarding carries — and locally otherwise, of the stored short URL when one exists, else of `/t/`; `X-QR-Engine: LOCAL \| GENQR` and `X-QR-Styled` say which |
| `POST /campaigns/:id/tracking-codes/sync-engine` | ADMIN | QR-1: puts the engine's hosted dynamic code in front of every QR code not yet hosted — for a campaign paid for while GenQR was down or before it was configured. Idempotent; the engine's own refusal comes back as it is (503 not configured, 409 quota, 502 down); audited `TRACKING_CODES_ENGINE_LINKED` with the codes linked. Answers `{ linked, codes }` |
| `POST /t/:code/e { type: VIEW\|CTA_CLICK\|FORM_SUBMIT, ctaLabel? }` | public, metered by IP | Lot D (Q7): an interaction on the landing page |
| `POST /campaigns/:id/landing-page/generate` | advertiser, their agent, admin (`assertMayAct`) | Lot E (Q7/Q106): drafts the five blocks from the brief through `shared/ai`; **201**; 409 on a PUBLISHED page; 503 `AI_UNAVAILABLE` / 502 `AI_FAILED`; E7-2: 429 `QUOTA_EXHAUSTED` under `ai`'s landing-page quota, an `AiGeneration` row per draft; audited `LANDING_PAGE_GENERATED` with vendor and model; E11-2: answers `url: /p/:slug` beside the blocks, as every builder read does (`withLandingUrl`) |
| `GET /campaigns/:id/landing-page` | same | the page, with `url: /p/:slug` |
| `PATCH /campaigns/:id/landing-page { blocks?, theme? }` | same | an edit is the next `version`, live page or not; audited `LANDING_PAGE_UPDATED`; E11-2: answers `url` beside the blocks |
| `POST /campaigns/:id/landing-page/publish` | same | PUBLISHED with `publishedAt`; needs a hero block; audited `LANDING_PAGE_PUBLISHED` |
| `GET /campaigns/landing-pages?status=&q=&page=&pageSize=` | ADMIN | the review list, on the list contract with status counts, each row beside its campaign — E7-2 (Lot E addendum 2): `LandingPage.campaign` is a relation now, so the campaign is the same query. The Campaigns lot (2 Oct 2026): `q` matches the slug, the campaign's name and reference, and the advertiser's business, person and ADV-/ADX- ids, and the status counts are taken with `q` (without the status facet); every row adds `url` (`/p/:slug`), `heroTitle` (the hero block's headline, or null), `advertiser` (the orders' `placedBy` shape — below) and the page's own `views`, `ctaClicks`, `enquiries` (lifetime, two queries per page) |
| `POST /campaigns/:id/landing-page/unpublish { reason }` | ADMIN | back to DRAFT; audited `LANDING_PAGE_UNPUBLISHED`; the campaign's creator told why; T-B: answers the review list's row — the page with its `campaign` and advertiser (`findLandingPageView`, the list's include) |
| `GET /p/:slug` | public | the page itself, rendered server-side — one document, no external asset; a slug nothing PUBLISHED answers to falls through to the package payment link on the same prefix |
| `GET /campaigns/:id/review`, `POST /campaigns/:id/authorize`, `POST /campaigns/:id/cancel` | same | the bill, the booking, the cancel; E6: the authorise answers `invoice: { id, number, kind, status } \| null` — what `invoices` issued through the port inside the call, null when it could not (the desk's `POST /finance/invoices/issue` catches up) |
| `GET /campaigns?…&city=&from=&to=&goal=&waitingOn=` | advertiser, agent, admin | The Campaigns lot (2 Oct 2026): the console's filter bar — `city` (slug or name, by the key `targetMarketCityId`, the typed `targetMarket` the fallback), `from`/`to` (`YYYY-MM-DD`, flight overlap on UTC days; `to` before `from` is a 400), `goal` (comma list), `waitingOn` (comma list of launch gates — ADMIN only, ignored for a party); `q` also matches the advertiser's business, person and ADV-/ADX- ids. ADX's rows add the console columns (below); a party's rows are unchanged |
| `GET /campaigns/launch-queue?reason=&q=&city=&page=&pageSize=` | ADMIN + `demand.view` | The Campaigns lot: paid (or reservation-fee-paid) campaigns that cannot go live yet, oldest-waiting first — see below |
| `POST /campaigns/:id/remind-payment` | ADMIN + `demand.edit` | The Campaigns lot: the advertiser of a PENDING_PAYMENT campaign is told to pay (or to pay the reservation fee while that is DUE) by the in-app notification; once per 24 h per campaign (429 `TOO_MANY_REQUESTS` with `details.lastRemindedAt`/`nextAllowedAt`), 409 for anything else, an advertiser with no login, or an account that is not working; audited `CAMPAIGN_PAYMENT_REMINDED`. Answers `{ campaignId, reference, about: PAYMENT\|RESERVATION_FEE, amountDue, remindedAt, nextAllowedAt }` |
| `GET /campaigns/:id/cancel-impact` | whoever may cancel (`assertMayAct`) | The Campaigns lot: what `POST /campaigns/:id/cancel` would do, written nowhere — `{ campaignId, reference, status, cancellable, notCancellableBecause: ALREADY_CANCELLED\|COMPLETED\|null, holdReleased, refundNeeded, refundAmount, unusedDays, reservationFee: { status: PAID, fee, retained, returned } \| { status: DUE, fee, retained: null, returned: null } \| null }`; the same arithmetic as the cancel (`unusedValueOf`, `retainedPartOf`) |
| `GET /campaigns/:id/performance` | advertiser, their agent, admin (`assertMayAct`) | The Campaigns lot: the campaign page's Performance card — `{ campaignId, reference, status, startDate, endDate, lifetime: { scans, views, ctaClicks, enquiries }, series: [{ day, scans, views, ctaClicks, enquiries }] }`; `lifetime` is the codes' scan counters and the landing page's events, `series` one point per flight day run (UTC days, zeros filled, empty before the start) from the same event read the analytics chart uses |
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

## VA-1 (23 Sep 2026): the vision review — `creative-analysis.service.ts`

The owner: "a vision analysis program in order to analyse creatives submitted
by advertisers in order to determine if the creatives are appropriate,
relevant, unique, legal and if they're PG rated or regular." On demand, from
the workbench, and **never a decision**: the reviewer reads it, applies what
they agree with to the checklist, and decides as before.

`analyseCreative(creativeId, { userId })`:

1. Reads the file through `uploads.readImageForModel` — downscaled to
   1,024 px, JPEG, with a **perceptual hash** (a 9×8 difference hash, 64
   bits). A creative with no file is **409** `NO_FILE`; a video is **409**
   `ANALYSIS_UNSUPPORTED` (still images only); undecodable bytes are **409**
   `FILE_UNREADABLE`.
2. Asks the configured provider (`shared/ai`, `images` on the request) with
   `CREATIVE_REVIEW_SYSTEM` and `creativePrompt(creative)` — the campaign's
   name and industry, the spot and its size, the content category — and holds
   the answer to `analysisAnswerSchema`: `appropriate`, `relevant`, `legal`
   each `{ verdict: PASS | FAIL | UNSURE, reason }`, `rating` PG | REGULAR |
   ADULT with `ratingReason`, `flags` from the fixed `ANALYSIS_FLAGS`
   vocabulary (TOBACCO, ALCOHOL, GAMBLING, ADULT_CONTENT, VIOLENCE,
   HATE_OR_DISCRIMINATION, POLITICAL, RELIGIOUS_SENSITIVITY,
   MISLEADING_CLAIM, HEALTH_CLAIM, PRICE_CLAIM, MISSING_DISCLAIMER,
   COMPETITOR_MARK, CELEBRITY_LIKENESS, CHILDREN_TARGETED, LOW_LEGIBILITY,
   OFF_BRIEF — a word outside it becomes OTHER), `summary`, `confidence`. No
   provider is **503** `AI_UNAVAILABLE`; an answer that does not parse is
   **502** `AI_FAILED`.
3. **Uniqueness is arithmetic, not the model.** The hash is stored on the
   creative (`perceptualHash`) and compared with every other creative's by
   Hamming distance (`nearestByHash`); within `UNIQUE_DISTANCE` (10 bits) the
   artwork is `unique: false` with `nearest: { creativeId, distance }`; null
   when there is nothing yet to compare with.
4. Stores a `CreativeAnalysis` row (provider, model, the verdicts, the raw
   answer, who asked) and audits `CREATIVE_ANALYSED`. `GET
   /campaigns/creatives/:id` carries the latest as `analysis`.

The console's workbench draws the card at the top of the rail with "Analyse
with AI" and "Apply to checklist" — the latter is `checksFromAnalysis` on the
console: BRAND_SAFE fails on an inappropriate or illegal reading and passes
only when both are clean, TEXT_LEGIBLE fails on LOW_LEGIBILITY, UNSURE and
every other row are left as the reviewer had them.

**VA-4: the queue.** Every row of the review queue carries its latest
reading (`analysis`), the queue takes `analysed=true|false` as a facet with
`counts.analysed` / `counts.unanalysed`, and `analyseCreatives(actor,
creativeIds?)` runs the pass over the selection or over everything pending
that has no reading yet — one creative at a time through the same
`analyseCreative`, so each run is audited on its own. The console draws the
worst verdict, the rating and a near-duplicate badge on each card, and has
"Analyse pending" on the queue and "Analyse" on the selection bar.

**Training.** Nothing here trains anything. Whether ADX may use advertisers'
creatives for training at all is a consent question for the advertiser
agreement (OPEN-TASKS); the model is called on demand with the one picture
and the answer is kept as the desk's own record.

Tests: `__tests__/va1-creative-analysis.test.ts`.

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

## QR-1 (16 Sep 2026): the QR engine in front of the hoarding

The owner's decision: GenQR — our own QR platform, on its own deployment —
hosts a dynamic code in front of every campaign hoarding, and the scan path
is **`GenQR /r/XXXX → ADX /t/XXXX → destination`**. Nothing about ADX's
counting moved: `/t/:code` is still where the scan is recorded, the bot
filter, the IST hour, the landing beacon and the measured-vs-reported rule
stand as they were. What GenQR adds is the styled print artwork, a short
printed URL on the ADX-branded origin (never GenQR's own host), and a second
log of the same scans with the phone's country, city, browser and OS — which
ADX deliberately does not read itself.

- **At payment** (`issueTrackingCodes`): the codes are minted exactly as
  before, then `linkCodesToEngine` puts one GenQR dynamic code in front of
  each QR code — named `<reference> · <spot title>` for GenQR's desk,
  targeting `trackingUrl(code)` — and records `engineCodeId`, `shortUrl`,
  `engineLinkedAt` on the row. **Best effort**: no engine configured, or an
  engine that does not answer, is logged and the campaign is paid for with
  the hoarding carrying `/t/`; the sync route links it later. A vanity /
  promo campaign has nothing for the engine.
- **`printedUrl(code)`** is what the hoarding carries — `shortUrl` when
  hosted, else `trackingUrl` — and every read (`tracking-codes`, `authorize`)
  answers it beside `url` with `engine: LOCAL | GENQR`.
- **Analytics** (`campaignEngineView`): `engine` on `GET /campaigns/:id/analytics`
  — `{ provenance: 'ENGINE', engine: 'GENQR', basis, codesLinked, codesTotal,
  codesUnanswered, days, totalScans, scansInWindow, scansByDay, hourlyBreakdown,
  deviceBreakdown, browserBreakdown, osBreakdown, countryBreakdown,
  cityBreakdown }`, folded across the hosted codes (breakdowns summed, most
  first; the hours zero-filled), null when nothing is hosted. A code GenQR
  cannot answer for on that read is counted in `codesUnanswered` rather
  than failing the panel. The portfolio and the daily-metrics writer skip
  it (`engine: false`).
- **Never in place of**: `scans` stays ADX's MEASURED number. The engine's
  figure is the same scans seen a hop earlier and can only be higher (a
  scan GenQR recorded that never reached `/t/` — a browser that refused the
  redirect).

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

## The Campaigns lot (2 Oct 2026): the console's reads — `console.service.ts`, `launch-gates.ts`

The owner: "Campaigns section feels too weak here" / "Landing pages … we
don't even know how they work". Everything here is ADX's read; a party's own
reads never carry the advertiser's party row.

**The advertiser, as `placedBy`.** `launch-gates.campaignAdvertiserOf` shapes
the campaign's advertiser into the orders' PB-1 shape —
`{ userId, name, displayId, business: { id, name, displayId } | null }`:
`userId` the advertiser's login (null for an account the desk holds for
somebody who has not registered), `name` the person (first and last name,
else the display name), `displayId` the person's ADX-… id, `business` the
advertiser profile (never null on a campaign). The repository selects the
person column by column (`advertiserPartySelect`); the account columns it
reads for the lifecycle predicates (`isActive`, `closedAt`, the suspension
scopes) never leave the service. `tests/contract/no-secrets-in-responses.test.ts`
pins it.

**What a campaign waits on** (`waitingOnOf`) — one derivation for the list's
`waitingOn`, the launch queue and the Campaigns overview's count. A DRAFT
waits on nobody but its author; LIVE, PAUSED, COMPLETED and CANCELLED wait on
nothing. For PENDING_PAYMENT and SCHEDULED, in this order:

| Reason | When | The fact on the queue (`waitingFacts`) |
| --- | --- | --- |
| `RESERVATION_FEE` | PENDING_PAYMENT with the RF-1 fee DUE | `{ amount, dueAt }` |
| `PAYMENT` | PENDING_PAYMENT otherwise (the balance, when the fee is PAID) | `{ amountDue, sentForPaymentAt, reservationFeePaid }` |
| `DESIGN_QUOTE` | PENDING_PAYMENT on `ADX_DESIGN_AGENCY` with no quote (ADX owes one) or one QUOTED (the advertiser owes the answer) | `{ state: NOT_QUOTED\|QUOTED, amount, quotedAt }` |
| `KYC` | paid (SCHEDULED, or the fee PAID) and the advertiser not VERIFIED — QR-16's launch gate | `{ advertiserId, kycStatus, accountState }` |
| `ARTWORK` | artwork uploaded and not approved, a superseded one ignored (`moderation.outstandingCreatives`) — Lot D's launch gate | `{ creatives: [{ id, status, designedByAdx }] }` |
| `PUBLISHER` | SCHEDULED with a standing spot whose order is PENDING_PUBLISHER | `{ spotIds, orderIds }` |
| `AGENT` | SCHEDULED with a standing spot whose order is PENDING_AGENT or AGENT_REJECTED | `{ spotIds, orderIds }` |

A filter by reason reads the candidates through `waitingPrefilter` — exact
for every gate but ARTWORK, which cannot see a superseded creative (the
resubmission is a plain column) and reads a superset — and narrows them in
memory by the same derivation, so a row a filter keeps always says why. At
most 5,000 candidates per read (`GATE_CANDIDATE_CAP`, logged when reached).

**The list's console columns** (`GET /campaigns`, ADMIN): `advertiser`
(`placedBy`, replacing the apps' `{ id, displayId, name }` on ADX's rows
only), `landingPage` (`{ id, slug, status, url, publishedAt } | null` — the
narrow summary `GET /campaigns/:id` carries, read in the same gate-facts query),
`waitingOn`, `spotsLive` / `spotsTotal` (spots not cancelled, and
those LIVE), `performance: { scans, views, ctaClicks, enquiries }` (lifetime:
the codes' scan counters, the landing page's VIEW / CTA_CLICK / FORM_SUBMIT
events), `paidAmount` (the total once `paidAt`; the reservation fee while only
that is PAID; else null), `daysLeft` (a LIVE flight's days left, today
included; else null). Two reads for the whole page — `campaignGateFacts` and
`performanceTotals` — never one per row.

**The launch queue** (`GET /campaigns/launch-queue`): the population is
SCHEDULED, or PENDING_PAYMENT with the reservation fee PAID, waiting on at
least one reason. Each row: `{ id, reference, name, status, brandName,
startDate, endDate, total, paidAmount, paidAt, reservationFeePaidAt,
advertiser, waitingOn, waitingFacts, waitingSince, waitingDays }` —
`waitingSince` the payment (or the fee's), `waitingDays` whole days since;
oldest first. `reason` (comma list) keeps the rows waiting on any of them;
`counts` is one per reason (a campaign waiting on two counts under both) and
`ALL`, taken without `reason`. `launchQueueSummary` (exported) counts the same
for the section overview.

**The campaign page** (`GET /campaigns/:id`, ADMIN) adds `placedBy`,
`waitingOn`, `waitingFacts`, `paidAmount` and `daysLeft` beside the detail
view (whose own `advertiser` stays the apps' narrow one).

**References.** The canonical reference is `ADX-CMP-<year>-<six digits>`
(`campaigns.service.nextReference`, the year from the server clock, the digits
random and checked unique). The demo seeds write `ADX-CMP-2026-DEMO01…`
(`src/scripts/seedDemoListings.ts` DEMO01–05, `seedDemoPlatform.ts` DEMO06
onward). The four `ADX-CMP-probe_c1…c4` rows in the local database were
written directly by a one-off probe on 11 Sep 2026 06:33 UTC (created by
ADX-1109-2601, a tenth of a second apart) — no code in the repository writes
that shape. Stored references are never rewritten.

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
- QR-16 (the owner, 17 Sep 2026): KYC gates the LAUNCH, not the payment.
  `authorizeCampaign` reads `launchBlockedBy` off `assertCanBook`'s answer;
  with KYC in it a campaign due today stays SCHEDULED, uncaptured, and the
  advertiser is told. `runCampaignTransitions` skips a due campaign whose
  advertiser is unverified (`advertiserContext.kycStatus`), counted
  `awaitingVerification`, ops and the advertiser told once a day; the first
  tick after the verification launches it. The detail read carries
  `launchBlockedBy` for the app's "paid — verify to launch" line.
