# kyc

Identity verification records that stand on their own, and the admin review
workflow they share.

```
kyc/
  kyc.schema.ts     review decision + pagination shared by the subfeatures
  advertiser/       AdvertiserKyc — documents, by entity type; N3-B: keyed by the Advertiser PROFILE
  user/             UserKyc — a single self-recorded video
  agent/            AgentKyc — recorded at ADX's desk on the agent's behalf (D4)
  employee/         EmployeeKyc — the agent record's twin for staff (Lot D, Q131)
  document-review/  KycDocumentReview — one decision per tile, both party types (Lot D, Q42)
  purge.rules.ts    what a purge keeps: the PAN's last four, a trimmed Digio payload (Lot D, Q127)
```

## N3-B (the owner, 14 Sep 2026): everyone in the queue, the record by the profile, one click on every party

> "the moment a user (advertiser, publisher or partner or agent or employee)
> creates an account or gets an account at ADX, their KYC automatically
> becomes pending hence they should be automatically appearing in the KYC
> Queue in their respective section. ADX Admin/Super Admin and other people
> who'll be granted authority should be able to send a Digio KYC request to
> the user with click of a button."

The fact from Neon that opened this (14 Sep 22:00): two advertisers with
`kycStatus` PENDING — 'Swiggy', created on the console with no user, and a
probe row — and **zero** `AdvertiserKyc` rows; the owner opened the queue
and saw nobody, because every queue listed RECORDS (`submittedAt` not
null), never parties.

**The five queues list parties.** `GET /publishers/kyc-queue`,
`GET /advertiser-kyc`, `GET /print-partner-kyc`, `GET /agent-kyc` and
`GET /employee-kyc` are queries over the party table, left-joined to the
record: every Publisher / Advertiser / PrintPartner whose `kycStatus`
mirror is not VERIFIED plus every one with a record (so the VERIFIED chip
still lists the verified); every AgentProfile and every Employee (no mirror
column — everyone). Each row carries **`state`**, derived server-side by
one function, `shared/kyc-state.deriveKycState(record, mirror)`:

| state | meaning |
| --- | --- |
| `AWAITING_DOCUMENTS` | no record, or a record with nothing submitted and no request — the party just arrived |
| `REQUESTED` | the desk asked (`requestedAt` set) and nothing is in |
| `PENDING` | submitted, under review |
| `NEEDS_INFO` | the desk asked for some tiles again |
| `REJECTED` | decided against |
| `VERIFIED` | decided for (a party whose mirror says VERIFIED with no record — a legacy row — reads VERIFIED too) |

plus the party's slice (name / displayId / city / contact / userId /
createdAt) and the record's columns when there is one — **every record
column null and `kycId` null otherwise**; the row's `id` is the record's id
when there is one, else the party's (either is accepted as `:id` on every
desk route). `?state=` replaces the old status facet; **`?status=` stays as
its alias** (each record status names the state of the same word);
`?requested=true` is the REQUESTED state. `counts` carries the six states,
`awaitingDocuments` camel-cased beside `AWAITING_DOCUMENTS`, beside
`escalated` and `requested` — each counted with the state facet removed.
Sorting: submitted rows as before (late first, oldest submission first);
rows with nothing submitted follow, by the party's `createdAt`; `newest` is
the party's arrival order. `?q=` searches the party's name / displayId /
contact. The record-level facets (assignment, escalation, method) narrow to
rows that have a record. The Lot G escalation job and the SLA breach counts
consider submitted rows only (unchanged). The list contracts stay: the
advertiser and print partner queues answer `{ items, total, page, pageSize,
counts, breached, escalated, requested, slaHours }`, the publisher queue its
`{ items, total, breached, escalated, requested, counts, slaHours }`, the
agent and employee queues `data: items[]` with `meta { page, pageSize,
total, totalPages, counts }`.

**The stamp is the schema's** — `kycStatus KycStatus @default(PENDING)` on
Publisher, Advertiser and PrintPartner — and no creation path writes over it
(publisher self sign-up, agent-assisted onboarding, the console Create; the
advertiser's three doors; the print partner's creation; the publisher import
writes PENDING by name); agents and employees keep no mirror and are
AWAITING_DOCUMENTS by the queue's rule from the moment the row exists.
Pinned by `__tests__/n3b-pending-on-creation.test.ts`.

**The party reads agree with the queues.** `GET /publishers/:id`,
`GET /advertisers/:id`, `GET /print-partners/:id`, `GET /agents/:id` and
`GET /employees/:userId` carry `kyc: { state, kycId, submittedAt,
requestedAt, requestedChannel, method }` derived the same way
(`kycSummaryOf`); the publisher's and the print partner's `kyc` keep their
existing columns beside the two new ones and are no longer null before a
record. `shared/kyc-state` lives in `shared` because the party modules
(`advertisers`, `agents`, `employees`) sit below this one and cannot import
it back; the index re-exports it.

**The advertiser record belongs to the profile.** `AdvertiserKyc.advertiserId`
(the USER id, the legacy key) is nullable; `advertiserProfileId` (the
Advertiser profile, relation `Advertiser.kyc`, backfilled for every row that
had a user) is the key every read and write resolves first. `:id` on
`POST /advertiser-kyc/:id/request`, `PUT /:id` and `GET /:id` — and
`?advertiserId=` on the queue — is the **KYC row id, then the Advertiser
profile id, then the user id** (`resolveAdvertiserCase`); the self paths
(`/me`, `/me/digio/*`, the manifest's `advertiserKycReviewStateFor`) resolve
through the caller's profile, a user with no profile (an account predating
the model) keeping the legacy user key. A record the desk creates for an
advertiser with no user carries `advertiserProfileId` only (`advertiserId`
null) and is linked to the user later by the profile's claim path
(`advertisers.attachUser`, in the same transaction as `Advertiser.userId`).
The Digio session for an advertiser without a user uses the profile's
contact — its name (company name first), email and mobile — as the customer
Digio reaches; the reference is `adx-adv-<profileId>-<ts>`. The
`KYC_REQUESTED` / `KYC_DECISION` notices (and the re-upload and restart
notices) are skipped with a logged reason when the record has no user, and
the desk answer says `notified: false`. A manual-path VERIFIED still needs
the liveness proof, which is the user's: 409 `LIVENESS_REQUIRED` says so
until the owner signs in (or the desk attests presence on their account).
`Advertiser.kycStatus` is **mirrored from the record on every status
write** — the self submissions (PENDING), the desk's first recording
(PENDING), the re-upload ask (NEEDS_INFO), the decision and Digio's answer
— by the profile the record names, else by its user (`applyKycDecision` /
`applyKycDecisionByUserId`, which now take every `KycStatus`). Where a user
id is genuinely required — a fraud signal over sign-in IPs (`fraud` reads
`subject.userId` off the profile), a report row keyed by the party
(`reports.kycAgeing` keys by the profile, else the user) — records with
neither a profile nor a user are skipped. The escalation repository joins
`profile` and `advertiser`; `partyId` is the profile's id (a legacy row's
user id), `userId` the record's user else the profile's.

**One click on every party.** `POST /agent-kyc/:agentId/request` and
`POST /employee-kyc/:employeeId/request` `{ channel: DIGIO | MANUAL = DIGIO,
note? }` sit beside the three that exist. Agents and employees are
individuals with a user, so the Digio initiate is on the person's behalf
through the same client (`agent/agent-digio.service.ts`,
`employee/employee-digio.service.ts`; references `adx-agt-<agentId>-<ts>` /
`adx-emp-<employeeId>-<ts>`; `submittedAt` left for the webhook, so the
queue reads REQUESTED until Digio answers), the webhook routed by Digio's
request id onto the agent's / employee's record (`handleAgentDigioWebhook`,
`handleEmployeeDigioWebhook`, registered at boot after the print partner's),
`applyDigioWebhook` stamping `recordedVia` DIGIO, `method` DIGIO on an
approval, VERIFIED / REJECTED and a `submittedAt`, and the person told by
`KYC_DECISION`. The request stamps `requestedAt` / `requestedById` /
`requestedChannel` (the row made if there is none; the status untouched),
sends `KYC_REQUESTED` (deep links `adx://agent/kyc` and `adx://employee/kyc`
— to be confirmed against the apps), and audits `AGENT_KYC_REQUESTED` /
`EMPLOYEE_KYC_REQUESTED`; 404 for no such party, 409 `KYC_ALREADY_VERIFIED`
once verified. The desk's recording (`PUT /agent-kyc/:agentId`,
`PUT /employee-kyc/:employeeId`) now stamps `recordedVia` DESK and `method`
MANUAL like the three parties' desk PUTs. **The channel defaults to DIGIO on
all five request routes**, so the console's one click needs no body.

**Authority.** Every request route is guarded by
`requirePermission('kyc.edit')` beside `requireRole('ADMIN')` — the
catalogue's **KYC edit tier**: a role config granted `kyc.edit` may send
requests; the super admin and an admin with no role config pass under the
launch rule (`hasPermission`: a token with no `perms` and the ADMIN role
holds everything). Pinned by `tests/contract/kyc-one-click-authority.test.ts`;
`tests/contract/permission-catalogue.test.ts` stays green (`kyc.edit` is a
catalogue id).

## The desk, per document (Lot D, Q42/Q119)

A review used to be one verdict over the whole record. The workbench now
decides each tile — `PATCH /advertiser-kyc/:id/documents/:field { decision:
APPROVED|FLAGGED, note }` (a flag must say why) — and asks for exactly the
flagged ones again: `POST /advertiser-kyc/:id/request-reupload { fields[], note }`
moves the record to **NEEDS_INFO**, keeps every file, records the flags, and
tells the advertiser which to send (type KYC, `suggestedAction` "Re-upload the
flagged documents"). While NEEDS_INFO, `PUT /advertiser-kyc/me` takes a
partial body — only the flagged tiles — clears the decisions on the fields
sent, and returns the record to PENDING with a fresh `submittedAt`. E9 (the
E7 verifier): a NEEDS_INFO body that names **no document field** (a type
change, a bare `manifestVersion`, nothing) is refused **400
`EMPTY_RESUBMISSION`** — nothing attached, nothing bounced back to PENDING,
the flags stand; `assertResubmissionCarriesDocuments` is the rule, the
publisher twin applies it to its own columns. The
`GET /:id` read carries `documentReviews` and `liveness`. The publisher twin
lives in `publishers` and reaches the same table through this module's
exports.

**Assignment is a filter, not ownership (decision 119).** `PATCH
/advertiser-kyc/:id/assign { adminUserId | 'me' | null }` and `?assignedTo=me|none`
on the queue say who is working what; any admin may still decide any case.
Every decision stamps `reviewedById` and `reviewNote`, tells the advertiser
either way, and is audited (`ADVERTISER_KYC_REVIEWED` with a diff over
status, reason and note; `ADVERTISER_KYC_DOCUMENT_REVIEWED`;
`ADVERTISER_KYC_REUPLOAD_REQUESTED`; `ADVERTISER_KYC_ASSIGNED`).

## Liveness (Lot D, Q131)

The manual path needs proof the person behind the documents is present.
`POST /user-kyc/me { fileId }` records the short video the phone uploaded as a
private `USER_KYC` file onto the caller's `UserKyc` row (`purpose: LIVENESS`,
`recordedById` the caller; back to PENDING every time); the file has to be the
caller's own. `hasSubmittedLiveness(userId)` is the gate: a manual-path review
of a publisher or an advertiser **refuses VERIFIED with 409 `LIVENESS_REQUIRED`**
until a liveness row is in and not rejected. The Digio path is exempt — Digio
performed its own — and a rejection needs no video. The manifest
(`users`) draws the step as "Record a short video" on the manual branch.
Which path a row is on is its `method`: a Digio initiate (the party's own, or
the desk's request on their behalf) sets `DIGIO`; **every hand-submitted set of
documents — self, agent or desk, for all three parties — stamps `MANUAL`**, so
documents uploaded after a Digio request that never finished are reviewed as
the manual path and the gate applies (Lot N verifier).

## Employee KYC (Lot D)

`kyc/employee` mirrors `kyc/agent` for the `Employee` row: `GET /employee-kyc/me`
(the employee's own, by their User), and for ADMIN `GET /employee-kyc?status=`,
`GET /employee-kyc/:employeeId`, `PUT /employee-kyc/:employeeId` (an upsert on
the employee's behalf → PENDING, `recordedById` the admin, audited
`EMPLOYEE_KYC_RECORDED`) and `PATCH /employee-kyc/:employeeId/review` (audited
`EMPLOYEE_KYC_REVIEWED` with a diff; a rejection must say why). Documents are
uploaded with purpose `EMPLOYEE_KYC`, which is private.

## The purge (Lot D, Q127)

`src/jobs/kyc-purge.job.ts`, daily, Redis-locked: thirty days after
`digioVerifiedAt`, a **Digio-path** advertiser's images are removed (the
private files and the URL columns), the PAN is masked to its last four, the
Digio payload trimmed to the decision, `imagesPurgedAt` stamped and
`KYC_IMAGES_PURGED` written against the record; `digioRequestId`,
`digioReferenceId`, `digioStatus` and `digioVerifiedAt` stay — that is the
proof. **Manual-path records are never touched by the job**: those images
stay in private storage until the account closes and its retention runs.
Liveness videos go thirty days after their own VERIFIED, keeping when they
were recorded, by whom, and the reviewer's note. Attributed to the first admin
(`ActivityLog.userId` is a foreign key and there is no system account).

## Agent KYC (D4)

Agents never self-serve — they are onboarded in person and only ever sign in —
so their documents are recorded ON THEIR BEHALF by the admin who met them,
and the row remembers who (`recordedById`; N3-B: `recordedVia` DESK, `method`
MANUAL). `PUT /agent-kyc/:agentId` (ADMIN) is
an upsert: ops record what they have and come back for the rest; a fresh
recording after a rejection returns the row to PENDING with the reason
cleared. `PATCH /agent-kyc/:agentId/review` (ADMIN) is the decision, and a
rejection must say why. `GET /agent-kyc/me` lets the agent read their own
status; `GET /agent-kyc?state=&status=&q=` is the queue — N3-B: **every
agent**, oldest submission first then the rest by when the agent was
onboarded, each row with `state`, `kycId`, `agentId` and the `agent` slice
(id, userId, displayId, city, createdAt, user { name, mobile, email }),
`meta.counts` per state. `POST /agent-kyc/:agentId/request` (ADMIN +
`kyc.edit`) is the one click — see the N3-B section at the top; `GET
/agent-kyc/:agentId` is still 404 before any record (the queue row already
carries the party). Documents are uploaded with purpose `AGENT_KYC`.

## The print partner — the third party (Lot N)

`PrintPartnerKyc` (owner, 14 Sep 2026) lives in `print-partners/kyc`, the
way the publisher's row lives in `publishers`, and reaches this module's
desk through the same exports: `KycDocumentReview` with party type
**PRINT_PARTNER** (`recordDocumentReview`, `flagDocuments`,
`listDocumentReviewsWithReviewer`, `clearDocumentReviews`), the liveness gate
on the partner's user (`hasSubmittedLiveness(PrintPartner.userId)` —
`LIVENESS_REQUIRED` on a manual-path VERIFIED, the Digio path exempt),
`kycCaseExtras` / `kycUserLabels` for the case and the queue, the purge
rules, and the desk bodies. Escalation covers it: `KycEscalationParty`
gained `PRINT_PARTNER`, `escalateKyc({ party: 'PRINT_PARTNER', kycId })` is
the reviewer's door (`POST /print-partner-kyc/:id/escalate`),
`prisma-kyc-escalation.repository` reads and writes the five columns on the
third table (target `PrintPartnerKyc` / id in the `KYC_ESCALATED` row, no
`relatedType` on the notice — the apps open no partner screen), and
`escalateAgedKycCases` walks the partner queue with the other two and
reports `printPartners`. The fraud link has no partner subject. Documents
are uploaded under `PRINT_PARTNER_KYC`, which is private. The record and
its three paths — the partner's own, the desk recording it, the desk
requesting it — are documented in `print-partners/README.md`.

## Why these two are together

Both are a submitted record plus an admin PENDING/VERIFIED/REJECTED decision
with an optional rejection reason, and the review endpoint is identical. One
owner for both review flows is the point of the module.

## What is deliberately NOT here

**Publisher KYC.** `PublisherKyc` is part of the publisher onboarding aggregate,
its routes hang off `/publishers/:publisherId/kyc`, and it is driven by the
Digio integration. It belongs to the `publishers` module.

## Owned routes

### Lot A (Q31): the review SLA on the advertiser queue

`GET /advertiser-kyc` rows carry `ageHours` and `slaBreached` against
`kyc.reviewSlaHours` from the platform settings row. E7-3: `data` is the
publisher queue's shape — `{ items, total, page, pageSize, counts, breached,
slaHours }`, `counts` by status over the filter with the status facet removed,
`breached` across the whole queue, not the page — and the old `meta` sibling
(`{ page, pageSize, total, totalPages, breached, slaHours }`) stays one
release. With no
`?sort`, the page is ordered oldest submission first — which is precisely
breaches first — so a late record cannot hide on page four; `?sort=newest` is
the old arrival order. A decided record has no age: the clock stops when a
reviewer answers.

`/api/v1/advertiser-kyc`, all `authenticate`d:

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/` | any | **201** |
| GET | `/me` | any | 200 |
| PUT | `/me` | any | 200 — Lot F: an **upsert** (the phone's ladder PUTs the first submission too); while NEEDS_INFO a **partial** body of the DR 08 columns (`govIdFrontUrl`, `govIdBackUrl`, `panCardUrl`, `panSignatureUrl`, `addressProofUrl`, `selfieUrl`, `govIdType`, `addressProofType`, `panNumber`) — only the flagged tiles need be sent, the rest keep their files and decisions; the case returns to PENDING and the flags on the fields sent are cleared. `manifestVersion` in the body is pinned on the row at the first submission (never moved). N2-B: **409 `KYC_ALREADY_VERIFIED`** over a VERIFIED record — nothing written or pinned — until the desk moves it to NEEDS_INFO (or a decision rejects it) |
| GET | `/` | ADMIN | 200 — E7-3: `data` is `{ items, total, page, pageSize, counts, breached, slaHours }`; `meta` kept one release; E10-1: every row carries `assignedTo: { id, name } \| null` beside `assignedToId`; N2-B: `?advertiserId=` narrows the queue to **one row or none** — blank is ignored like the other facets. **N3-B: every Advertiser, in one of six `state`s** (see the top); `?state=` the facet, `?status=` its alias, `?q=` the party's name / company / display id / email / mobile, `?advertiserId=` the **profile id or the user id**; every row carries `state`, `kycId`, `party` (the profile slice: id, displayId, name, companyName, email, mobile, city, userId, kycStatus, type, createdAt) and `advertiser` (the same object under the queue's old name — no longer the User slice); `counts` per state + `awaitingDocuments` + `escalated` + `requested`; `requested` beside `escalated` at the top level |
| GET | `/:id` | ADMIN | 200 — E7-3: + `ageHours`, `slaBreached`, `slaHours`, `reviewedBy` / `assignedTo` / `recordedBy` as `{ id, name } \| null`; E10-1: each `documentReviews[]` row carries `reviewedBy { id, name }` beside `reviewedById`; N2-B / N3-B: `:id` is the KYC row id, **then the Advertiser profile id, then** the advertiser's user id (the way `POST /:id/request` resolves it); 404 when none names a row; `liveness` null for a record with no user |
| PUT | `/:id` | ADMIN | 200 — Lot N: the KYC **recorded at the desk** on the advertiser's behalf; stamps `recordedById` the admin, `recordedVia` DESK, `method` MANUAL, `submittedAt` on a first recording; the status is still not touched; audited `ADVERTISER_KYC_RECORDED_AT_DESK` with the diff. N2-B / N3-B: `:id` is the row id, the profile id **or** the advertiser's user id (row first); over a profile with **no row** the desk **creates** it — keyed by the profile (`advertiserId` null when the profile has no user), `kycType` from the body or the advertiser's entity type, `recordedVia` DESK, PENDING, `submittedAt` now, the mirror PENDING — so the console can record before any request (the audit's `metadata.created` says so, `metadata.advertiserProfileId` beside `advertiserId`; 404 when no advertiser is behind the id); **409 `KYC_ALREADY_VERIFIED`** over a VERIFIED record, by any id, before anything is written |
| POST | `/:id/request` | ADMIN + **`kyc.edit`** | 200 — Lot N: `{ channel: DIGIO \| MANUAL = DIGIO, note? }`, the KYC asked for from the desk; `:id` is the KYC row id, **the profile id or** the advertiser's user id (row, then profile, then user — a request may precede any row); DIGIO opens the session on their behalf with the profile's contact; `KYC_REQUESTED` (email + SMS + push deep-linking `adx://kyc`) when the profile has a user — skipped with a logged reason otherwise; `ADVERTISER_KYC_REQUESTED`; 409 `KYC_ALREADY_VERIFIED`; answers `{ kyc, digio \| null, notified }` — `notified: false` for an advertiser with no app account. N3-B: the channel defaults to DIGIO; the route is the catalogue's KYC edit tier |
| PATCH | `/:id/review` | ADMIN | 200 — body may carry `reviewNote`; 409 `LIVENESS_REQUIRED` on a manual-path VERIFIED with no video — or (Lot N) no attestation |
| PATCH | `/:id/documents/:field` | ADMIN | 200 — Lot D: one tile, APPROVED or FLAGGED with a note |
| POST | `/:id/request-reupload` | ADMIN | 200 — Lot D: NEEDS_INFO, the flagged fields, the advertiser told |
| PATCH | `/:id/assign` | ADMIN | 200 — Lot D: a filter, not ownership |
| POST | `/:id/escalate` | ADMIN | 200 — Lot G (Q127/142): `{ reason }`, the case handed to Compliance (source REVIEWER); `KYC_ESCALATED`; 409 decided / already escalated; answers the case |
| DELETE | `/:id` | ADMIN | 200 |

`GET /` takes `?status=` (now including `NEEDS_INFO`), `?assignedTo=me|none`,
(Lot G) `?escalated=true|false` and (Lot N) `?requested=true|false` — a
request from the desk with nothing submitted yet, derived as `requestedAt`
set and `submittedAt` null; `data` carries `escalated` — the count across
the queue with that facet removed — beside `breached`, and
`counts.escalated`; Lot N adds `counts.requested` the same way, and every
row carries `requestedAt` / `requestedById` / `requestedChannel` /
`recordedById` / `recordedVia` with `requestedBy` and `recordedBy` as
`{ id, name } | null` beside `assignedTo`.

## KYC from the desk (Lot N, the owner, 14 Sep 2026)

For publishers, advertisers and print partners, KYC can be done by the
party or their agent (as before), **requested** from the admin panel, or
**recorded** at the desk by an admin. The advertiser's two doors are above
(`POST /advertiser-kyc/:id/request`, `PUT /advertiser-kyc/:id`); the
publisher twin is in `publishers` (`POST /publishers/kyc-queue/:publisherId/request`,
`PUT /publishers/kyc-queue/:publisherId`); the print partner's is N-B2's.
What they share lives here: `kycRequestSchema` (the body),
`requestedFilterSchema` (the facet), `KYC_DEEP_LINK` (`adx://kyc`, what the
push opens) and `kycChannelLabel`. The notice is one `notify('KYC_REQUESTED',
userId, { partyName, channel, note, deepLink })` — the seeded
`kyc-requested` template on EMAIL + SMS (kind `KYC_REQUESTED`) + PUSH,
transactional; the push's data carries `deepLink` so a tap opens the
party's KYC screen.

**Who recorded what.** Every write path stamps `recordedById` /
`recordedVia`: the party's own `POST /` and `PUT /me` write SELF (in the
repository — the recorder is the row's owner), the desk's `PUT /:id` DESK
(the admin), and Digio's completion (`applyDigioWebhook`) DIGIO with no
recorder — and, N2-B, on every party (advertiser, publisher, print partner)
a Digio **approval** also stamps `method` DIGIO, so a record whose documents
were sent by hand while the session was open is Digio-verified once Digio
says so: the liveness gate exempts it and the purge finds it; a rejection
leaves the method alone. The publisher's agent path writes AGENT.

**Nothing over a verified record (N2-B).** Every desk PUT and every self
submit — `PUT /advertiser-kyc/:id`, `PUT /advertiser-kyc/me`,
`PUT /publishers/kyc-queue/:publisherId`, `PUT /print-partner-kyc/:id`,
`POST /print-partners/me/kyc` — refuses a VERIFIED record with 409
`KYC_ALREADY_VERIFIED` before anything is written, pinned or audited. The
desk's re-upload ask (NEEDS_INFO) is what reopens it. A desk recording's
files are uploaded by the admin through `POST /uploads` with purpose
`ADVERTISER_KYC` and **`ownerUserId` = the advertiser's user id** — Lot F
already lets an ADMIN file a private document as somebody else, so no new
upload route was needed.

**Presence at the desk.** The manual path still needs proof the person is
present. Beside the party's own video, an admin who met them may now
**attest** it — `POST /user-kyc/:userId/attest { note }` (the note says how:
"met in person at the Pune desk", "video call on 14 Sep") upserts the
`UserKyc` row VERIFIED, purpose LIVENESS, with `attestedById` / `attestedAt`
/ `attestationNote`, audited `USER_KYC_PRESENCE_ATTESTED` — or record a
video the desk captured on their behalf, `POST /user-kyc/:userId { fileId }`
(the admin's USER_KYC upload, `ownerUserId` the party or the admin's own
hand; `recordedById` the admin; audited `USER_KYC_LIVENESS_RECORDED_AT_DESK`).
`hasSubmittedLiveness` treats an attested row as satisfied, so a
desk-recorded manual KYC can be VERIFIED; `livenessStateFor` (and so every
case read's `liveness`) carries the three attestation columns, and
`GET /user-kyc/:id` answers them on the row.

**The activation gate.** `kyc.printPartnerActivationRequiresKyc` (platform
settings, default **false** — today's behaviour) makes
`POST /print-partners/:id/activate` refuse **409 `KYC_REQUIRED`** while
`PrintPartner.kycStatus` is not VERIFIED (`print-partners.activatePartner`,
reading its own row).

## Escalation (Lot G, Q127/142)

`escalation.service.ts` — one landing for three sources. An escalation
stamps the row (`escalatedAt`, `escalationSource` AGE | FRAUD_LINK |
REVIEWER, `escalationReason`, `escalatedToUserId`, `escalatedById`), names
a member of the Compliance pool, tells them in-app (type KYC, `relatedId`
the party, `relatedType` PUBLISHER | ADVERTISER), and audits
`KYC_ESCALATED` (module `kyc`, target `Publisher`/publisherId or
`AdvertiserKyc`/id, so the trail reads like each desk's own rows). It is a
flag on an open case (PENDING or NEEDS_INFO), not a status: the desk
decides as before, and **the decision clears the five columns** (each
desk's `review` write). Once is enough — the job and the fraud link leave
an escalated case alone; a reviewer's second escalation is 409.

| Source | Where from | When |
| --- | --- | --- |
| `AGE` | `jobs/kyc-escalation.job.ts`, daily under a day lock, `escalateAgedKycCases(systemUser)` | PENDING for longer than `kyc.escalationSlaMultiplier` (default 2) × `kyc.reviewSlaHours`, on both queues, 200 rows per party per night |
| `FRAUD_LINK` | `fraud.openCaseRecord` → `escalateKycForFraudLink` | a fraud case opened against a publisher, one of its listings, or an advertiser whose KYC is PENDING; an agent has no escalatable row |
| `REVIEWER` | `POST /advertiser-kyc/:id/escalate`, `POST /publishers/kyc-queue/:publisherId/escalate` | the reviewer's own button, `{ reason }` |

**The pool** (`resolveEscalatee`): the console role named **Compliance** if
an organisation has made one; else the seeded **KYC reviewer** (the closest
of the six the console ships with — the role with KYC sign-off); else
**Super admin**; else any ADMIN (this module's own read of the role table,
because `users` sits above it). The escalating reviewer is never picked for
their own case while somebody else is in the pool; the pick is stable per
case so a retry lands on the same person and the pool shares the load.
`findRoleMemberUserIds` on `access-control` is the role read.

`prisma-kyc-escalation.repository.ts` reads and writes the escalation
columns on **both** `PublisherKyc` and `AdvertiserKyc`: the publisher row
belongs to `publishers`, which imports this module and cannot be imported
back, and the five columns are the same on both tables.

`/api/v1/user-kyc`, all `authenticate`d:

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/` | any | **201 or 200** |
| GET | `/me` | any | 200 |
| POST | `/me` | any | **201 or 200** — Lot D (Q131): the liveness video by private file id |
| DELETE | `/me` | any | 200 |
| GET | `/` | ADMIN | 200, paginated |
| GET | `/:id` | ADMIN | 200 — Lot N: the row carries `attestedById` / `attestedAt` / `attestationNote` when presence was attested at the desk |
| PATCH | `/:id/review` | ADMIN | 200 |
| POST | `/:userId/attest` | ADMIN | **201 or 200** — Lot N: `{ note }`, presence attested by the admin who met the person; the row VERIFIED, purpose LIVENESS; `USER_KYC_PRESENCE_ATTESTED` |
| POST | `/:userId` | ADMIN | **201 or 200** — Lot N: `{ fileId }`, the liveness video the desk captured on the person's behalf (`recordedById` the admin); `USER_KYC_LIVENESS_RECORDED_AT_DESK`; 403 for a file that is neither the party's nor the admin's own |
| DELETE | `/:id` | ADMIN | 200 |

`/me` is registered ahead of `/:id` in both routers. Do not reorder.

`/api/v1/employee-kyc` (Lot D), all `authenticate`d: `GET /me` (any), and for ADMIN
`GET /`, `GET /ladder` (Lot G), `GET /:employeeId`, `PUT /:employeeId`, `PATCH /:employeeId/review`,
and (N3-B) `POST /:employeeId/request` (ADMIN + `kyc.edit`) — the one click. N3-B: `GET /?state=&status=&q=`
lists **every employee** with `state`, `kycId`, `employeeId` and the `employee` slice (id, userId, displayId,
department, designation, createdAt, user { name, mobile, email }), `meta.counts` per state; the desk's `PUT`
stamps `recordedVia` DESK and `method` MANUAL.

**The intake ladder (Lot G, Q126/Q141).** `GET /employee-kyc/ladder` (ADMIN;
literal path ahead of `/:employeeId`) is the desk's checklist as data —
`{ label, description, version, steps: [{ key, number, title, subtitle?,
hint?, cta?, proofs: [{ key, label }] }], source: 'config' | 'code' }` — the
proofs being `EmployeeKyc` columns. `employee/intake-ladder.ts` holds
`CODE_EMPLOYEE_INTAKE_LADDER` (IDENTITY, PAN, ADDRESS, SELFIE, BANK) and
`employeeIntakeLadder()`, which reads `flows.employee-intake` through
`app-config`'s `getFlow`, checks it against `employeeIntakeLadderSchema`, and
serves the code ladder otherwise — exactly as `orders` reads its job ladder.
`GET /employee-kyc/:employeeId` now carries `intake`, the record laid over the
ladder: each proof `met` when the column holds a value, each step `complete`
when all of its proofs are, and `met` / `total` across the ladder.

## Owned Prisma entities

`AdvertiserKyc` (N3-B: `advertiserProfileId` → `Advertiser.kyc`, the key; `advertiserId` the nullable legacy user key), `UserKyc`, `AgentKyc` and `EmployeeKyc` (N3-B: `method`, the Digio columns, `requestedAt` / `requestedById` / `requestedChannel` / `recordedVia`), `KycDocumentReview`;
the enum `KycEscalationSource` (Lot G), and the five escalation columns on
`AdvertiserKyc` and — written only through this module's escalation
repository and each desk's decision — on `PublisherKyc` and (Lot N)
`PrintPartnerKyc`.

## Public exports (`index.ts`)

- `advertiserKycRouter`, `userKycRouter`, `agentKycRouter`, `employeeKycRouter`.
- `handleAdvertiserDigioWebhook` — for bootstrap; N3-B: `handleAgentDigioWebhook`, `handleEmployeeDigioWebhook` too.
- N3-B: `KYC_QUEUE_STATES`, `deriveKycState`, `kycSummaryOf`, `kycStateCounts`, `kycQueueStateSchema`, `kycPartyStateWhere`, `kycQueueBaseWhere`, `kycRecordStateWhere` — re-exported from `shared/kyc-state`, where they live so the party modules below this one can read them.
- Lot D, for `publishers` (its KYC row lives there, the decisions on its
  tiles live here): `recordDocumentReview`, `flagDocuments`, `flaggedDocuments`,
  `listDocumentReviews`, `clearDocumentReviews`; the desk bodies
  `documentDecisionSchema`, `reuploadRequestSchema`, `assignCaseSchema`,
  `bulkAssignSchema`, `assignedToSchema`.
- Lot D (Q131): `hasSubmittedLiveness`, `livenessStateFor` — the gate and the
  state, for `publishers` and `users`. Lot N: the gate is also satisfied by
  an attestation; the state carries `attestedById` / `attestedAt` /
  `attestationNote`.
- Lot N: `kycRequestSchema`, `requestedFilterSchema`, `KYC_REQUEST_CHANNELS`,
  `KYC_DEEP_LINK`, `kycChannelLabel` — the desk's request body, facet and
  notice bits, for the publisher twin (and N-B2's print partner).
- Lot D: `advertiserKycReviewStateFor` — for `users`' manifest partial mode; Lot F: carries `manifestVersion`, the version pinned at the first submission, so the manifest read answers it when the phone asks for none.
- Lot F: `resolveManifestVersion(sent)` — the version to pin at a first submission (the phone's, else the live `flows.onboarding` version); `publishers` pins its own row with it.
- Lot F: the decision leaves by **one `notify('KYC_DECISION', userId, { partyName, decision, reason }, { inApp })`** — the in-app row plus the seeded `kyc-decision` template's email and SMS, each subject to the KYC preference. The publisher twin (`publishers/kyc/kyc-desk.service.ts`) does the same and, when `Publisher.agentId` is set, tells the onboarding agent in-app (`KYC_DECISION_AGENT`: `relatedId` the publisher, `subtitle` its name, the status in the title, the moment on the row — a `relatedType` column is a schema need).
- Lot D (Q127): `purgeVerifiedAdvertiserImages`, `purgeVerifiedLivenessVideos`,
  `purgeCutoff`, `maskPan`, `trimDigioPayload` — for the purge job and the
  publisher twin.
- Lot G (Q127/142): `escalateKyc` (for `publishers`' button and, Lot N, `print-partners`'),
  `escalateKycForFraudLink` (for `fraud`), `escalateAgedKycCases` (for the
  job), `kycEscalateSchema` / `escalatedFilterSchema` (the shared body and
  facet), `ESCALATION_ROLE_NAMES`.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/audit`, `shared/database` (repositories only).
- `advertisers` — the booking gate; `agents` — the agent record; `employees`
  (Lot D) — the row behind a session and an id check; `notifications` — the
  party told; `uploads` (Lot D) — the liveness file resolved by id, the purge;
  `app-config` — the review SLA and the escalation multiplier;
  `access-control` (Lot G) — the Compliance pool by role name.

## Invariants — the two differ, deliberately

| | advertiser | user |
| --- | --- | --- |
| Second submission | **409 CONFLICT** | upsert: replaces, answers **200** |
| First submission | 201 | 201 |
| Resubmit path | `PUT /me` | `POST /` again |
| Submit for someone else | not supported | ADMIN-only via `userId`, else **403** |

Shared:

- Review sets `reviewedAt` and clears `rejectionReason` to `null` when absent.
- Owner resubmission resets status to `PENDING` and clears the rejection reason;
  the **admin** `PUT /:id` edit does **not** touch status.
- `status` is case-insensitive (`upperEnum`); advertiser `kycType` is **not** —
  it uses a plain `z.enum` and is case-sensitive. Inherited; do not "fix".
- On the advertiser listing an unparseable `status` filter is **ignored**, and
  the listing returns unfiltered. It is not a 400.
- Join slices differ and are part of the contract: the advertiser listing joins
  `id, name, mobile, email`; the user listing and user by-id join
  `id, name, mobile`; `advertiser-kyc GET /:id` and `user-kyc GET /me` join
  nothing.
- Both listings put `meta` as a **sibling** of `data`.

## Tests

```bash
npx vitest run src/modules/kyc
```

## Suggested ownership

One owner for both review flows — that is why they share a module.

## Digio for advertisers (U7, demand side)

`POST /advertiser-kyc/me/digio/initiate` and `GET /advertiser-kyc/me/digio/status`
are the advertiser's own Digio path — the same request as the publisher's,
through `shared/integrations/digio-client`, recorded on the advertiser's KYC
row (N3-B: keyed by the caller's profile, `initiateAdvertiserDigioKyc(profile)`;
the reference `adx-adv-<profileId>-<ts>`; the customer the profile's
company name or name, email and mobile). Digio calls ADX's one webhook, owned by the
publishers module; a request id no publisher row claims is offered to
`handleAdvertiserDigioWebhook`, registered at boot. A decision flips the
advertiser's booking gate the way a manual review does. N2 (the verifier):
the initiate is **409 `KYC_ALREADY_VERIFIED`** over a verified record, before
Digio is asked — a fresh session would re-point the row and its webhook would
write over VERIFIED; like every other submit path.

## The advertiser's Digio case, operated from the desk

`POST /advertiser-kyc/:id/digio/restart` (ADMIN), by the KYC row the queue lists:
a fresh Digio session on the advertiser's row, `ADVERTISER_KYC_DIGIO_RESTARTED`
logged against the admin, the advertiser told to open the app. 409 once verified.

## E6

`UserKyc.fileId` (Lot E column) is written by `POST /user-kyc/me` beside the
`/files/:id` URL and read first on the case (`livenessStateFor`) and by the
purge; the URL parse stays only for rows written before the column.

## E7-3: what every case read carries

`GET /advertiser-kyc/:id`, `GET /agent-kyc/:agentId`, `GET /employee-kyc/:employeeId`
and the publisher twin `GET /publishers/kyc-queue/:publisherId` all spread
`kycCaseExtras(row)` (`case-read.ts`) over their row: `ageHours` and
`slaBreached` on the queue's own rule (`shared/time.slaAge` against
`getPlatformSettings().kyc.reviewSlaHours`, the clock running only while the
row is PENDING) with `slaHours` beside them, and the people on the case by
name — `reviewedBy`, `assignedTo`, `recordedBy` and (Lot N) `requestedBy` as
`{ id, name } | null` beside `reviewedById` / `assignedToId` / `recordedById`
/ `requestedById` (null where the party's row has no such column). The names come through
`registerKycUserLabelPort`, filled by bootstrap from `users.findUserLabels`
because `users` sits above this module; unregistered, every person is
`{ id, name: null }`.

E10-1: the same port names two more things. `kycUserLabels(ids)` is exported
for a queue — the advertiser queue names its assignee per row here, the
publisher queue through the index — and `listDocumentReviewsWithReviewer`
(`document-review/`) is what every case read now spreads as
`documentReviews[]`: each decision with `reviewedBy { id, name }` beside
`reviewedById`, one lookup for the list.

G11-1: the escalation's two people ride the same lookup. `kycCaseExtras`
answers `escalatedTo` and `escalatedBy` as `{ id, name } | null` beside
`escalatedToUserId` / `escalatedById` (null while the case is not
escalated, or once a decision cleared it), and `GET /advertiser-kyc` carries
both on every row beside `assignedTo` — still one label lookup per read, the
ids folded in (`kycCasePeopleIds`, `kycLabelFor`). The publisher queue does
the same through the index (`publishers/README.md`, D7).
