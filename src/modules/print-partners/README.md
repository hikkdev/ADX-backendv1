# print-partners

The print shops ADX pays to deliver a booking — as payees (Lot B, Q50/B4b,
12 September 2026) and, since **Lot H** (Q147, the owner's 6 Sep and 13 Sep
mechanics, 14 September 2026), as a **floor of their own in the user app**.

Owner decisions that bind this module: **50** (a print partner is a payee; an
offline settlement is still recorded), **122** (paid per job at cost approval),
and the 6 Sep mechanics behind **147**: partner onboarding is for *printing*
partners (a publishing partner is a publisher with a title); ops create the
account and **activate** it so the partner signs in by OTP on their own phone
(Lot V: both the create and the activation pass
`pricing.assertCityAllows(city, 'printPartners')` — 400 `CITY_NOT_OPEN` in a
catalogued city whose rollout stage has print partners off; a town the
catalogue lacks is free text);
at profile configuration the partner uploads a **rate card** or opts to
receive **quote requests**; a partner with a rate card is preferred and asked
first, otherwise a request goes to the partners in reach that accept requests
and the **lowest quote is accepted** (ops may award another with a reason);
the print charge is the partner's quoted, mutually agreed price — **never
predefined**.

## What a print partner is

Three rows:

- a **User** with role `PARTNER`, created `isActive: false`. Lot H: ops
  **activate** it (`POST /print-partners/:id/activate`) — `User.isActive`
  true, `activatedAt`/`activatedById` stamped, an SMS (kind `INVITE`, event
  `PARTNER_ACTIVATED`) saying the ADX app now takes this number. From then on
  the ordinary `POST /auth/send-otp` + `verify-otp` answers the ordinary token
  pair; the app decides the floor by the PARTNER role. Deactivating the
  partner switches the account off **and ends every session**
  (`auth.revokeSessions`); reactivating switches it back on only if it had
  been activated. The mobile is the account's identity — unique on `User`,
  never attached to an existing person's account (409). **PP-1 (the owner,
  21 Sep 2026)**: a shop may also *apply* from the app — the sign-up's third
  side, "I print and install" — which opens the account the other way round:
  the row is created under the shop's own signed-in user with `appliedAt`
  stamped and `activatedAt` null, the PARTNER role granted at once (so the
  floor answers `/me` and shows the application), and the desk reviews it
  under Print partners › **Applications** and activates it through the same
  `POST /print-partners/:id/activate` an invited partner gets. An account
  that already holds a publisher, advertiser or agent side is refused (409
  `CONFLICT`) — a shop is its own account. Applying twice returns the
  application;
- a **PrintPartner** row — legal name, GSTIN, PAN, the contact, the address
  the agent collects from, capabilities, the widest print, the turnaround,
  a `PRT-DDMM-YYnn` identifier; Lot H adds the rate card
  (`rateCardFileId`, `rateCardRows`, `rateCardUpdatedAt`),
  `acceptsQuoteRequests` and `invoiceUploadFileId`;
- a **Wallet** with the fourth owner key (`Wallet.printPartnerId`), opened at
  creation.

## Routes

### The desk (ADMIN)

```
GET   /print-partners                       list contract: q, city, active, applied, page, pageSize → { items, total, page, pageSize, counts: { ACTIVE, INACTIVE } }; PP-1: `applied=true` narrows to the applications awaiting the desk (`appliedAt` set, `activatedAt` null); every row carries `appliedAt`
POST  /print-partners                       { name, mobile, legalName?, gstin?, panNumber?, contactName?, email?, address?, city?, latitude?, longitude?, capabilities?, maxWidthFt?, turnaroundDays?, notes? } → 201; PRINT_PARTNER_CREATED
GET   /print-partners/:id                   the row — Lot H adds activatedAt, activatedById, acceptsQuoteRequests, rateCard { hasRateCard, fileId, fileUrl, updatedAt, rows }, invoiceUploadFileId; G13-B: `lastLoginAt` (User.lastLoginAt behind the partner, null until they sign in) — on the list rows too, one lookup per page
PATCH /print-partners/:id                   any of the above but the mobile; G13-B: `acceptsQuoteRequests` too (the desk flips the switch for a partner who never activates); PRINT_PARTNER_UPDATED with the diff
POST  /print-partners/:id/deactivate        { reason? }; off the roster and off the app (sessions ended), idempotent; PRINT_PARTNER_DEACTIVATED
POST  /print-partners/:id/reactivate        PRINT_PARTNER_REACTIVATED
POST  /print-partners/:id/activate          Lot H: the account switched on, the partner told by SMS; idempotent (`activated: false` the second time); 409 off the roster; PRINT_PARTNER_ACTIVATED. Lot N: with `kyc.printPartnerActivationRequiresKyc` on (platform settings; default false — today's behaviour) a partner whose `PrintPartner.kycStatus` is not VERIFIED is refused 409 `KYC_REQUIRED` (`details.kycStatus`); the row's own column, read through this module's repository — N-B2's record moves it
GET   /print-partners/:id/ledger            { partner, walletId, balances, entries (limit, cursor), withdrawals, jobs, jobCounts, invoices }
GET   /print-partners/:id/rate-card         Lot H: { partnerId, hasRateCard, fileId, fileUrl, updatedAt, rows }
PUT   /print-partners/:id/rate-card         G13-B: the desk sets the card on the partner's behalf — `rateCardSchema` exactly; the file the partner's own or the admin's PARTNER_RATE_CARD upload (on behalf or under their own hand); PARTNER_RATE_CARD_UPDATED with `onBehalf: true`
POST  /print-partners/:id/invoices          G13-B: { fileId (PARTNER_INVOICE, the admin's own upload or the partner's), month: YYYY-MM } → 201 — for a partner who never activates; PARTNER_INVOICE_UPLOADED with the month and `onBehalf: true`
GET   /print-partners/:id/invoices          G13-B: every invoice on file with its month — the partner's own PARTNER_INVOICE files plus the ones an admin recorded on their behalf, the month and `recordedBy` (PARTNER | ADMIN) read off the PARTNER_INVOICE_UPLOADED audit rows; a file never recorded carries `month: null`
GET   /print-partners/:id/quotes            Lot H: the partner's quote history, newest first

GET   /print-quote-requests                 G13-B (ADMIN, behind partners.quotes): the desk's list across orders on the list contract — ?status=OPEN,AWARDED,CANCELLED,EXPIRED&q=&page&pageSize, OPEN first and nearest deadline first; every row { id, orderId, order { id, status, campaignName, site { id, title, city } } | null, status, city, deadlineAt, inviteMode, invitedCount, reinvitedAt, standingQuotes, lowest { quoteId, amount, turnaroundDays, partner { id, name } } | null, awardedQuoteId, cancelReason, createdAt } — so the console stops fanning out `GET /orders/:id/print-quote-request` per order. `q` matches the order id or the city

GET   /orders/:id/print-job                 the job with the partner the agent collects from
POST  /orders/:id/print-job                 { printPartnerId, quotedCost?, specs?, notes? } → 201; PRINT_JOB_OPENED; Lot H: the partner is told (PRINT_JOB_ASSIGNED)
PATCH /orders/:id/print-job                 { status?, actualCost?, notes? }; PRINT_JOB_UPDATED with the diff
POST  /orders/:id/print-job/approve-cost    + finance.approve — the money; PRINT_COST_APPROVED

POST  /orders/:id/print-quote-request       Lot H: { specs, deadlineAt? (default now + 48 h), invite: 'AUTO' | partnerIds[] } → 201; PRINT_QUOTE_REQUESTED
GET   /orders/:id/print-quote-request       Lot H: the latest request, every quote ranked, `lowestQuoteId` and `lowest: true` on the row
POST  /orders/:id/print-quote-request/award Lot H: { quoteId?, note? } — the lowest by default; another only with a note (400 NOTE_REQUIRED); PRINT_QUOTE_AWARDED. G13-B: runs under a per-request lock (below); a second concurrent award answers 409
POST  /orders/:id/print-quote-request/cancel G13-B: { reason } — an OPEN request goes CANCELLED with the reason and the moment in the envelope (`cancelReason`, `cancelledAt` on the desk read); the quotes stay as the record of who bid; every invited partner is told (PRINT_QUOTE_REQUEST_CANCELLED); anything but OPEN is a 409 — an awarded request is undone through the job's decline; PRINT_QUOTE_REQUEST_CANCELLED audited
```

The job and quote-request routes are mounted at `/orders` **after** the
orders router (they pass through its `authenticate` first, like
`/orders/:orderId/milestones`). The quote-request routes carry
`requireFeature('partners.quotes')`.

### The partner's KYC (Lot N, owner 14 Sep 2026) — three paths, one record

`PrintPartnerKyc` is the publisher's business branch for the shop — the PAN
(`panNumber`, `panFrontUrl`, `panSignatureUrl`), the GST certificate
(`gstUrl`), the registration certificate (`businessRegCertUrl`), the
business address proof (`businessAddressProofUrl`), a director's id
(`directorIdUrl`), the government id (`govIdType`, `govIdFrontUrl`,
`govIdBackUrl`), the bank proof (`bankProofUrl`) and a selfie (`selfieUrl`)
— with the Digio columns, the review columns, the escalation columns,
`imagesPurgedAt`, and Lot N's `requestedAt / requestedById /
requestedChannel` (DIGIO | MANUAL) and `recordedById / recordedVia` (SELF |
DESK | DIGIO). `PrintPartner.kycStatus` **mirrors the record on every
status write**, in the same transaction (`prisma-print-partner-kyc.repository`),
so the roster never disagrees with the desk. The code is `kyc/` in this
module: `print-partner-kyc.service.ts` (the three paths and the desk),
`print-partner-digio.service.ts` (the provider), the schema, the controller,
the router and the Prisma repository. Every document is a **private file
uploaded under `PRINT_PARTNER_KYC`** (uploads) and named by the URL the
upload returned; a public URL, another purpose or somebody else's file is
refused before anything is written.

The three paths:

1. **SELF** — the partner on their own phone (`/print-partners/me/kyc*`,
   PARTNER behind `print.partner-kyc`): the documents, or a Digio session.
   A submission stamps `recordedVia: SELF` and goes PENDING with a fresh
   `submittedAt`; a NEEDS_INFO resubmission is partial — only the flagged
   tiles — and a body naming **no document** is 400 `EMPTY_RESUBMISSION`
   (E9's rule on this column set); the decisions on the fields sent are
   cleared. N2-B: a VERIFIED record is refused 409 `KYC_ALREADY_VERIFIED`
   until the desk moves it to NEEDS_INFO. Audited
   `PRINT_PARTNER_KYC_SUBMITTED` under the partner.
2. **DESK** — an admin records the documents on the partner's behalf
   (`PUT /print-partner-kyc/:id`): the same body, the files the partner's
   own or the admin's upload on their behalf, `recordedVia: DESK` and who.
   N2-B: 409 `KYC_ALREADY_VERIFIED` over a verified record — by the
   record's id or the partner's — before anything is written. The
   liveness gate is still the partner's — their own video, or (N-B1)
   the admin's presence attestation on the partner's user.
3. **The desk's ask** — `POST /print-partner-kyc/:id/request { channel, note? }`:
   the row is made if there is none and stamped `requestedAt / requestedById
   / requestedChannel`; for **DIGIO** a session is opened on the partner's
   behalf (Digio sends its link to the partner's own email or mobile, never
   the admin; `submittedAt` waits for the webhook); either way the partner
   is told through `KYC_REQUESTED` (email, SMS, push deep-linking to
   `adx://partner/kyc`, and the in-app row) with the note. 409
   `KYC_ALREADY_VERIFIED` on a verified record. The queue's **`requested`
   facet** is "the desk asked and nothing has come back" — `requestedAt`
   set and `submittedAt` null.

**Digio.** The reference ADX hands Digio is `adx-pp-<partnerId>-<ts>`; the
webhook is routed the way every party's is — by the request id Digio
minted. ADX has one callback (`publishers`); a request id no publisher row
claims is offered to the handlers registered at boot, and
`handlePrintPartnerDigioWebhook` is registered after the advertiser's
(`bootstrap/register-modules`). A decision lands on the row with
`recordedVia: DIGIO` and no recorder — and, N2-B, an **approval** stamps
`method: DIGIO` whatever was sent by hand while the session was open, so
the record is Digio-verified (the liveness gate exempts it; the purge
finds it); a rejection leaves the method alone — the mirror moves, and the
partner is told `KYC_DECISION`. The desk's `POST /:id/digio/restart` opens a fresh session
on the partner's behalf (409 once verified; `PRINT_PARTNER_KYC_DIGIO_RESTARTED`).

**The desk** (`/print-partner-kyc`, ADMIN at the router, behind
`print.partner-kyc`) is the advertiser desk's, tile for tile — `:id` is the
KYC record's id, **or the partner's own id** for a partner with no record
yet (the PUT and the request make the record):

```
GET    /print-partner-kyc                         ?state=&status=&requested=true|false&assignedTo=me|none&escalated=true|false&q=&sort=newest&page&pageSize → { items, total, page, pageSize, counts (per state + awaitingDocuments + escalated + requested), breached, escalated, requested, slaHours }. N3-B: the queue lists PARTIES — every print partner not yet verified plus every partner with a record — each row the record's columns (all null with no record) spread under `state` (AWAITING_DOCUMENTS | REQUESTED | PENDING | NEEDS_INFO | REJECTED | VERIFIED, `shared/kyc-state`), `kycId` (null with no record), `printPartnerId` and the `printPartner` slice (id, displayId, name, mobile, email, userId, city, isActive, kycStatus, createdAt); `id` is the record's or, with none, the partner's — either works as `:id` below. `?state=` is the facet, `?status=` its alias, `?requested=true` the REQUESTED state; the chips count partners per state with the facet removed; late submissions first, then parties with nothing in by when they arrived. Every row still carries ageHours / slaBreached, `requested`, and assignedTo / escalatedTo / escalatedBy / requestedBy / recordedBy as { id, name } | null
GET    /print-partner-kyc/:id                     the case: the row with its partner slice, documentReviews[] (KycDocumentReview, party type PRINT_PARTNER, each with reviewedBy), liveness (the partner's user), ageHours, slaBreached, slaHours, reviewedBy / assignedTo / recordedBy / escalatedTo / escalatedBy / requestedBy, `requested`
PUT    /print-partner-kyc/:id                     the desk records the documents — recordedVia DESK; 409 KYC_ALREADY_VERIFIED over a verified record (N2-B); PRINT_PARTNER_KYC_RECORDED_AT_DESK with the diff; answers the case
POST   /print-partner-kyc/:id/request             { channel: DIGIO | MANUAL = DIGIO, note? } — see path 3; PRINT_PARTNER_KYC_REQUESTED; answers the case + `digio { kycId, validTill } | null`. N3-B: DIGIO by default (the console's one click sends no body) and guarded by requirePermission('kyc.edit') beside the router's ADMIN — the catalogue's KYC edit tier; the super admin and an admin with no role config pass under the launch rule
PATCH  /print-partner-kyc/:id/review              { status: VERIFIED | REJECTED, rejectionReason (required on REJECTED), reviewNote? } — 409 LIVENESS_REQUIRED on a manual-path VERIFIED with no liveness proof on the partner's user; clears the escalation; tells the partner KYC_DECISION; PRINT_PARTNER_KYC_REVIEWED with a diff over status, reason and note
PATCH  /print-partner-kyc/:id/documents/:field    { decision: APPROVED | FLAGGED, note (required on FLAGGED) } — one tile; PRINT_PARTNER_KYC_DOCUMENT_REVIEWED
POST   /print-partner-kyc/:id/request-reupload    { fields[], note } — NEEDS_INFO (the mirror too), the flags recorded, the partner told which tiles; 409 once verified; PRINT_PARTNER_KYC_REUPLOAD_REQUESTED
PATCH  /print-partner-kyc/:id/assign              { adminUserId | 'me' | null } — a filter, not ownership; PRINT_PARTNER_KYC_ASSIGNED
POST   /print-partner-kyc/:id/escalate            { reason } — kyc's escalateKyc with party PRINT_PARTNER (KYC_ESCALATED, module kyc, target PrintPartnerKyc); 409 decided / already escalated
POST   /print-partner-kyc/:id/digio/restart       a fresh Digio session on the partner's behalf; 409 once verified; PRINT_PARTNER_KYC_DIGIO_RESTARTED
```

The partner's own (`printPartnerRouter`, ahead of the ADMIN layer):

```
GET    /print-partners/me/kyc                     the record + flagged (the re-upload list with the note) + liveness + requestedBy; 404 before any record or request
POST   /print-partners/me/kyc                     { panFrontUrl?, panSignatureUrl?, gstUrl?, businessRegCertUrl?, businessAddressProofUrl?, directorIdUrl?, govIdFrontUrl?, govIdBackUrl?, bankProofUrl?, selfieUrl?, panNumber?, govIdType? } → 201 — path 1; 400 EMPTY_RESUBMISSION while NEEDS_INFO with no document; 409 KYC_ALREADY_VERIFIED over a verified record (N2-B)
POST   /print-partners/me/kyc/digio/initiate      { kycId, accessToken, validTill, sdkUrl } — the shared client; the row DIGIO / pending with submittedAt; 409 KYC_ALREADY_VERIFIED over a verified record, before Digio is asked (N2 verifier)
GET    /print-partners/me/kyc/digio/status        { method, digioStatus, kycStatus, digioVerifiedAt }; 404 before any record
```

`GET /print-partners/:id`, the roster rows and — N2-B — the partner's own
`GET /print-partners/me` carry `kycStatus` (the mirror) and
`kyc { state, kycId, status, submittedAt, method, requestedAt, requestedChannel }`
(one lookup per page, `withKycSummary`). N3-B: never null — `state` and
`kycId` are derived the way the queue derives them (`shared/kyc-state`), so
a partner with no record answers `{ state: AWAITING_DOCUMENTS, kycId: null,
status: null, … }` and the partner page and the queue agree. The **purge** (`jobs/kyc-purge.job.ts`) treats a
Digio-path partner record like the others — thirty days after
`digioVerifiedAt` the ten image columns go, the PAN is masked, the payload
trimmed, `KYC_IMAGES_PURGED` written against the record; the manual path is
never touched. The **escalation job** walks the partner queue with the
other two (`escalateAgedKycCases` reports `printPartners`). Feature:
`print.partner-kyc` (APP_USER + CONSOLE). The partner's activation does not
yet ask for KYC — that switch (`kyc.printPartnerActivationRequiresKyc`) is
N-B1's.

### The floor (PARTNER, Lot H) — `/print-partners/me/*`

Registered **ahead of** the router's ADMIN layer so `/me` is never read as an
id. Every route is `requireRole('PARTNER')` behind `partners.print-floor`
(the quote routes behind `partners.quotes`); every write is audited under
the partner's own user.

```
GET    /print-partners/me                                    the row + walletId + balances (wallets.snapshot) + rateCard state + (N2-B) kyc { status, submittedAt, method, requestedAt, requestedChannel } | null beside kycStatus; PP-1: `appliedAt` too — the app shows the application until `activatedAt`
POST   /print-partners/me/application                        PP-1: { name, legalName?, gstin?, panNumber?, contactName?, address, city, latitude?, longitude?, capabilities?, maxWidthFt?, turnaroundDays?, acceptsQuoteRequests? } — the shop fills in its own details while the application is open; 409 once activated (PATCH /me from then on); PRINT_PARTNER_APPLICATION_UPDATED (and PRINT_PARTNER_APPLIED when the account chose the side)
PATCH  /print-partners/me                                    { contactName?, email?, address?, city?, latitude?, longitude?, capabilities?, maxWidthFt?, turnaroundDays?, acceptsQuoteRequests? }; PRINT_PARTNER_PROFILE_UPDATED
PUT    /print-partners/me/rate-card                          { fileId? (uploads purpose PARTNER_RATE_CARD, private, the partner's own), rows: [{ material, sizeClass?, unit, ratePerUnit, minQty?, notes? }] } — a file, rows, or both; replaces the card whole; PARTNER_RATE_CARD_UPDATED

GET    /print-partners/me/quote-requests                     list contract (status=OPEN,AWARDED,…, page, pageSize): the requests the partner was invited to, with specs, deadline and `myQuote` — never another partner's quote
GET    /print-partners/me/quote-requests/:requestId          G13-B: the one request, the same sealed shape, whatever its status; 404 unless the partner was invited
POST   /print-partners/me/quote-requests/:requestId/quotes   { amount, turnaroundDays, note? } → 201; one per partner, re-submitted to edit until the deadline; PRINT_QUOTE_SUBMITTED
DELETE /print-partners/me/quote-requests/:requestId/quotes   the standing quote WITHDRAWN (re-submittable); PRINT_QUOTE_WITHDRAWN

GET    /print-partners/me/jobs                               list contract (status=, page, pageSize): { items: [{ ...job, order }], counts by status }
GET    /print-partners/me/jobs/:jobId                        the job + order { artwork (the approved creative, else designUrl), site, agent { name, mobile }, campaignName, dates }, specs, quotedCost
POST   /print-partners/me/jobs/:jobId/accept                 REQUESTED → ACCEPTED, partnerAcceptedAt; PRINT_JOB_ACCEPTED
POST   /print-partners/me/jobs/:jobId/decline                { reason } — REQUESTED/ACCEPTED → CANCELLED, partnerDeclinedAt, declineReason; ops told; the request reopened when the job came from one; PRINT_JOB_DECLINED
POST   /print-partners/me/jobs/:jobId/printing               ACCEPTED → PRINTING; PRINT_JOB_PRINTING
POST   /print-partners/me/jobs/:jobId/ready                  ACCEPTED/PRINTING → READY, readyAt; the agent (PRINT_JOB_READY) and ops told; PRINT_JOB_READY
POST   /print-partners/me/jobs/:jobId/handover               { qrToken } — the agent's PICKUP code scanned by the partner → COLLECTED, handoverConfirmedAt, handoverQrId; PRINT_JOB_HANDED_OVER

GET    /print-partners/me/earnings                           { walletId, balances, allowance (payouts.withdrawalAllowance), entries (limit, cursor), withdrawals }
GET    /print-partners/me/earnings/summary                   G13-B: { thisMonth, lastMonth, pending, paidToDate } — Indian months, from the ledger: the EARNING lines (approved print costs, net of TDS) in this month and the last (`wallets.sumEntries`); `pending` the withdrawals raised, approved or with the rail and not yet paid; `paidToDate` every withdrawal PAID
POST   /print-partners/me/withdrawals                        { amount, payoutMethodId? } → 201 — payouts.requestWithdrawal exactly (VERIFIED method, the default unless named; the minimum; the SMALL_AGENCY daily cap; the cleared balance; the freeze); WITHDRAWAL_REQUESTED
GET    /print-partners/me/payout-methods                     the partner's bank / UPI (payouts.listMethods, masked)
POST   /print-partners/me/payout-methods                     payouts' addMethodSchema → 201, PENDING_VERIFICATION like everyone else's; PAYOUT_METHOD_ADDED
POST   /print-partners/me/invoices                           { fileId (uploads purpose PARTNER_INVOICE, private), month: YYYY-MM } → 201; PARTNER_INVOICE_UPLOADED with the month
GET    /print-partners/me/invoices                           G13-B: the partner's invoices with their months — the same read as the desk's `GET /print-partners/:id/invoices`
```

## The city key (Lot X-B)

`PrintPartner` carries `cityId` beside the free-text `city` — the `City` row the
string denotes, stamped by the service through `pricing.withCityKey` on
`createPartner`, `updatePartner` and the partner's own profile patch (the party importer goes through the first two); null for a typed town the catalogue lacks, and the string stays as typed
(the owner's rule). A caller never sends the key. `GET /print-partners?city=` takes a slug (a name still resolves) and matches by the key, the spelling only for rows whose key is null; `activatePartner`'s city gate judges the row by its key. Lot X-L: the quote fan-out (`createQuoteRequest`, AUTO) resolves the site's typed city through `cityKeyFor` and asks `findPartnersInReach({ city, cityId })` — partners keyed to the city are in whatever either side typed ('Bengaluru' and 'Bangalore' partners are one pool), a partner whose key is null is matched by the spelling, and a site in a town nobody catalogued matches by spelling alone; the 50 km radius is unchanged. The request keeps the site's typed city for display.

## The job

One `PrintJob` per order (`orderId` is unique). Opened against an order that
has reached **PENDING_PRINT or later** (`PRINTABLE_ORDER_STATUSES`), at a
partner **on the roster** — by the desk's `POST /orders/:id/print-job`, or by
the **award** of a quote request (`quotedCost` = the quote's amount,
`awardedQuoteId` set). A second open is refused 409 — except over a
CANCELLED job, which is reopened in place at the partner named now with the
clock restarted and the partner's earlier accept/decline/handover cleared.

The ladder, walked from the floor (Lot H) or the desk (Lot B):

```
REQUESTED ─accept─▶ ACCEPTED ─printing─▶ PRINTING ─ready─▶ READY ─handover / collect-prints─▶ COLLECTED
     └────────── decline { reason } ──────────▶ CANCELLED (the desk may cancel until the cost is approved)
```

- **Forward only.** The desk may skip a rung (it records what the shop
  reported); the floor walks one rung at a time. Never back.
- **Decline** is the partner's until printing starts (REQUESTED or
  ACCEPTED); after that it is a call to ops. A decline on an awarded job
  reopens the request (below).
- `readyAt` on READY, `collectedAt` on COLLECTED. **Handover**: the partner
  scans the agent's PICKUP code — the same `ORDER` QR with
  `purpose: PICKUP` the agent scans off the package — through
  `qr.confirmPickupHandover` (the scan is logged: action `PICKUP_HANDOVER`,
  role PARTNER) and the job goes COLLECTED with `handoverConfirmedAt` and
  `handoverQrId`. The agent's `POST /orders/:id/collect-prints` marks the
  same rung through the port; **whichever side records it first, the other
  is a no-op** — a COLLECTED job takes the handover scan and moves nothing.
  The **order** still moves on the agent's step (SLOT_CONFIRMED →
  IN_PROGRESS), as before; the partner's scan is the shop's record.
- `actualCost` may be recorded at any rung and **locks once approved**.

## Quote requests (Lot H)

The print charge is the partner's quote. `POST /orders/:id/print-quote-request`:

1. the order must be printable, with **no live job** and **no OPEN request**;
2. `invite: 'AUTO'` reaches the **active partners that accept requests in the
   order's city (Lot X-L: by the city key `Listing.city` resolves to, the
   spelling only for a partner keyed to nothing) or within 50 km of the
   site** (`AUTO_INVITE_RADIUS_KM`), **rate-card partners first** (the
   "asked first" of the owner's mechanics), and refuses 409
   `NO_PARTNERS_IN_REACH` when there is nobody; `invite: [ids]` takes the
   partners named (whatever their city or switch; 404 unknown, 409 off the
   roster);
3. the deadline defaults to **48 hours** (`DEFAULT_QUOTE_WINDOW_HOURS`), must
   be in the future;
4. every invited partner is told — `PRINT_QUOTE_REQUESTED`, in-app + push.

The invite list rides in `PrintQuoteRequest.specs` as an **envelope**
`{ specs, invitedPartnerIds, inviteMode, reinvitedAt }` (`envelopeOf` reads
it; `listQuoteRequestsForPartner` filters on `invitedPartnerIds` with a JSON
`array_contains`) until the schema carries a column — see *Schema needs*.

**Quoting** — one `PrintQuote` per partner per request (unique), SUBMITTED
until the deadline, re-submitted to edit (the clock the tie-break reads
restarts), WITHDRAWN by DELETE and re-submittable. Bids are **sealed**: a
partner sees only their own quote, and a request they were not invited to
reads as 404. A partner off the roster cannot quote.

**The award** — `rankQuotes`: the **lowest amount**; ties on the **shorter
turnaround**, then the **rate-card partner**, then who quoted first.
G13-B: "rate-card partner" is one rule, `hasRateCard` (a file or at least
one row), shared by the ranking, the AUTO reach's ordering and the wire's
`hasRateCard` flag — the quote's partner slice carries the two columns so
the ranking never reads a bare timestamp as a card. **The award runs under
a per-request lock** — a Redis `SET NX` on `print-partners:award:<requestId>`
(`awardLockKey`), 30 s TTL, released after the award — and re-reads the
request inside it, so two admins tapping Award together open one job: the
second answers 409 CONFLICT. Redis being down fails the award rather than
letting it run unguarded.
`POST …/award {}` takes `ranked[0]`; `{ quoteId }` for another needs a `note`
(400 `NOTE_REQUIRED`, naming the lowest). The award opens the job through
`openPrintJob` (the same gates), marks the winner ACCEPTED and every other
standing quote REJECTED, closes the request AWARDED with the note, and tells
the winner (`PRINT_JOB_ASSIGNED`) and the losers (`PRINT_QUOTE_REJECTED`).
A request past its deadline can still be awarded — the deadline closes
quoting, not deciding. 409 `NO_QUOTES` with nothing standing.

**A decline reopens the request** (`reopenRequestAfterDecline`): the
decliner's quote WITHDRAWN, the REJECTED quotes back to SUBMITTED, the
request OPEN with the deadline pushed out by 48 h when it has passed, the
others told `PRINT_QUOTE_REQUEST_REOPENED`. Ops award again.

**The nightly job** — `jobs/print-quote-expiry.job.ts` (hourly tick, once per
Indian day, heartbeat `print-quote-expiry`) → `expireQuoteRequests(now)`:
OPEN requests past their deadline with **no quote and never re-invited** are
re-invited once (deadline + 48 h, `reinvitedAt` stamped, partners told);
with no quote after that, **EXPIRED** and ops told; with quotes standing,
left OPEN for ops and ops reminded.

## The money (decision 122)

Unchanged from Lot B: `POST /orders/:id/print-job/approve-cost` posts one
`wallets.move` keyed `print-cost:<jobId>` — partner wallet +net
(`PRINT_COST`), `platform:cost-of-sales` −gross, `platform:tax-withheld` +tax
under 194C — idempotent, locked once approved. The wallet holds net-of-tax
money; the withdrawal deducts nothing.

## Settlement (decision 50, and Lot H)

The withdrawal ladder is `payouts`' own. Lot H lets the partner start it
themselves — `POST /print-partners/me/payout-methods` (verified by the desk
like everyone else's, `POST /finance/payout-methods/:id/verify`) and
`POST /print-partners/me/withdrawals` (`requestWithdrawal`'s rules exactly).
The desk's `POST /finance/withdrawals/on-behalf` still works for a partner who
never activates. Then approve, batch release or mark-paid with the UTR.
`payouts` still puts the partner on the **SMALL_AGENCY** cap rung and asks
the batch preflight for **no KYC** (ops vetted the GSTIN and PAN).

The month's invoice: the partner uploads a private file under
`PARTNER_INVOICE` and names it with the month; the latest sits on
`invoiceUploadFileId`, every one ever uploaded is listed on the console's
ledger page (`invoices`, from the files themselves), and the month rides on
the `PARTNER_INVOICE_UPLOADED` audit row.

## Notifications

All through `notify()` (`print-partners.notify.ts`, one function per event so
the events registry test can read every call): `PARTNER_ACTIVATED` (SMS,
kind INVITE), `PRINT_QUOTE_REQUESTED`, `PRINT_QUOTE_REQUEST_REOPENED`,
`PRINT_JOB_ASSIGNED`, `PRINT_QUOTE_REJECTED` (to partners: in-app + push),
`PRINT_JOB_READY` (to the agent who collects: in-app + push). Ops are told
in-app through `orders.notifyAdmins` (a decline with its reason, READY, the
handover, an expired request, quotes awaiting award). No SMS kind is
registered for print events — the owner's later round.

## Defaults taken (the owner's later round)

Each documented here and in `print-quotes.service.ts`; none is a decision:

- **Who is invited** — AUTO: active + accepting requests, in the order's
  city or within 50 km of the site, all at once, rate-card partners first.
- **Deadline** — 48 hours; ops may name another.
- **Auto vs ops award** — ops' tap, defaulting to the lowest; never automatic.
- **Rate-card format** — a private file (any accepted upload type) and/or
  structured rows `{ material, sizeClass?, unit, ratePerUnit, minQty?, notes? }`.
- **Partner KYC** — Lot N gives the partner a KYC record of their own (the
  section above); the batch preflight still asks for none, and activation
  is gated only when N-B1's `kyc.printPartnerActivationRequiresKyc` is on.
- **Payout rail** — `payouts`' own (manual NEFT until a vendor is configured).
- **Penalties** — none; a decline is recorded with its reason and reopens
  the request.
- **Sealed bids** — a partner never sees another's quote.
- **Decline window** — until printing starts.
- **Re-invite** — once, then EXPIRED; quoted requests wait for ops.
- **The order on handover** — the partner's scan moves the job, not the
  order; the agent's collect-prints still moves the order. G13-B: a job
  whose handover is already on record (`COLLECTED` with
  `handoverConfirmedAt`) is answered **before** the code is scanned again,
  so a second tap never logs a second PICKUP_HANDOVER scan.

## Dependencies

- `orders` — `getOrderSummary` gates a job and a request on the order's
  status; `notifyAdmins`, `shortId`. `orders` reads back through the
  `PrintJobPort` it declares (`printJobFor`, `pickupsFor`, `markCollected`).
- `qr` — `confirmPickupHandover` (Lot H).
- `wallets` — `ensureWallet`, `findWalletFor`, `move`, `snapshot`, `listEntries`.
- `payouts` — `withholdingFor('PARTNER')`, `listWithdrawals`,
  `withdrawalAllowance`, `requestWithdrawal`, `listMethods`, `addMethod`,
  `shapeMethod`, `shapeWithdrawal`, `addMethodSchema` (Lot H).
- `uploads` — `findUploadedFile` (the rate card, invoice and — Lot N — KYC
  files must be the partner's own, under the right purpose), `fileIdFromUrl`
  and `purgeStoredFile` (the KYC purge).
- `kyc` (Lot N) — the per-document decisions (`recordDocumentReview`,
  `flagDocuments`, …), the liveness gate, `kycCaseExtras` / `kycUserLabels`,
  `escalateKyc`, the purge rules and the desk bodies.
- `shared/integrations/digio-client` (Lot N) — the partner's Digio session.
- `app-config` (Lot N) — the review SLA on the partner queue.
- `notifications` — `notify`. `auth` — `normalizeMobile`, `revokeSessions`.
- `users` reads back through the `PartnerApplicationPort` it declares (PP-1:
  `chooseParty('PRINT_PARTNER')` → `applyAsPartner`), filled in
  `bootstrap/register-modules` — this module reaches `orders`, which notifies
  through `users`, so `users` may not import it.
- `identifiers` — the PRT series. `feature-flags` — `requireFeature`.
- The order read behind the partner's job page (`findOrdersForPrint`:
  listing, agent user, the approved creative) is a join in this module's
  Prisma repository — `orders` exports no read that wide.

## Invariants

- **A partner signs in only once ops activate the account**, and never once
  deactivated (sessions ended). PP-1's applicant is the one exception: the
  account is already signed in (it applied from the app) and sees only its
  application until the desk activates it.
- **A partner is never an existing account.** The mobile must be free — or,
  for an application, the signed-in account must hold no other side.
- **One job per order; the cost is paid once.** One quote per partner per
  request; one award per request.
- **The lowest quote wins unless ops say why.**
- **The ledger is append-only.**
- **Every write is audited by hand** — the desk's under the admin, the
  floor's under the partner — with `targetType` `PrintPartner`, `PrintJob`,
  `PrintQuoteRequest` or `PrintQuote`.

## Schema needs (not edited here)

- `PrintQuoteRequest.invitedPartnerIds String[]`, `inviteMode`, `reinvitedAt`
  — today in the `specs` envelope; G13-B adds `cancelReason`, `cancelledAt`
  to the same envelope.
- `PrintPartner.lastLoginAt` is not needed — it is `User.lastLoginAt`, read
  through `findLastLogins`.
- Lot N: `PrintPartnerKyc.requestNote` — the desk's note on a request rides
  the `KYC_REQUESTED` notice and the `PRINT_PARTNER_KYC_REQUESTED` audit row,
  not the record; `PrintPartnerKyc.userId` is not needed (`PrintPartner.userId`
  is the login the liveness gate and every notice use).
- A `PrintPartnerInvoice` table (month, fileId, amount, status) — today the
  latest file id on the row and the month on the audit row.
- Tax columns on `PrintJob` (`taxWithheld`, `taxRatePct`, `taxSection`,
  `netCost`) — the split is on the ledger legs and the audit row.

## Tests

```bash
npx vitest run src/modules/print-partners
```

`kyc/__tests__/print-partner-kyc.service.test.ts` (Lot N) — the three paths,
the resubmission rule, the file check, the desk end to end (record, request,
review with the liveness gate, the tiles, the re-upload ask, assignment,
escalation), the queue contract, the roster summary, the purge;
`print-partner-digio.test.ts` — initiate on both doors, the webhook landing
on the partner's row, the restart; `print-partner-kyc.repository.test.ts` —
the `kycStatus` mirror in one transaction and the queue's `requested`
facet; `print-partner-kyc.schema.test.ts` — the wire shapes.
`print-jobs.service.test.ts` — the gate, the ladder, the lock, the movement,
the awarded quote on a reopen. `print-partners.service.test.ts` — creation,
activation (idempotent, the SMS, 409 off the roster), deactivation ending
sessions, the partner's own profile, the rate card (own file, right purpose),
the withdrawal under payouts' rules, the invoice, the ledger view.
`print-quotes.service.test.ts` — reach, the 48-hour default, sealed bids, the
ranking, the award and the override note, the reopen after a decline, the
nightly re-invite and expiry. `print-floor.service.test.ts` — the ladder from
the floor, decline, READY telling the agent, the handover and its
idempotency with collect-prints. `print-quote-expiry.job.test.ts` — the tick.
`schema.test.ts` — the wire shapes. The handover scan is pinned in
`qr/__tests__/pickup-code.test.ts`; the port in
`orders/__tests__/print-job-port.test.ts`; the on-behalf withdrawal and the
preflight in `payouts/__tests__/print-partner-payee.test.ts`.
