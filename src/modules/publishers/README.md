# publishers

The people and organisations who own advertising inventory: their profile,
their KYC, and the agent-mediated onboarding flow.

```
publishers/
  publishers.*      profile CRUD, the agent-ownership policy
  kyc/              PublisherKyc + the Digio integration and its webhook
  onboarding/       self-registration, the onboarding QR, claim/cancel/complete
```

The inventory itself is `listings`.

## Why PublisherKyc is here and not in `kyc`

`PublisherKyc` is part of the publisher onboarding aggregate: its routes hang
off `/publishers/:publisherId/kyc`, its status is mirrored onto the publisher
row in the same transaction, and it is driven by the Digio integration. The
`kyc` module owns the two *standalone* record types, `AdvertiserKyc` and
`UserKyc`, which share a review workflow and nothing else with this one.

## Owned routes

Mounted at `/api/v1/publishers`, all `authenticate`d, plus one webhook.

| Method | Path | Guard |
| --- | --- | --- |
| POST | `/register` | PUBLISHER (**201** or 200) |
| GET | `/me` | PUBLISHER — QR-3 (17 Sep 2026): the row plus `readiness: { profile: { complete, missing[], percent }, kyc: { verified, status }, terms: { accepted }, percent, canList, canGoLive }` (`shared/kyc-state`'s `publisherReadiness` — basics name/email/address/dateOfBirth 70, identity check 30, terms 0 since QR-6 — the terms of use are consented to before any detail (`POST /users/me/consent`) and the commercial agreement is presented at submit (`listings`), so neither is a setup step; a name still equal to the mobile is no name; `canList` is the listing door's rule and, since QR-5, `canGoLive` is the same rule — the check ranks, it no longer gates) and `verified` (`kycStatus === 'VERIFIED'`, the tick beside the name; `/advertisers/me` and `/print-partners/me` carry the same). QR-5 (17 Sep 2026): also `dateOfBirth` (`YYYY-MM-DD \| null`) and `gender` (`MALE \| FEMALE \| OTHER \| PREFER_NOT_TO_SAY \| null`), read off the person's User row, and the publisher's `latitude` / `longitude` (the pin behind the address; null when it was typed). QR-7: `avatarUrl` (the person's profile picture, off the User row; set through `PATCH /users/me` after an `AVATAR` upload) |
| GET | `/me/listings` | PUBLISHER — DR 06: the publisher's own spots on the list contract, `?shelf=AVAILABLE\|OCCUPIED\|INACTIVE`, `?q=`, `?sort=`; every row carries `occupied` and, E11-1, `belowFloor` (rate-cards' `belowFloorFlags`, the same chip as ADMIN `GET /listings` — under the floor of the card in force, whatever case stands on it; false where no card reaches) |
| GET | `/me/qr` | PUBLISHER (**201** or 200) — `?latitude&longitude` is the phone's fix; a 90-second code, reissued once dead |
| GET | `/me/qr/status` | PUBLISHER — polled: is the code live, and who scanned it (name, id, photo, distance) |
| POST | `/me/qr/scans/:scanId/approve` | PUBLISHER — the owner's yes: burns the code, claims, opens the ONBOARDING grant |
| POST | `/me/qr/scans/:scanId/decline` | PUBLISHER — the owner's no: burns the code, logs USER_DECLINED |
| POST | `/me/cancel-onboarding` | PUBLISHER |
| PATCH | `/me` | PUBLISHER — DR 08 Steps 2–4. QR-5 (17 Sep 2026): also `dateOfBirth` (`YYYY-MM-DD`, 18–120 years ago) and `gender` (any casing), written to the person's User row (the same two columns `PATCH /users/me` takes), and `latitude` / `longitude` (both or neither — 400 `VALIDATION_ERROR` with one half — null clears), the pin the app sets when the address came off the map or a place search |
| GET | `/me/kyc` | PUBLISHER — null before the first submission |
| POST | `/me/kyc` | PUBLISHER (**201**) — Steps 6–11, self-service; Lot F: while NEEDS_INFO a **partial** body of the DR 08 columns — only the flagged tiles — the rest keep their files and decisions, the case returns to PENDING, the flags on the fields sent are cleared; `manifestVersion` in the body is pinned on the row at the first submission (`pinKycManifest`, never moved) |
| POST | `/me/complete-onboarding` | PUBLISHER — needs a submitted KYC; 409 while an agent is mid-way |
| GET | `/` | any authenticated — E10-1 (ADMIN): `?q=` (name / display id / city / mobile contains) beside `?category=`; with `?page=` the answer is the list contract `{ items, total, page, pageSize, counts }`, the chips by `kycStatus` counted with the KYC tab removed; without `page` the bare array stays one release — E12-B: on that bare path an empty `q=` / `category=` and a non-numeric `pageSize=` are ignored as the old handler ignored them (`publisherBareQuerySchema` drops them); the list-contract path keeps its validation. N2-B: every roster row — the bare array and the list contract's `items[]` — carries **`userId`** (the app login behind the publisher, null until they have one): the console opens the desk's KYC paths by it, since a request or a recording before any KYC row exists is keyed by the party's user |
| POST | `/` | AGENT_PUBLISHER, ADMIN (**201**) — Q29: an admin may open one from the desk; `attributeToAgentId` in the body is the only way an admin's publisher gets an agent. **QR-13 (17 Sep 2026): the desk onboards in full** — beside `name, mobile, email, type, city, state, address` the body takes the person (`firstName, lastName, dateOfBirth` (YYYY-MM-DD, 18+), `gender`), the pin (`latitude`+`longitude`, both or neither), `gstin` and the contact person. Once `firstName` is given the app's ladder rules apply (`deskOnboarding`): last name, email, address, city, state and date of birth required; a BUSINESS's GSTIN; a contact name and mobile for anyone but an INDIVIDUAL. The mobile is normalised to `+91…`, the **User is opened with the PUBLISHER role and an `ADX-…` id (or adopted when the number already has an account — fields filled where empty, role granted)** and linked as `userId`, and with the four readiness basics in the row opens `ONBOARDING_COMPLETE` with `activatedAt` — so the owner's first sign-in goes OTP → consent → home, with nothing left to ask. Without a first name the agent door's quick-add is unchanged |
| GET | `/:publisherId` | any authenticated — the onboarding agent or ADMIN; Lot F: `kyc.flagged[] { field, note }` and `kyc.documentReviews[] { field, decision, note }` from the desk's per-document decisions (the manifest's source), so the agent's capture screen lights the flagged tiles. P-B: `agent { id, displayId, name } \| null` — who brought them in, by name ("Onboarded by"), joined the way the KYC queue joins it; null when nobody did |
| GET | `/:publisherId/summary` | ADMIN — P-B: the detail card, the mirror of `GET /advertisers/:id/summary`: `{ publisher, metrics, listings, activity }`. See "The detail card" below |
| GET | `/:publisherId/activity` | the account's own agent or ADMIN — R-B: the action log on the list contract `{ items, total, page, pageSize, counts }`, newest first; `?status=` is the kind facet (`CHECK_IN \| FOLLOW_UP \| CALLED \| MESSAGED \| NOTE`, a comma list, the chips counted with it removed), `?q=` reaches the note; each row `{ id, kind, note, at, agentId }`. 403 another agent or no agent profile, 404 unknown |
| POST | `/:publisherId/activity` | the account's own agent or ADMIN (**201**) — R-B: `{ kind, note? }`, the mirror of `POST /advertisers/:id/activity` (decision 14): the same five kinds, the same READ-level act — the agent the account is attributed to logs without a live grant (a phone call is not a write to the account); ADMIN's row is recorded against the account's own agent (an admin who also carries an agent profile logs as themselves), 409 `CONFLICT` when the account has no agent. The row is what the summary feed reads back as `ACTIVITY` |
| PATCH | `/:publisherId` | AGENT_PUBLISHER. **QR-13:** ADMIN too — the desk's edit takes everything the create does (the person's fields are written to the linked account; a first name given to a publisher with no account opens one and links it), settles the onboarding when the basics land, and audits `PUBLISHER_UPDATED_BY_ADMIN` |
| POST | `/:publisherId/kyc` | AGENT_PUBLISHER — the same partial-body, `manifestVersion` and E9 `EMPTY_RESUBMISSION` rules as `/me/kyc` |
| POST | `/kyc-queue/:publisherId/escalate` | ADMIN — Lot G (Q127/142): `{ reason }`, the case handed to Compliance through `kyc.escalateKyc`; `KYC_ESCALATED`; 409 decided / already escalated |
| POST | `/kyc-queue/:publisherId/request` | ADMIN + **`kyc.edit`** (N3-B) — Lot N: `{ channel: DIGIO \| MANUAL = DIGIO, note? }`, the KYC asked for from the desk; DIGIO opens the session on the publisher's behalf; `KYC_REQUESTED` to the publisher (email + SMS + push deep-linking `adx://kyc`); `PUBLISHER_KYC_REQUESTED`; 409 `KYC_ALREADY_VERIFIED`. N3-B: the channel defaults to DIGIO (the console's one click sends no body) and the route is the catalogue's KYC edit tier — a role config granted `kyc.edit` may send it; the super admin and an admin with no role config pass under the launch rule |
| PUT | `/kyc-queue/:publisherId` | ADMIN — Lot N: the KYC recorded at the desk on the publisher's behalf — the same body as `POST /:publisherId/kyc`; `recordedVia` DESK, `method` MANUAL, PENDING with a fresh `submittedAt`; `PUBLISHER_KYC_RECORDED_AT_DESK`; 409 `KYC_ALREADY_VERIFIED`, 400 `EMPTY_RESUBMISSION` while NEEDS_INFO |
| POST | `/:publisherId/kyc/review` (and `/kyc-queue/:publisherId/*` decisions) | ADMIN — Lot F: the decision leaves by one `notify('KYC_DECISION', …, { inApp })`, and when `Publisher.agentId` is set the onboarding agent gets an in-app `KYC_DECISION_AGENT` notice (`relatedId` the publisher, `subtitle` its name, the status in the title) |
| POST | `/:publisherId/kyc/review` | ADMIN |
| POST | `/:publisherId/kyc/digio/initiate` | AGENT_PUBLISHER — N2 (the verifier): 409 `KYC_ALREADY_VERIFIED` over a verified record, before Digio is asked; the guard is in `initiateDigioKyc` itself, so the publisher's own initiate and the desk's DIGIO request share it |
| GET | `/:publisherId/kyc/digio/status` | any authenticated |
| GET | `/:publisherId/onboarding-status` | any authenticated |
| POST | `/:publisherId/cancel-onboarding` | AGENT_PUBLISHER \| ADMIN |
| POST | `/:publisherId/complete-onboarding` | AGENT_PUBLISHER \| ADMIN |
| GET | `/:publisherId/listings` | any authenticated — the onboarding agent or ADMIN; E11-1: every row carries `belowFloor`, stamped as `/me/listings` stamps it |
| POST | `/api/v1/webhooks/digio` | **none** |

The four `/me` and `/register` paths are registered **before** the
`/:publisherId` routes. Reordering would make `me` match as a publisher id.

### U7 / U9 — the publisher's own hands

- `POST /publishers/me/kyc/digio/initiate` and `GET /publishers/me/kyc/digio/status`:
  the same Digio request the agent path makes, keyed on the caller's own
  profile. The webhook marks the row as it does for the agent path;
  `complete-onboarding` closes on `submittedAt`, which the initiation stamps.
  409 `KYC_ALREADY_VERIFIED` over a verified record (N2 verifier).
- `GET /publishers/me/access-log`: who has had access — every scan of the
  publisher's codes (refusals included, with who and how far), every grant
  and how it ended, every write made under one. Composed by `access-grants`
  (`accessLogFor`).

### D7 — the ADMIN KYC queue

- `GET /publishers/kyc-queue?state=&status=&q=&unassigned=true&sort=` (ADMIN):
  **N3-B (the owner, 14 Sep 2026): every publisher, not every record.** "The
  moment a user creates an account or gets an account at ADX, their KYC
  automatically becomes pending hence they should be automatically appearing
  in the KYC queue." The queue is a query over the Publisher table — every
  publisher whose `kycStatus` is not VERIFIED plus every publisher with a
  record (so the VERIFIED chip still works) — each row the publisher with
  `kyc` (the record, or null), the agent who brought them (`agent: null` is
  a self-onboarded publisher nobody has met), and two derived facts:
  **`state`** — `AWAITING_DOCUMENTS` (no record, or a record with nothing
  submitted and no request), `REQUESTED` (the desk asked, nothing back),
  `PENDING` (submitted, under review), `NEEDS_INFO`, `REJECTED`, `VERIFIED`
  — and **`kycId`** (null with no record). The rule is one function,
  `shared/kyc-state.deriveKycState(record, mirror)`, shared by the five
  queues and the five party reads. `?state=` is the facet; **`?status=` stays
  as its alias** (each record status names the state of the same word);
  `?requested=true` is the REQUESTED state. `counts` carries the six states
  (`awaitingDocuments` camel-cased beside `AWAITING_DOCUMENTS`) beside
  `escalated` and `requested`, each counted with the state facet removed.
  `?q=` is the publisher's name, display id, mobile, email or contact mobile.
  Sorting: submitted rows as before (late first, oldest submission first;
  `newest` reversed); rows with nothing submitted follow, by the publisher's
  `createdAt`. The record-level facets — `assignedTo`, `method`,
  `digioStatus`, `escalated` — narrow to rows that have a record. The Lot G
  escalation job and the SLA breach counts consider submitted rows only, as
  before.

  **Lot A (Q31): the review SLA.** Every row carries `ageHours` and
  `slaBreached`, measured against `kyc.reviewSlaHours` from the platform
  settings row (48 hours by default, changed by ops without a deploy), and the
  response is `{ items, total, breached, slaHours }` rather than a bare array.
  With no `sort`, breaches come first and each half stays oldest-first — the
  queue is "what needs me now". `sort=oldest|newest` is the reviewer asking
  for the plain submission order instead. A row with no `submittedAt` has no
  age and never breaches: nothing was promised about a document nobody
  submitted. The ordering is done over the rows rather than in SQL because the
  SLA is a number ops change, not a column. E10-1: every row carries
  `assignedTo: { id, name } | null` beside `kyc.assignedToId`, one lookup for
  the queue through `kyc.kycUserLabels` (the label port bootstrap fills).
  G11-1: `escalatedTo` and `escalatedBy` (`{ id, name } | null`, beside
  `kyc.escalatedToUserId` / `kyc.escalatedById`) ride the same lookup on
  every row — null while the case is not escalated.
- `GET /publishers/:publisherId` — N3-B: `kyc` carries `state` and `kycId`
  beside the record's columns (and the desk's `flagged` / `documentReviews`),
  derived the same way, so the party page and the queue agree; a publisher
  with no record yet (none today — the row is made with the account) answers
  the six-column summary `{ state: AWAITING_DOCUMENTS, kycId: null, status:
  null, submittedAt, requestedAt, requestedChannel, method }` rather than
  `null`.
- `GET /publishers/kyc-queue/:publisherId` (ADMIN): one case for the workbench —
  the row, every per-document decision (`documentReviews`), the liveness video
  (`liveness`, with its file id), and (E7-3) `ageHours` / `slaBreached` /
  `slaHours` on the queue's own rule plus `reviewedBy`, `assignedTo` (and
  `recordedBy`, always null here) as `{ id, name } | null` beside the ids —
  `kyc.kycCaseExtras`, the names through the user-label port bootstrap fills.
  E10-1: each `documentReviews[]` row carries `reviewedBy { id, name }` beside
  `reviewedById` (`kyc.listDocumentReviewsWithReviewer`). G11-1: the same
  extras carry `escalatedTo` / `escalatedBy` as `{ id, name } | null`.
  The decision is the existing `POST /publishers/:publisherId/kyc/review`.

### Lot D (Q42/Q119/Q131) — the desk, per document

The body of the desk is `kyc/kyc-desk.service.ts`; the decisions on the tiles
live in `kyc`'s `KycDocumentReview` table (party type PUBLISHER), reached
through that module's index.

- `PATCH /publishers/kyc-queue/:publisherId/documents/:field { decision: APPROVED|FLAGGED, note }`
  (ADMIN): one tile; a flag must say why. Audited `PUBLISHER_KYC_DOCUMENT_REVIEWED`.
- `POST /publishers/kyc-queue/:publisherId/request-reupload { fields[], note }`
  (ADMIN): flags the fields, moves the KYC row **and** `Publisher.kycStatus` to
  **NEEDS_INFO** in one transaction, keeps every file, tells the publisher
  which to send again (type KYC, `suggestedAction` "Re-upload the flagged
  documents"), audited `PUBLISHER_KYC_REUPLOAD_REQUESTED` with the status diff.
  409 once verified.
- While NEEDS_INFO, `POST /publishers/me/kyc` and `POST /publishers/:publisherId/kyc`
  take a partial body — only the flagged tiles — clear the decisions on the
  fields sent, and return the row to PENDING with a fresh `submittedAt`. E9
  (the E7 verifier): a NEEDS_INFO body that names **no document field** is
  refused **400 `EMPTY_RESUBMISSION`** on both routes — nothing attached,
  nothing written, the flags stand (`assertResubmissionCarriesDocuments` in
  `kyc/kyc-desk.service`; the advertiser twin lives in `kyc`).
- `POST /publishers/:publisherId/kyc/review` now stamps `reviewedById` and
  `reviewNote`, tells the publisher either way, audits `PUBLISHER_KYC_REVIEWED`
  with a diff — and **refuses VERIFIED with 409 `LIVENESS_REQUIRED`** on a
  manual-path row whose owner has not recorded the liveness video (`kyc`'s
  `hasSubmittedLiveness`). The Digio path is exempt; a rejection needs no video;
  a publisher with no app account cannot have one and is refused with a
  message saying so.
- **Assignment is a filter, not ownership (decision 119).**
  `PATCH /publishers/kyc-queue/:publisherId/assign { adminUserId | 'me' | null }`,
  `POST /publishers/kyc-queue/assign { ids[], adminUserId }` (bulk), and
  `?assignedTo=me|none` on the queue. Any admin may still decide any case.
  Audited `PUBLISHER_KYC_ASSIGNED` / `PUBLISHER_KYC_ASSIGNED_BULK`.
- Queue facets (Lot D, Q129): `?status=` takes `NEEDS_INFO`; `?method=DIGIO&digioStatus=pending|stuck`
  — `stuck` is a Digio case initiated more than 24 hours ago with no webhook
  (`DIGIO_STUCK_AFTER_MS`).
- **Escalation (Lot G, Q127/142).** `POST /publishers/kyc-queue/:publisherId/escalate { reason }`
  (ADMIN) hands the case to Compliance — the body of it is `kyc.escalateKyc`
  (source REVIEWER): the five escalation columns stamped on the row, a member
  of the Compliance pool named on `escalatedToUserId` and told in-app,
  `KYC_ESCALATED` audited against the Publisher; 409 when the case is decided
  or already escalated; answers the case as the workbench draws it. The same
  columns are set by the nightly age sweep (`jobs/kyc-escalation.job.ts`,
  source AGE) and by a fraud case opened against the publisher or one of its
  listings (source FRAUD_LINK). The queue takes `?escalated=true|false` and
  answers `escalated` (and `counts.escalated`) across the queue whatever
  facet is applied; every row and the case carry the columns. **The decision
  clears it** — `reviewKyc` nulls all five, whoever it was handed to.
- The purge (Q127): `purgeVerifiedPublisherImages` — Digio-path rows only,
  thirty days after `digioVerifiedAt`; the URL columns nulled, the private files
  removed, the PAN masked to its last four, the payload trimmed, `imagesPurgedAt`
  stamped, `KYC_IMAGES_PURGED` against the Publisher. Run by `src/jobs/kyc-purge.job.ts`.
  Manual-path rows are never purged by the job.

### Lot N (the owner, 14 Sep 2026) — KYC from the desk

KYC can be done by the publisher or their agent (as before), **requested**
from the admin panel, or **recorded** at the desk by an admin. The body of
both is `kyc/kyc-desk.service.ts`.

- **Requested.** `POST /publishers/kyc-queue/:publisherId/request { channel:
  DIGIO | MANUAL, note? }` (ADMIN) stamps `requestedAt` / `requestedById` /
  `requestedChannel` on the KYC row (an upsert — the status is untouched:
  **REQUESTED is derived**, `requestedAt` set and `submittedAt` null, never a
  status of its own). DIGIO runs `initiateDigioKyc` on the publisher's behalf
  — the same session their phone asks for; the link reaches them as the
  integration sends it, and the initiation stamps `submittedAt` as it always
  has, so a Digio request sits in the queue as a pending Digio case rather
  than under the requested chip. MANUAL only tells them. Either way the
  publisher (when they have an app account) gets **`KYC_REQUESTED`** — one
  `notify()`, the seeded `kyc-requested` template on EMAIL + SMS + PUSH,
  transactional, variables `partyName`, `channel`, `note`, `deepLink`
  (`adx://kyc`, which the push's data carries so a tap opens their KYC
  screen), beside an in-app KYC row on the publisher — and
  `PUBLISHER_KYC_REQUESTED` is audited with the diff. A VERIFIED record is
  **409 `KYC_ALREADY_VERIFIED`**. Answers `{ kyc, digio: { kycId, validTill }
  | null, notified }`.
- **Recorded at the desk.** `PUT /publishers/kyc-queue/:publisherId` (ADMIN)
  takes exactly the body the agent's `POST /publishers/:publisherId/kyc`
  takes (documents by field, `panNumber`, `govIdType`, `addressProofType`,
  `manifestVersion` …). The files are uploaded by the admin through
  `POST /uploads` with purpose `KYC` and **`ownerUserId` = the publisher's
  user id** (Lot F already lets an ADMIN file a private document as
  somebody else; no new upload route). The write is the ordinary
  `submitKyc` — PENDING on the row and the mirror in one transaction, a
  fresh `submittedAt`, the manifest pinned, the tiles sent cleared, E9's
  empty-resubmission rule while NEEDS_INFO — stamped **`recordedById` the
  admin, `recordedVia` DESK, `method` MANUAL**. Audited
  `PUBLISHER_KYC_RECORDED_AT_DESK` with the diff. 409 `KYC_ALREADY_VERIFIED`.
  Verifying it afterwards still needs the liveness gate — which the desk
  can now satisfy by attesting presence (`POST /user-kyc/:userId/attest`,
  in `kyc`).
- **Who recorded what, always.** The other paths stamp their own hand in
  the same columns: the publisher's `POST /me/kyc` writes `recordedVia`
  SELF, the agent's `POST /:publisherId/kyc` AGENT (with `recordedById`),
  and Digio's completion (`applyWebhook`) DIGIO with no recorder — and,
  N2-B, a Digio **approval** also stamps `method` DIGIO, so a record whose
  documents were sent by hand while the session was open is Digio-verified
  once Digio says so (the liveness gate exempts it; the purge finds it); a
  rejection leaves the method alone.
- **The queue.** `GET /publishers/kyc-queue?requested=true` lists the
  desk's asks with nothing submitted yet — rows the submitted queue never
  showed — ordered by `requestedAt`; `requested=false` is the submitted
  queue as before. `counts.requested` (and `requested` beside `escalated`)
  is that number across the queue whatever facet is applied
  (`countKycQueue`). Every row carries `kyc.requestedAt` /
  `requestedChannel` / `recordedVia` and, by name, `requestedBy` and
  `recordedBy` as `{ id, name } | null` through the same label lookup as
  `assignedTo`; the case read (`kycCaseExtras`) answers `requestedBy` and
  `recordedBy` too.

### Lot D (Q43/Q86) — the legacy book, imported

`import/` — two steps on purpose, with a report between them.

- `POST /publishers/import` (ADMIN): a multipart CSV under `file` (through
  `uploads`' `csvUploadMiddleware`) or a JSON body `{ rows[], fileName?, note? }`
  — **201**, a VALIDATED import with a per-row plan. Columns: `name, mobile,
  email, type, gstin, address, city, state, contactName, contactMobile,
  contactEmail, panNumber`, and (QR-13) `firstName, lastName, dateOfBirth,
  gender, latitude, longitude` — a row naming a person opens (or adopts) the
  account with the publisher, and with the basics in it lands
  `ONBOARDING_COMPLETE`; a merge never touches an existing publisher's
  account or pin; mobile is required and normalised; PAN and GSTIN
  upper-cased; the city resolved through `pricing.resolveCity` and warned when
  unknown. Outcomes: a mobile match plans a **MERGED** fill of only the columns
  the publisher has empty (SKIPPED when there is nothing to fill); a PAN on
  another publisher is a **WARNING** and still creates; an unknown city warns
  and still creates; a duplicate mobile inside the batch is SKIPPED; a
  malformed value is INVALID and names the field. **Nothing refuses the batch.**
  Audited `PUBLISHER_IMPORT_VALIDATED`.
- `GET /publishers/imports`, `GET /publishers/imports/:id` (the rows),
  `GET /publishers/imports/:id/report.csv` (outcome and message first, then the
  columns).
- `POST /publishers/imports/:id/commit` (ADMIN): one transaction — creates
  PENDING_ONBOARDING publishers with an empty KYC row (PENDING, the PAN on it),
  **never sets `agentId` and never VERIFIED**, merges the blanks, stamps each
  row with its publisher; a number that joined the book between validation and
  commit is merged into rather than duplicated. 409 twice, 409 after a revoke.
  Audited `PUBLISHER_IMPORT_COMMITTED`.
- `POST /publishers/imports/:id/revoke` (ADMIN): only an uncommitted import.
  Audited `PUBLISHER_IMPORT_REVOKED`.

## The city key (Lot X-B)

`Publisher` carries `cityId` beside the free-text `city` — the `City` row the
string denotes, stamped by the service through `pricing.withCityKey` on
every write that sets the city — `createPublisher` (agent onboarding and the console), `updatePublisher`, `PATCH /publishers/me`, and the legacy-book importer's creates and city-filling merges (`CommitAction.cityId`); null for a typed town the catalogue lacks, and the string stays as typed
(the owner's rule). A caller never sends the key. The roster has no city facet; the section overview and `geo` count publishers by the key, the spelling only for rows whose key is null.

## Owned Prisma entities

`Publisher`, `PublisherKyc`, `PublisherImport`, `PublisherImportRow`.

## Public exports (`index.ts`)

- `publisherRouter`, `digioWebhookHandler`.
- `registerPublisherModule()` — supplies the QR module's port. See below.
- `findPublisherForUser(userId)`, `findPublisherBilling(publisherId)` (Lot B, Q13) — for `invoices`; `findPublisherContact(publisherId)` (Lot J-B2) — for `payments`: `{ id, userId, name, email, mobile }`, the customer a gateway order names and the login a payment notice goes to.
- `publisherKycReviewStateFor(userId)` (Lot D) — for `users`' manifest: the
  status, the method, the flagged tiles with the reviewer's note.
- `purgeVerifiedPublisherImages(cutoff, actorUserId)` (Lot D, Q127) — for the purge job.
- `registerPublisherSummaryPort(port)` (P-B) — the detail card's two reads from modules above this one: `runningSubscription(publisherId, at)` (`revenue`) and `visits(publisherId, limit)` (`visits`). Bootstrap fills it; unregistered, the card answers no subscription and no visits.

## The QR port

`publishers` imports `qr` to mint onboarding codes. `qr` needs `publishers` to
claim a publisher when one is scanned. Importing both ways would be a cycle, so
`qr` declares a `PublisherOnboardingPort` and this module implements it;
`bootstrap/register-modules` calls `registerPublisherModule()` before serving.

The port is two methods, not one, on purpose: `prepareClaim` validates and
writes nothing, `commitClaim` writes. QR then deactivates the code and commits
the claim together, so a rejected claim never burns a valid QR.

If bootstrap ever stops calling it, scanning a publisher QR throws a loud
"port not registered" error rather than silently logging a successful scan
that claimed nothing.

## Dependencies

- `qr` — mint, look up and expire onboarding codes.
- `agents` — `requireAgentProfile`, `findAgentProfile`.
- `payouts` (P-B) — `earningsSummary`, `listAccrualsForPeriod`, `paidWithdrawalTotal`, `listWithdrawals` for the detail card's money.
- `wallets` (P-B) — `findWalletFor`, `snapshot` for the card's balance and withdrawable.
- `listings` — `getListingsForPublisher`.
- `rate-cards` (E11-1) — `belowFloorFlags`, the chip on the listing rows.
- `notifications` — Digio KYC outcomes notify the claiming agent; the desk's
  decisions and re-upload asks notify the publisher.
- `kyc` (Lot D) — the per-document decisions, the liveness gate, the purge rules; Lot N — `kycRequestSchema`, the desk's request body.
- `uploads` (Lot D) — the CSV multer for the import; the purge of private files.
- `pricing` (Lot D) — `resolveCity` for the import.
- `auth` (Lot D) — `normalizeMobile` for the import.
- `identifiers` — every created publisher's `displayId`, the import's included.
- `shared/integrations` (Digio credentials), `shared/logging`, `shared/http`,
  `shared/auth`, `shared/errors`, `shared/validation`, `shared/database`
  (repositories only).

## The desk and the ladder are one onboarding (QR-13, 17 Sep 2026)

The owner's rule: a publisher onboarded at the desk signs in with the number
given there, agrees to the platform terms, adds a photo if they like, and
carries on exactly as a self-onboarded publisher would. So the desk collects
what the app's ladder collects (the person, the address and its pin, the
business and contact facts), opens the account up front, and — with the four
readiness basics in — marks the onboarding complete the day it is entered.
The same settle rule (`settleOnboardingIfReady`) runs off the app's own
`PATCH /publishers/me`, so the self-serve path completes itself too; the
explicit `POST /publishers/me/complete-onboarding` takes the basics, or the
documents already in. KYC ranks, it does not gate (QR-5).

## Who onboarded whom (QR-14, 17 Sep 2026)

Every publisher (and advertiser) carries the door it came through and who
opened it — `onboardedVia` (SELF, AGENT, QR, DESK, IMPORT), `onboardedById`
(null for a self-signup), `onboardedByRole` (the person's console role or
kind at the time — "Super admin", "Ops manager", "Agent" …, a snapshot from
`access-control`'s `actorLabelFor`, because roles move) and `onboardedAt`.
The stamp is written once, at the door: the desk (`POST /publishers` by an
ADMIN), the agent app (`POST /publishers` by an agent), a QR scan (`claim`,
only on a row nobody has stamped — a desk-opened publisher an agent then
walks through keeps the desk's), the import (the batch's uploader, per row)
and the app's own registration (SELF). The migration
`20260917070000_qr14_onboarding_provenance` backfilled every existing row
from the agent link, the audit trail and the import batches. The detail
read and the roster answer `onboarding { via, viaLabel, byId, byName,
byRole, at }`; the roster takes `onboardedVia` and `onboardedById` as
filters. The team board that counts on these is `reports`' `onboarding-
board` kind and `GET /reports/boards/onboarding` (vocabulary in
`shared/onboarding`).

## Invariants

- **Attribution is never implied (Q29).** On the agent path `Publisher.agentId`
  is the agent behind the session and a body field cannot move it. On the admin
  path it is null unless the admin names an agent in `attributeToAgentId`, and
  that agent has to exist — a book credited to an id nobody holds is worse than
  no attribution at all. The admin path leaves its own audit row,
  `PUBLISHER_CREATED_BY_ADMIN`, against the Publisher.
- **Suspension is not written here.** `Publisher.suspensionScopes` and its three
  companion columns belong to `modules/suspension`, which also cascades
  BLOCK_NEW and STOP_ACCRUAL onto this publisher's listings. This module reads
  them; the `/publishers/:id/suspend` route lives there.

- **A publisher lists their own spots through `/me/listings`, not
  `/:publisherId/listings`.** The second is the onboarding agent's read and its
  guard resolves the *caller's* agent profile, so the owner of the spots gets a
  403 from it and so does ADMIN. `/me/listings` resolves the publisher from the
  session and pages their inventory.
- **The list's chips are shelves, not statuses.** DR 06 draws Available /
  Occupied / Inactive; occupancy is a live order on the spot, judged by the same
  `OCCUPYING_ORDER_STATUSES` window the dashboard gauge uses, so the list and the
  gauge can never disagree about whether a spot is busy. Each chip is counted
  over the search but never over the chip in force.


- **404 vs 403 is deliberate and opposite to `banking`/`advertisements`**: an
  unknown publisher is 404, one owned by another agent — or a caller with no
  agent profile — is 403.
- KYC submission and review each write the `PublisherKyc` row and the mirrored
  `Publisher.kycStatus` in **one transaction**; they must never disagree.
- A rejection requires a `rejectionReason`; the schema enforces it rather than
  leaving it to the caller.
- Every publisher is created with an empty KYC row, so there is always something
  to submit into.
- Self-registration is idempotent: a second `POST /register` returns the
  existing profile with **200**, not a conflict. It also writes the supplied
  name and email onto the `User`.
- `GET /me/qr` reuses the live code if one exists (**200**) and only mints a new
  one when there is none (**201**). Regenerating would invalidate a code the
  publisher may already have on screen. It is refused with **409** once
  onboarding is in progress or complete.
- Cancelling expires the QR codes **first**, then clears the claim. The reverse
  order would briefly leave a scannable code pointing at a claimable publisher.
- Only the claiming agent or an ADMIN may complete an onboarding, and only from
  `IN_ONBOARDING`.
- `category=KYC` on the publisher listing is the UI's tab name, not a column —
  it filters to `kycStatus: VERIFIED`.
- The Digio webhook **always answers 200**, even for a payload that fails
  validation: an error would make Digio retry the same bad body indefinitely.
- Digio degrades gracefully when unconfigured, returning a mock pending KYC so
  the flow is testable without credentials — disabled by real credentials, not
  by `NODE_ENV`.

## The publisher's home (DR 01)

`GET /publishers/me/dashboard` (PUBLISHER) is the frame's gauge and map,
computed for now rather than stored: `occupancy.rate` is the share of the
publisher's ACTIVE listings that an accepted booking's flight covers today
(`OCCUPYING_ORDER_STATUSES` — past the publisher's acceptance and not
stopped), null while nothing is live; `awaiting` counts bookings still
PENDING_PUBLISHER; `listings` carries every spot with its pin and whether it
is occupied, for the map. The greeting follows the Indian clock.

E11-1: `GET /publishers/me/listings` and the agent's `GET
/publishers/:publisherId/listings` stamp `belowFloor` on every row through
`rate-cards`' `belowFloorFlags` (`stampBelowFloor` in `my-listings.service.ts`),
so the phone's chip and the admin table's chip read the same card. The gate
route explains the number; the row only says which side of the floor it is on.

## Tests

```bash
npx vitest run src/modules/publishers
```

## Suggested ownership

Supply-side team, alongside `listings`. The Digio integration is the riskiest
part; changes there need real-credential testing.

## The Digio case, operated from the desk

`POST /publishers/kyc-queue/:publisherId/digio/restart` (ADMIN) asks Digio for a
fresh session on the publisher's own row — the same request their phone makes —
logs `PUBLISHER_KYC_DIGIO_RESTARTED` against the admin, and tells the publisher
to open the app and finish it. A verified publisher is 409: nothing to restart.
The manual decision (`POST /:publisherId/kyc/review`) remains the override.
- **The agent's publisher book is `GET /publishers/book`** (DR 06), on the list
  contract, and `GET /publishers` is untouched — the console's roster and the
  older agent read both still get their arrays. Each row carries the listing
  count, the categories of those listings (a publisher has no category of its
  own, so the frame's "PRINT VENDOR" chip has no source and is not invented),
  and **revenue to date as the sum of net accruals — suppressed (null, never
  zero) while KYC is pending**, because a figure on an account that cannot be
  paid is a promise.

## E6

`GET /publishers/:id` carries `user: { closedAt, closeReason } | null` (null
while no account backs the profile) and `openOrders` — the non-terminal
orders across the publisher's listings, counted through the listings include
(`_count.orders`, status not COMPLETED / CANCELLED) — so the suspend dialog
can say what STOP_OPEN_WORK would cancel. The legacy-book import keeps
`PublisherImport.warningCount` (Lot E column): the rows that will create with
a warning, counted on their own beside `createdCount`, which still counts
every creating row.

## P-B: the detail card and the agent on the row

**`GET /publishers/:id/summary`** (ADMIN) is the detail card, the mirror of
`GET /advertisers/:id/summary`: the row as `GET /publishers/:id` answers it
(`kyc` with its state, `agent { id, displayId, name } | null`, `user`,
`openOrders`), the metrics, the spots and an activity feed. Every money
figure is a decimal string, and every figure is read from where it is owned
rather than from its table:

- **`metrics`** — `earningsThisMonth` (the net of the `EarningAccrual` rows
  dated in the Indian calendar month `now` falls in, through `payouts`'
  `listAccrualsForPeriod` on `[1st 00:00Z, next 1st 00:00Z)`, the way
  `invoices` dates a payment advice, since `forDate` is a UTC-midnight date
  column) and `earningsLifetime` (`earningsSummary.netEarned`);
  `payoutsReleased { lifetime, thisMonth }` (the `netAmount` of PAID
  withdrawals through `payouts.paidWithdrawalTotal`, the month on `paidAt`
  by the IST instant window); `walletBalance` and `withdrawable` (the
  publisher-owned wallet through `wallets.findWalletFor` + `snapshot` —
  `"0.00"` for a publisher who has never earned and so has no wallet yet,
  never a 404); `listingsTotal` / `listingsLive` (ACTIVE); `bookingsThisMonth`
  / `bookingsLifetime` (orders on the publisher's spots that were not
  abandoned as drafts, the book's rule, the month on `createdAt`);
  `ratingAvg` — `reviews` exports no publisher rating, so it is the average
  of the spots' `ratingAvg` snapshots weighted by their `reviewCount`, null
  while nobody has reviewed anything of theirs; `subscription { tier, endsAt }
  | null` through `revenue.runningSubscriptionForPublisher`.
- **`listings`** — every spot with `status`, `live` (ACTIVE), `occupied` (a
  live order on it, the dashboard gauge's rule), `publishedAt`, `ratePerDay`,
  `ratingAvg`, `reviewCount`.
- **`activity`** — one feed merged newest first and capped at 30, like the
  advertiser's: the action log on the publisher (`ACTIVITY` — the rows
  `POST /:publisherId/activity` writes, R-B; the kind as the title, the note
  as `detail`), field visits
  through `visits.visitsForPublisher` (`FIELD_VISIT`, scheduled / in progress
  / completed), spots that went live (`LISTING_LIVE`, on `publishedAt`),
  bookings the publisher authorised (`BOOKING_AUTHORISED`, on
  `publisherAcceptedAt`, or `autoAcceptedAt` for an instant booking) and
  payouts released (`PAYOUT_RELEASED`, PAID withdrawals on `paidAt`, the net
  in the title and the reference in `detail`).

`revenue` imports this module (`findPublisherForUser`, for the plan orders)
and `visits` reaches it through `orders` → `users`, so the subscription and
the visits come through `registerPublisherSummaryPort`, which bootstrap fills
from those two modules' exports; `payouts` and `wallets` sit underneath and
are imported directly. The module's own `book/prisma-publisher-summary.repository.ts`
reads only what this module can vouch for: the spots, the bookings on them,
the action log.

**The agent on the row.** `detailInclude` now joins
`agent { id, displayId, user { name } }` the way the KYC queue include does,
mapped to `agent { id, displayId, name } | null` on every detail read
(`GET /publishers/:id`, the roster, the agent's list) — the party page's
"Onboarded by", by name; a publisher nobody brought in answers `null`.
Pinned by `p-b-publisher-summary.test.ts`.
