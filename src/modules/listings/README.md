# listings

Advertising inventory a publisher offers: location, size, price, photos and
availability — and the desk at which ADX decides whether it goes on the
marketplace.

## Owned routes

G11-1: `GET /listings/:listingId` (ADMIN) carries `carriesLoop: boolean` —
the one rule `slots.service.carriesLoop` refuses a slot count with (the
sub-type or the media type names a screen) — and `mediaType`
`{ name, formatGroup } | null`, the type the spot was filed under, joined on
the same read (`findOneForAdmin`) rather than looked up again.

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/listings/content-categories` | any signed-in caller |
| GET | `/api/v1/listings/review` | ADMIN |
| GET | `/api/v1/listings` | ADMIN — Lot E: every row carries `belowFloor`, from `rate-cards.belowFloorFlags` |
| POST | `/api/v1/listings` | AGENT_PUBLISHER \| PUBLISHER \| ADMIN (**201**) |
| PATCH | `/api/v1/listings/:listingId` | AGENT_PUBLISHER \| PUBLISHER \| ADMIN (ownership in the handler); T-B: answers the detail view `GET /listings/:listingId` answers — `publisher`, `agent`, photos, `mediaType`, `carriesLoop`, translated for the reader (`listingDetailView` in the controller, one read after the write) |
| GET | `/api/v1/listings/:listingId/content-rules` | any signed-in caller |
| GET | `/api/v1/listings/:listingId/audience?period=YYYY-MM&advertiserId=` | any role through the door; the service admits ADMIN, the publisher's side of the listing (the same door as an edit — the publisher, their onboarding agent, an agent under a live LISTINGS grant), or an advertiser who has the spot in a non-draft campaign of theirs (in person, or through their agent naming `advertiserId` under the demand-side policy) — G7 (Q109) / Y-B: `{ listingId, period, provider, providers, audience: BlendedAudienceCatchment \| null, basis, cached, unavailable }`. `audience` is the vendors' panels for the `catchmentRadiusM` circle around the spot, **blended by the policy on the integrations row** — `footfall { daily, byHour[24], byWeekday[7] }`, `demographics { ageBands, gender, incomeBands, affinities }` (each a list of `{ label, share }` or null where no vendor has anything), `provenance: 'PANEL'`, `provenanceByField { footfall, demographics, affinities }` (`GEOIQ \| AZIRA \| BLENDED \| null`), `vendors` (who answered), `agreement { footfall }` (0–1 when both gave a daily figure), `rawByVendor { GEOIQ?, AZIRA? }` (each vendor's own answer, for the desk), the legacy `vendor`, `radiusM`, `fetchedAt`. **One `AudienceSnapshot` row per (listing, vendor, period)** — exactly the unique key: each enabled vendor's RAW answer is stored with `expiresAt` = end of the month + 7 days and only the vendors lacking a fresh row are asked, so the blend is made from the rows at read time — switching the policy re-blends with no vendor call, a vendor enabled later fills in on the next read, a vendor disabled later is left out though its row stays; "nothing there" is not stored. One vendor's 429 / 502 keeps the other's answer and is named in `unavailable` (`{ vendor, reason }`; a credential-less vendor is `not configured`). `providers` is the enabled set and `provider` the one name an old reader prints (the footfall primary in force). `period` defaults to this month. Null `audience` with the reason in `basis` when no vendor is enabled or the spot has no coordinates; a vendor's own 503/429/502 only when no vendor answered at all |
| POST | `/api/v1/listings/:listingId/submit` | PUBLISHER \| AGENT_PUBLISHER (ownership in the handler) |
| GET | `/api/v1/listings/me/:listingId/suggested-rate` | PUBLISHER \| AGENT_PUBLISHER (ownership in the handler — the publisher, their agent, or an agent under a live LISTINGS grant) — Lot E: `{ currentRatePerDay, offer, differs }`, the offer being `pricing.suggestedRate` with each applied factor's `mode` |
| POST | `/api/v1/listings/me/:listingId/accept-suggested-rate` | same — Lot E: writes the offer's rate through `updateListing` as the publisher's own decision; audited `LISTING_SUGGESTED_RATE_ACCEPTED`; 409 when already at the offer |
| GET | `/api/v1/listings/:listingId/reprice-log` | ADMIN — E10-2: the Pricing tab's history as a first-class read — `pricing`'s `LISTING_REPRICED_BY_FACTOR` audit rows on the listing, newest first (200 at most), shaped `[{ at, factor: { id, name, applied, mode, surgeId }, from, to, by: { id, name } }]`; a read over the shared audit trail (`shared/audit.findActivityRows`), not a second record; 404 for a listing that does not exist |
| GET | `/api/v1/listings/:listingId/review` | ADMIN |
| POST | `/api/v1/listings/:listingId/send-back` | ADMIN |
| POST | `/api/v1/listings/:listingId/publish` | ADMIN |
| GET | `/api/v1/listings/:id/similar` | **none** |
| GET | `/api/v1/listings/browse?…&from=&to=&instant=&sort=RATING&advertiserId=` | any signed-in caller — DR 01 discovery; QR-5: verified publishers' spots first, then the rest, each in the asked sort, one page cut across both; every card carries `publisherVerified`; Lot D adds `instant`, `RATING` and the `saved` mark. E7-2: `to` beside `from` is the availability window — a spot whose `availableFrom` is after it, or with a booking overlapping [from, to] (BOOKED / LIVE, or a live RESERVED hold — the clash rule checkout applies, repeated here because `listings` cannot import `campaigns`), is left out. E11-2: every card carries `shareUrl` — `PUBLIC_WEB_URL` (env, optional; the API origin — `BASE_URL`, else the local port — when unset) + `/s/:displayId`; null while the spot has no display id. Lot G (Q116/136): every card carries `slotsTotal` and `slotsLeft` for the asked window (`from`/`to`, else today); a spot with a loop is never hidden by `to` for one booking — its card says how many slots are left, which may be 0 |
| GET | `/api/v1/listings/browse/categories?city=&lat=&lng=&radiusKm=` | any signed-in caller — G12-B: the "Browse by category" grid: `{ items: [{ category, count, photoUrl }], total }`, one tile per `ListingCategory` (all four, zeroes included), `count` the ACTIVE spots of that category in the place, `photoUrl` the newest live spot's first public photograph (`publicPhotoUrl` — an `https` address, never `/api/v1/files/:id`; down the newest-first order until one has a picture; null when none does), most populous first, ties in catalogue order. The place is resolved exactly as `/browse` resolves it (`browsePlaceClauses`): `city` by name (Lot X-L: plus the rows keyed to the city the name resolves to), or `lat`/`lng` (together) with `radiusKm` (1..100, default 10) — the bounding box cut to the circle by exact distance. Registered above `/browse/:listingId` so "categories" is never read as an id |
| GET | `/api/v1/listings/browse/:listingId?advertiserId=&from=&to=` | any signed-in caller — the same card, `shareUrl` included (E11-2); Lot G: `slotsLeft` counted over `from`/`to` (the campaign's dates) when given, else today |
| GET | `/s/:displayId` | **none** — E11-2: the public spot page a shared link opens, root-mounted beside `/p/:slug` and metered by IP (`spotPageLimiter`, 60 a minute); one self-contained HTML document (no external asset; the hero photograph through a public http(s) URL only, never a `/api/v1/files/:id` address) with the title, media type (the category made readable when none), size, rate per day, city and area (the recorded address), the publisher's business name, the rating line when `reviewCount > 0`, one "Open in the ADX app" link to `adx://spaces/:displayId` and the store links from `APP_STORE_URL` / `PLAY_STORE_URL` (env, optional — a store nobody named is not drawn); ACTIVE listings only, 404 otherwise, so the link dies with the spot; `Cache-Control: no-store`, `noindex` — `spot-page.service.ts`, `spotPageRouter` mounted by `bootstrap/create-app` after the payment link |
| PUT | `/api/v1/listings/browse/:listingId/save` | any signed-in advertiser, or their agent under a live PROFILE grant naming `advertiserId` (Lot D, Q5) |
| DELETE | `/api/v1/listings/browse/:listingId/save` | same |
| GET | `/api/v1/advertisers/:advertiserId/saved?page=&pageSize=` | owner, ADMIN, or the attributed agent (`assertMayActFor` READ) — `savedSpacesRouter`, mounted ahead of `advertiserRouter`; list contract |

### The `/similar` route is load-bearing

`GET /listings/:id/similar` is **unauthenticated** and is registered on the API
router *directly*, before `listingRouter` is mounted. `listingRouter` calls
`use(authenticate)`, so if `/similar` were moved inside it, or registered after
it, the route would start returning 401 and the public discovery flow would
break. `bootstrap/register-modules` keeps the order; the route-inventory test
asserts it.

`GET /publishers/:publisherId/listings` is owned by `publishers`, which calls
this module's `getListingsForPublisher`.

## The review desk (DR 10)

**QR-3 (17 Sep 2026): the listing door.** A publisher on their own phone
may not START a listing until ADX has their basics — a name (one that is
not still the mobile number the self-registration wrote), an email, an
address and (QR-5) a date of birth. `POST /listings` as a self-serve
PUBLISHER refuses 409 `PROFILE_INCOMPLETE` with `details.missing` (`name` /
`email` / `address` / `dateOfBirth`, in the ladder's order) and a sentence
that names them and says what the identity check is for. The rule is
`shared/kyc-state`'s `profileBasicsMissing`, the same one `GET
/publishers/me` folds into `readiness` so the app's locked "+" and this
refusal agree. An agent's or ADX's create is not gated here — their ladder
and desk are.

**QR-5 (17 Sep 2026): the basics gate on going live — the KYC gate
withdrawn.** QR-2 (a day earlier) had `publishListing` refuse 409
`KYC_REQUIRED` for any publisher not VERIFIED. The owner's rule since: a
publisher uses the account unverified and lists once the basics are in —
"their listing will also be marked along with their profile as unverified
and be pushed below verified listings or profiles when an advertiser checks
out listings". `publishListing` now runs `assertPublisherBasics` after the
rate-card and city gates: 409 `PROFILE_INCOMPLETE` with `details.missing`
when a basic is missing (a VERIFIED publisher with no date of birth is
refused too), nothing when they are all in, whatever `kycStatus` says. A
listing with no publisher (an ADX-owned row) is not gated. `readiness.
canGoLive` follows the same rule. Gate 2 of
`docs/publisher-supply-lifecycle.md` is therefore the basics, not the check.

**QR-6 (17 Sep 2026): the commercial agreement at submit.** The owner:
"Commercial Agreement should be presented after any listing is getting
submitted" — not in the setup checklist. `POST /listings/:id/submit` by a
publisher on their own phone refuses 409 `AGREEMENT_REQUIRED` (`details.
agreement = 'PLATFORM'`) while their publisher platform agreement is
unaccepted (`Publisher.activatedAt` null); the listing stays a draft; the app
shows the text (`GET /agreements/current/PLATFORM`), records the click
(`POST /supply/agreements/accept-platform`) and retries. An agent's submit is
not gated here — their ladder carries the acceptance. The readiness figure
no longer counts the terms (`READINESS_WEIGHTS` profile 70 / kyc 30 / terms 0).

**QR-8 (17 Sep 2026): drafts, and the `LST-` reference.** The owner: "allow
draft facility for listings and campaigns … to reach out to advertisers or
publishers later with sales team or onboarding team. We might need
alphanumerical unique listing IDs too." A campaign has been a draft from its
first step since DR 03; this is the listing's half. `ListingDraft` holds the
wizard's answers as the phone has them, the step the person stopped on, and
a reference minted off the `LISTING` identifier series (`LST-DDMM-YYNN`) —
the reference the listing takes when the draft is finished (`POST /listings
{ draftId }` carries it over and removes the draft), so the publisher and the
desk call the spot by one name from the first save to going live. Every NEW
listing is minted its reference at creation from the same series (rows from
before QR-8 keep their `ADX-LST-nnnnn`; `submitListingForReview` mints for
any still without — the old row-count allocator is retired). Routes:
`GET/POST /listings/drafts`, `PUT/DELETE /listings/drafts/:draftId`
(PUBLISHER, their own); `GET /listings/drafts/desk?idleDays=&q=&category=&sort=IDLE|NEWEST`
(ADMIN): every publisher's drafts with the publisher's name, number and city
beside each and `idleDays` since the last save — the sales and onboarding
teams' call list. Registered before `/:listingId`.

**QR-5: verified first on browse.** `findActive` reads two partitions — the
spots of VERIFIED publishers (and ADX's own, which carry no publisher), then
the rest — each in the asked sort, and cuts one page across them: the page
is filled from the verified first, the remainder from the unverified with
the offset moved past the verified count, so page 2 continues exactly where
page 1 stopped. (A `KycStatus` enum sorts PENDING before VERIFIED, so the
database cannot do it in one `orderBy`.) The partition is one more clause in
the `AND` list, so `q`'s `OR` and the place clause keep their seats. Every
browse card and the spot page carry `publisherVerified` (boolean; true for
ADX's own), the mark the advertiser sees, and (QR-7) `publisherAvatarUrl`,
the publisher's profile picture when they added one.

The publisher's verb is `/submit`: DRAFT → PENDING_REVIEW, minting the
`ADX-LST-nnnnn` reference and stamping `submittedAt`. ADX has three answers:

- `GET /review` — everything at PENDING_REVIEW, oldest wait first, each row
  with its publisher, agent, photo count, a document summary, the asking price
  as decimal strings and the rate-card verdict from `rate-cards#checkGate`.
- `GET /:listingId/review` — the full case: every photo and document, the
  vocabulary the spot was filed under, its content rules and the gate.
- `POST /:listingId/send-back` — `{ reason, outcome? }`. The reason is stored
  on `Listing.rejectionReason`, where the publisher's own app already reads
  it. `CHANGES_REQUESTED` (the default) moves the listing back to DRAFT and
  clears `submittedAt`, so the publisher can fix and `/submit` again and the
  SLA clock restarts; `REJECTED` is terminal.
- `POST /:listingId/publish` — approve. Also the door for Lot A (Q31): with
  `listings.autoPublishOnVerification` off, a cleared site visit leaves the
  listing at `AWAITING_SITE_VERIFICATION` and this is how a person publishes
  it. Accepted from `DRAFT`, `PENDING_REVIEW`, or `AWAITING_SITE_VERIFICATION`
  **with `verifiedAt` set** — the switch asks for a human look at a verified
  spot, not for a way round the site visit. ACTIVE, `publishedAt` stamped,
  `rejectionReason` cleared.

Every decision is written to the activity log as `LISTING_SENT_BACK` or
`LISTING_PUBLISHED` with the listing id.

**There is no CHANGES_REQUESTED status.** `ListingStatus` has none, and the
schema is not this module's to extend. A DRAFT carrying a `rejectionReason` is
that state, and nothing else writes that combination; a resubmission keeps the
reason on the row (the queue exposes it as `priorReason`) so the reviewer can
check the fix against the ask, and publishing is what removes it.

Document verification itself stays with `supply`
(`PATCH /supply/documents/:documentId/review`); this module reads documents
beside the listing and never writes them. Note that publishing from the desk
goes straight to ACTIVE — the `AWAITING_SITE_VERIFICATION` step in the supply
lifecycle is the path `supply#reviewDocument` drives for listings that came
in through an attempt at AWAITING_DOCUMENTS, not a gate this route enforces.

## The city key (Lot X-B)

`Listing` carries `cityId` beside the free-text `city` — the `City` row the
string denotes, stamped by the service through `pricing.withCityKey` on
`createListing` (the listing importer creates through it), `updateListing` when a patch carries `city`, and `supply`'s attempt batch (`buildCityKeyResolver`, once per batch); null for a typed town the catalogue lacks, and the string stays as typed
(the owner's rule). A caller never sends the key. `GET /listings?city=` (ADMIN) takes a slug (a name still resolves) and matches by the key, the `contains` spelling only for rows whose key is null; `publishListing`'s city gate judges the row by its key. The admin-overview analytics group and filter spots by the key.

Lot X-L — the two reads that were still on the string:

- **`findSimilar` (`GET /listings/:id/similar`)** compares by the key when the listing carries one (a spot typed 'Bangalore' is compared with every spot keyed to Bengaluru), else by the string as before.
- **`GET /listings/browse?city=` and `/browse/categories?city=` stay on the spelling BY DESIGN** — a shopper types, and a town nobody catalogued must still find its spots. But `browse.service` resolves the typed value through `pricing.cityKeyFor` and, when it resolves, the repository matches rows keyed to that city **or** the `contains` spelling (`browsePlaceClauses`, one AND clause so `q` keeps the top-level OR), so a shopper typing 'Bangalore' sees the Bengaluru listings whatever they were typed as. Nothing resolved: the spelling alone. The near box is unchanged.

## Owned Prisma entities

`Listing`, `ListingPhoto`.

## Public exports (`index.ts`)

- `listingRouter`.
- `audienceForSpots(spots, period)`, `currentPeriod()` — G7 (Q109): the
  per-spot panels through the snapshots for `campaigns`' analytics; never
  throws (a vendor failure on one spot is that spot's null and a log line).
  Y-B: answers `{ vendor, vendors, policy, spots: [{ listingId, audience:
  BlendedAudienceCatchment | null }] }`; `geo`'s city profile also reads its
  sample grid through here under synthetic `city:<slug>:<n>` keys (no FK on
  `AudienceSnapshot.listingId`), so a grid point costs one call per vendor
  per month like a spot.
- `storedAudienceForListings(listingIds, period)` — Y-B: the STORED rows for
  these listings in a month, blended by the policy in force, **no vendor
  called**; rows of a vendor no longer enabled are left out, expired rows
  are folded (they still describe the month). Null altogether with nothing
  enabled. `geo`'s city profile folds a city's spots through it,
  null altogether when no vendor is configured.
- `similarListingsHandler` — mounted separately, see above.
- `getListingsForPublisher(publisherId)` — used by `publishers`.
- `getListingWithPublisher`, `setListingAvailability`, `getListingById` — used
  by `orders` and `order-milestones`. Lot G: `setListingAvailability(id,
  false)` on a loop writes only when the screen is full today.
- `hasSlotLeft(listing, { from, to }, options)`, `listingsWithNoSlotLeft`,
  `slotHoldingOrdersWhere`, `liveReservationsWhere`, `windowFor`,
  `SLOT_FREE_ORDER_STATUSES`, types `SlotWindow`, `SlotHoldOptions` — Lot G
  (Q116/136): the slot rule for `orders` (placement) and `campaigns` (the
  checkout clash and the calendar's order rows). G10: `slotsHeldWith(db, …)`
  and type `SlotCountClient` — the count itself, for the `orders` and
  `campaigns` repositories to take inside their locking transactions. See
  "Slots" below.
- `retireListingsForPublisher(publisherId)` — used by `account-lifecycle` when
  an account closes (Lot A, Q21). Sets every non-terminal spot to `INACTIVE`
  and clears `availableNow`; never deletes one, because orders, accruals and
  ledger legs still point at it.
- `savedSpacesRouter` — Lot D (Q5), mounted by bootstrap at `/advertisers`.
- `spotPageRouter` — E11-2, mounted by `bootstrap/create-app` at the
  application root: `GET /s/:displayId`, the public spot page.
- `setListingRatingSnapshot(listingId, { ratingAvg, reviewCount })` — Lot D
  (Q104): `reviews` recomputes a spot's stars on every review and hands the
  aggregate here, so `Listing.ratingAvg / reviewCount` stay this module's
  columns. `ListingWithPublisher` now carries the publisher's `address`,
  `city`, `state` for `orders`' instant acceptance.
- `listContentCategories`, `getContentRules(listingId)`, type `ContentRule` —
  Lot D (Q138): the content taxonomy, read by `campaigns` for the wizard's
  content-category question and the venue-stance check at creative submit.
- `updateListing`, `unpublishListing(listingId, { reason, actorUserId })` —
  Lot E. Registered by bootstrap into two ports this module cannot be
  imported through: pricing's `ListingRepricePort` (a BINDING factor writes
  the rate through the ordinary update — surge stamp, unit pair and all —
  Q125) and rate-cards' `ListingEnforcementPort` (a rejected CARD_REVISION
  case, after its grace and with no order running, takes an ACTIVE listing
  to INACTIVE — Q97). `unpublishListing` refuses 409 on anything not ACTIVE,
  audits `LISTING_UNPUBLISHED` with the reason, and tells the publisher.
- `createListing`, `assertCanCreateForPublisher`, types `ListingDraft`,
  `ListingActor`, `LISTING_CATEGORIES` — Lot U: the listing importer
  (`party-imports`) creates every imported spot through the console's own
  door under the act rule an agent's own listing creation uses, then files
  it under a supply attempt; it never writes a `Listing` row and never makes
  one ACTIVE.

## Dependencies

- `shared/audience` — G7 (Q109) / Y-B: the vendor seam (`getAudienceSetup`
  — the enabled set, the policy, the radius — `askVendors` / `askFailure`,
  `blendAudience`) behind `audience.service.ts`. `AudienceSnapshot` is this
  module's table (`findAudienceSnapshot`, `findAudienceSnapshots`,
  `upsertAudienceSnapshot`), one row per (listing, vendor, period);
  `advertiserHasSpot` reads the campaign tables here because `campaigns`
  imports this module and reaching back would close a cycle.
- `agents` — `requireAgentProfile` when resolving the owning agent on create;
  `findAgentProfile` for the ownership checks.
- `access-grants` — `holdsLiveGrant` for delegated edits.
- `pricing` — `classifySpot` and `activeSurge` on create and reprice.
- `rate-cards` — `assertPublishable` on publish, `checkGate` for the desk,
  `belowFloorFlags` for the admin table's chip (Lot E).
- `notifications` — the publisher is told when a spot is taken off the
  market (Lot E).
- `ai` — `translateListings` on the admin listing.
- `config/env` — E11-2: `PUBLIC_WEB_URL` for the card's `shareUrl`,
  `BASE_URL` / `PORT` as its fallback, `APP_STORE_URL` / `PLAY_STORE_URL`
  for the public spot page's store links.
- `shared/security` — `spotPageLimiter` on the public spot page.
- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/money`, `shared/audit`, `shared/database` (repository only).

## Invariants

- **Suspension is written elsewhere.** `Listing.suspensionScopes`,
  `suspensionReason` and `suspendedById` belong to `modules/suspension`, which
  also sets `status` SUSPENDED for BLOCK_NEW and cascades a publisher's
  BLOCK_NEW and STOP_ACCRUAL onto every one of their spots. The
  `/listings/:id/suspend` route lives there; this module reads the columns like
  any other reader. A reinstated spot returns to ACTIVE only when it was
  published and its verification has not lapsed — see that module's README.

- **`GET /listings` is a page, not an array.** It returns
  `{ items, total, page, pageSize, counts }` — the DR 10 table prints the total
  in its range readout and labels its status chips from `counts`, so the three
  travel together or the header and the rows disagree mid-scroll. It was an
  unbounded `findMany` of every listing with every publisher, agent and photo
  joined; `pageSize` is capped at 100.
- **The status histogram ignores the caller's own status facet.** `counts` is
  computed over the search, city and category clauses *without* `status`, so
  selecting PENDING_REVIEW still reports how many ACTIVE rows exist. Counting it
  over the full clause would zero every unselected chip and leave no way back.
  Every value of `LISTING_STATUSES` appears, including the zeroes — a facet that
  vanishes when empty is a facet nobody can return to.
- **`sort=SUBMITTED` puts nulls last.** `submittedAt` is null on anything never
  sent for review; the column exists to work the queue, so those sort to the
  end rather than the front.
- **Publishing is a state transition, not a patch.** `status` is deliberately
  absent from the update schema; only `POST /:listingId/publish` changes it to
  ACTIVE, and only from `DRAFT` or `PENDING_REVIEW`, stamping `publishedAt`.
  Anything else is **400**. Below the rate-card floor is **409**
  `BELOW_RATE_CARD_FLOOR` (see `rate-cards`).
- **Publishing is ADX's.** `/publish` is ADMIN-only. It used to admit the
  publisher and their agent, which made the review optional.
- **A send-back needs a reason** (five characters at least) and a listing that
  is actually at PENDING_REVIEW; anything else is **409**.
- `PATCH` performs no existence check — an unknown id surfaces as Prisma's own
  error, as it did before. Adding a 404 would change the response.
- Passing `agentId` on create is ADMIN-only (**403** otherwise); an unknown
  agent is **404**. Everyone else gets their own agent profile.
- The admin listing joins `publisher`, `agent` and `photos`; the per-publisher
  listing joins only `photos`. Both shapes are contract.
- "Similar" means: same category, same city, `status: ACTIVE`, price within
  ±30%, cheapest first, at most 5, excluding the listing itself.

## Tests

```bash
npx vitest run src/modules/listings
```

`listings.review-flow.test.ts` walks submit → send back → resubmit → publish
through the real Express app against an in-memory repository.
`listings.suggested-rate.test.ts` is Lot E: the offer, the accept, the
unpublish a rejected price case triggers, and the `belowFloor` stamp.

## Suggested ownership

Supply-side team, alongside `publishers`.

## Lot D: the marketplace models

- **The browse card** (`BrowseCard`) gained `ratingAvg` (decimal string, two
  places, or null), `reviewCount`, `instantBooking` and `saved`. `saved` is
  resolved for the calling advertiser — their own account, or the one an
  agent names in `advertiserId`, checked through `advertisers.assertMayActFor`
  — in **one IN query per page**, never a lookup per row; a caller with no
  advertiser (ops, a publisher) reads every card unsaved. `sort=RATING` is
  best-rated first with the unrated last and a bigger sample breaking ties;
  `instant=true|false` is a three-state facet like `illuminated`.
- **Saved spaces are per advertiser account** (Q5/Q104), never per person:
  an agent under a grant saves into the advertiser's book. Saving is
  idempotent (the unique on `(advertiserId, listingId)`), unsaving what was
  never saved is not an error, and only a live spot can be saved. The list
  leaves out a spot that has gone off the market rather than drawing it as
  bookable; the row stays, so it returns if the spot does.
- **Instant booking is the publisher's opt-in, behind a flag** (Q6/Q105).
  `instantBooking` is accepted on create and update. Switching it **on**
  needs `isFeatureEnabled('instant-booking', publisherId)` (409
  `FEATURE_OFF`) and a publisher with somewhere to send the agent — street
  address, else city and state, the same fallback the accept screen uses
  (409 `NO_MEETING_PLACE`). Switching it off asks nothing. What an instant
  spot does at placement is `orders`' (`placement.service.ts`); the
  publisher's own rows (`GET /publishers/:id/listings`) carry the column
  because they are the Listing row.

## G12-B: `display` on the browse card

Every browse card (`/browse`, `/browse/:listingId`, the saved-spaces list)
carries `display: 'DIGITAL' | 'STATIC'` — the verdict of the one loop rule
`slots.service.carriesLoop` applies (the sub-type, the media type's name or
the catalogue heading it sits under names a screen: `digital`, `LED`, `LCD`,
`screen` as a word of its own), so the apps stop repeating the rule. The
browse rows join `mediaType { name, formatGroup }` for it (`browseInclude`);
a row read without the join is STATIC unless the sub-type says otherwise.
The `display=` *facet* on `/browse` is unchanged (a sub-type containing
"digital"); the card's field is the wider rule.

## Slots (Lot G, Q116/136) — `slots.service.ts`, `slot-holds.ts`

- **`Listing.slotsTotal`** is how many advertisers the spot carries at once:
  a digital screen's loop, 1..24; a static wall's 1 (the column's default).
  Accepted on create and on patch (`slotsTotal`, integer). **The rate stays
  per slot per day** — a six-slot screen at ₹1,000 is ₹1,000 to each of six
  advertisers, and browse's `ratePerDay` is unchanged.
- **Which spots carry a loop.** `ListingCategory` (INDOOR / OUTDOOR /
  TRANSIT / MEDIA) says where the spot is, not what it is made of, so it
  cannot decide. The rule reads the same evidence as browse's
  `display=DIGITAL` facet: the `subType` the publisher typed and the media
  type the classifier resolved (its `name`, or the catalogue `formatGroup` it
  sits under — "Digital Displays"). A spot is digital when any of the three
  names a screen: `digital`, `LED`, `LCD`, or `screen` as a word of its own
  ("Screen-printed vinyl" is not a loop). `slotsTotal > 1` on anything else
  is **400** `VALIDATION_ERROR`, at create (after classification, before the
  insert) and at any patch that touches the count, the sub-type or the media
  type; a patch that brings the count back to 1 in the same breath passes,
  and a title edit asks nothing.
- **What holds a slot** (`slotHoldingOrdersWhere`, `liveReservationsWhere`):
  over a window, every order on the listing whose flight overlaps it and is
  still running — anything but DRAFT, CANCELLED and PUBLISHER_REJECTED, a
  COMPLETED order only until its `endDate` (`endCampaign` writes it to free
  the spot; a completed order with none holds nothing) — plus every live
  campaign reservation (RESERVED under an unexpired `reservedUntil`, Lot C
  Q88), which has no order yet. A BOOKED/LIVE campaign spot has an order and
  is counted once, through it. An order with no dates overlaps every window.
  The two clauses live in `slot-holds.ts` and are used by this module's
  repository, `campaigns`' repository (the clash check) and `orders`'
  repository (the calendar), so the count is the same everywhere.
- **G10 — a hold is the quantity, not the row.** A campaign spot's `quantity`
  is priced per slot, so it holds that many: the count is `sumSlotHolds`
  (`slot-holds.ts`, pure) over the two hold queries — each running order
  holds the `quantity` of the campaign spot behind it (1 for an order placed
  on its own) and the live reservations are summed on `quantity` by the
  database — and it runs through `slotsHeldWith(db, listingIds, window,
  options)` in `prisma-listings.repository.ts` on **any** Prisma client: the
  repository's own for browse, or the transaction that holds a listing's
  advisory lock in `orders` (placement) and `campaigns` (the reservation
  hold), so the count and the write those two guard are one act. Exported
  from the index for those two repositories only; nothing outside a
  `prisma-*.repository.ts` may call it.
- **`slotsLeft`** on a browse card is `slotsTotal - held`, never below zero,
  over the asked window: `from`/`to` when given, the day of `from` when only
  it is, today's UTC day when neither is (`windowFor`). One `groupBy` per
  page, never a query per row. A multi-slot spot stays in a `to`-windowed
  browse even when full — its card says `slotsLeft: 0` — because SQL cannot
  count the loop against its holds; a static wall is hidden as before (E7-2).
- **`availableNow` on a loop is derived, not a switch**: `setListingAvailability(id, false)`
  — what `orders` calls when a slot is confirmed or the order approved —
  writes only when the screen has no slot left today. A static wall flips
  as it always did.
- The refusal at placement and the clash at checkout are `orders`' and
  `campaigns`' (their READMEs); both count through this module and both say
  "no slot left", never "booked".

## The city gate (Lot A Q31, Lot V)

`createListing` calls `pricing.assertCityAllows(city, 'supplyIntake')` before
writing and `publishListing` calls `assertCityAllows(city, 'publishing')`
after the rate-card gate: a spot cannot be filed, or go live, in a catalogued
city whose rollout stage has that function off (`400 CITY_NOT_OPEN
{ stage, function, city }` — a SEEDING city takes listings and publishes
none; PAUSED and WITHDRAWN take nothing), and **can** be filed in a town the
catalogue has never heard of — free text stays free. There is no gate on
update because no patch can move a listing's city: `city` is not in
`ListingPatch` or `updateListingSchema`. The stages and switches are
`geo`'s (`modules/geo/README.md`).

Two more Lot V edges here: `GET /listings/browse?city=` naming a catalogued
city with `demand` off answers `{ items: [], total: 0, page, pageSize,
comingSoon: { city, slug, stage } }` instead of rows, so the phone draws
"coming soon" and the waitlist; and `unpublishListing` takes an optional
`cause` — `CITY_WITHDRAWN` from the city wind-down (audited in the
LISTING_UNPUBLISHED metadata; the "raise the rate and relist" in-app line is
not sent, `geo` tells the publisher once per city instead) — beside the
default `PRICE_CASE`.

## QR-20 (17 Sep 2026): the sub-categories are tiles too

| Route | Who | What |
| --- | --- | --- |
| `GET /listings/browse/venues?city=&lat=&lng=&radiusKm=` | any session | every active `VenueType` of the catalogue for the place — `{ venueTypeId, slug, name, label, category, count, photoUrl }` — counted from the live spots there, the newest spot's public photograph on the tile; ordered by the frame's category order, the counted venues, then the curated venues people look for first (`VENUE_ORDER`), then the alphabet. `label` is the tile's word (`venueLabel`: a short name where one is known, the catalogue name's first segment otherwise) |
| `GET /listings/browse?venueTypeId=` | as before | the browse cut to one venue, beside `category` |

The user app's home strip (four categories, then the counted venues, capped at
sixteen, two rows sideways) and the Explore grid (the sub-categories under
each category) read the first; a tile tapped browses with the second.
`npm run seed:demo-listings [+91mobile]` writes the dev demo set — a demo
publisher, twenty live listings (five a category, one per venue) with
pictures, and five campaigns with spots, orders and daily metrics for the
advertiser named (default +919000000101).

## QR-23 (20 Sep 2026): the platform demo — `npm run seed:demo`

`seed:demo` = `seed:demo-listings` (the demo publisher, its twenty spots,
Advait's five campaigns) followed by `seed:demo-platform`
(`src/scripts/seedDemoPlatform.ts`), which fills the rest of the platform in
around them so every desk and overview has something to count: three agents
(verified KYC, both roles, credited and pending incentives, visits, leads in
every stage), four more publishers across Bengaluru, Hyderabad and Mumbai in
every KYC state and every onboarding door (agent, desk, self) with the demo
spots redistributed by category and eight new spots in every listing state,
four more advertisers of every legal form with brands and billing details,
funded through the real top-up door, eight more campaigns (completed, live,
scheduled, awaiting payment, cancelled) booked the way checkout books them —
a wallet hold, then the capture that posts the `CAMPAIGN_SPEND` ledger legs
the dashboard's GMV reads — with spots, orders, daily metrics, a tracking
code with its events and reviews on the completed spots, the daily accrual
run (publisher earnings, ADX commission, the take rate), a payout method, a
paid withdrawal and a pending one.

Idempotent: parties are keyed by mobile (+91 90000 002xx publishers, 003xx
agents, 004xx advertisers), campaigns by reference (`ADX-CMP-2026-DEMO06`
to `13`), listings by title. The ledger is append-only, so the demo is not
deleted row by row: to remove it, reset the dev database and re-run the
base seeds in this order — `seed:cities`, `seed:geo`, `seed:venues`,
`seed:pricing`, `seed:revenue`, `seed:config`, `prisma/seed.ts`. Over a
remote database a day's accrual can outlive Prisma's 5 s transaction
window; the run is idempotent per spot and day, so the script makes up to
three passes.
