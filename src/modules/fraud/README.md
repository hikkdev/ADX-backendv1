# fraud

Fraud as a case object — Lot D (Q54/Q92/Q121), 12 September 2026.

A dispute can say "this looks like fraud"; it cannot say which party, on what
evidence, who looked, and what was done about it. That record is a case: a
subject (one of the four parties `suspension` knows), a kind, a summary, the
notes and evidence gathered while it is worked, and a decision. The decision
is the only thing here that touches the party, and it does so **through the
suspension module** — a case never writes a suspension column itself.

## Routes

All under `/api/v1/fraud`, all `authenticate + requireRole('ADMIN')` at the
router. The party learns of a case through the suspension a decision applies,
never through these routes.

| Method | Path | What |
| --- | --- | --- |
| GET | `/cases` | The desk, on the list contract: `?q=&status=&sort=&page=&pageSize=` plus `subjectType`, `subjectId`, `disputeId`; counts by status. G11-1: every row carries `openedBy`, `assignedTo`, `decidedBy`, `escalatedTo` as `{ id, name } \| null` beside the `*UserId` columns — one `users.findUserLabels` lookup for the page; a failed lookup leaves the names null, never the row. |
| POST | `/cases` | Open one: `{ subjectType, subjectId, kind, summary, disputeId?, assignedToUserId? }`. **201.** `FRAUD_CASE_OPENED`. |
| GET | `/cases/:caseId` | The file: the case, its notes, its evidence, and where the subject stands today (`suspension`). G11-1: the same four people by name as the list row. |
| POST | `/cases/:caseId/notes` | `{ body }`. **201.** `FRAUD_CASE_NOTE_ADDED`. |
| POST | `/cases/:caseId/evidence` | `{ kind, fileId?, url?, note? }` — at least one of the three. **201.** `FRAUD_CASE_EVIDENCE_ADDED`. |
| PATCH | `/cases/:caseId` | `{ status: 'INVESTIGATING', assignedToUserId }` — working the case. `FRAUD_CASE_UPDATED`. |
| POST | `/cases/:caseId/decide` | `{ status: CONFIRMED \| DISMISSED, decision, scopes? }`. `FRAUD_CASE_DECIDED`, carrying `scopesApplied` / `scopesLifted`. Closes an ESCALATED case too. |
| POST | `/cases/:caseId/score` | Lot G (Q118/138): the signals recomputed over the case's party and stored — `score` (a decimal string, 0–1), `signals[]` (`{ key, weight, value, detail, links?, candidates? }`), `scoredAt`. G13-B: `candidates` is the parties the signal compared against, matched or not, at most 20 per signal (`CANDIDATES_PER_SIGNAL`) — the photo comparison names the publishers whose photos were hashed, commission farming the publishers the agent onboarded; a handle lookup (PAN, bank, subnet, phone, device) answers only its matches, which are the links already. `FRAUD_CASE_SCORED` with a diff on `score`. 409 on a decided case: its score is part of the record. |
| GET | `/cases/:caseId/linked` | Lot G: the accounts the shared signals tie the party to, computed now — `{ subject, linked: [{ party: { type, id, name }, via: [signal keys], walletBalance, openBookings }], valueAtRisk, computedAt }`, most-linked first. Only the linking signals are evaluated. G11-1: each linked party carries `walletBalance` (its wallet's balance as money through `wallets.findWalletFor`; null with no wallet) and `openBookings` (its non-terminal orders through `orders.openOrderExposureFor` — a publisher by its listings, an agent by the jobs it holds, an advertiser by its login, which the index resolves first; none, no orders), and `valueAtRisk` is every linked balance plus every linked open order's value (`Order.budget`), as money. The subject's own figures are not in it — the rail is about the accounts around the case. G13-B: `evaluated: [{ party, linked: false }]` — the parties the last scoring compared the subject against without a link (the graph's "Clean" nodes), read off the case's stored `signals` payload, the subject and anything linked now taken out; `[]` on a case never scored. 28 Sep 2026 (the graph's shared-attribute nodes): `attributes: [{ signal, label, display, accounts }]` — one per linking signal that tied the subject to somebody, `accounts` the distinct linked accounts it names, `display` **masked** by `signals/shared-attributes.ts`: PAN → `PAN ••••` + last four; payout account → bank short name (a leading acronym of the typed name, else the IFSC's bank code, else the name's initials) + `••` + last four, a UPI id → `UPI ••` + the last four of its handle; device → `Device` + the token's first four; subnet → `a.b.c.x/24` (IPv6: two hextets); mobile → `Mobile ••` + last four; any other signal → its label. A mask keeps four characters of a value of eight or more, two of five to seven, none of a shorter one — a full PAN, account number, UPI id, mobile or address never leaves the module. A second handle of the same kind is counted, not shown (`+1`). Only the handles of a signal that linked are read. Each linked account also carries `kycStatus` (the party resolved once through the index; null when it does not resolve), for the graph's hover card. |
| POST | `/cases/:caseId/escalate` | Lot G (Q118): `{ note, toUserId? }` → status **ESCALATED**, `escalatedAt`, `escalatedToUserId` (the named admin, else the investigator, else nobody), `escalationNote`; the escalatee is told in-app. `FRAUD_CASE_ESCALATED` with a diff on status and escalatee. 409 when already escalated or decided. Still open: notes, evidence and the decision all continue. |
| POST | `/scan/:subjectType/:subjectId` | Lot G (Q138): the signals over a party with no case — `{ subject, score, signals, scoredAt, openCase }`. Stored nowhere; audited `FRAUD_SUBJECT_SCANNED` against the party, because a scan names one. 404 on a party that does not exist. |

## Owned Prisma entities

`FraudCase`, `FraudCaseNote`, `FraudCaseEvidence`; the enum `FraudCaseStatus`
(`OPEN · INVESTIGATING · ESCALATED · CONFIRMED · DISMISSED` — ESCALATED is
Lot G, a working status like INVESTIGATING). The table's own CHECK
(`FraudCase_decided_is_signed`) refuses a decided status without
`decidedByUserId` and `decidedAt`. Lot G columns: `score` (DECIMAL 4,3),
`signals` (JSON), `scoredAt`, `escalatedAt`, `escalatedToUserId`,
`escalationNote`.

## Signals and the score (Lot G, Q118/138)

A signal is one computed fact about a party, in its own file under
`signals/`, with a fixed `key`, a `weight`, and `evaluate(subject, { index,
now }) → { value: 0 | 1 | fraction | null, detail, links? }`. The score is
`min(1, Σ weight × value)`; a null value (the photo hash without a decoder,
or a signal that threw) is shown but adds nothing. Every signal reads
through `FraudSignalIndex` — the read-only cross-party index
`prisma-fraud-signals.repository.ts` fills from the KYC rows, payout
methods, refresh tokens (the sign-in address), device tokens, photos,
orders, wallets and withdrawals — so a signal is a pure function of what the
index answers and is tested with a hand-written one. A LISTING subject
resolves to its publisher (keeping `listingId`); the PAN compared is the one
on the party's KYC row, and a purged PAN (last four only) compares as none.

| Key | Weight | Reads 1 when… | Value |
| --- | --- | --- | --- |
| `SHARED_PAN` | 0.35 | the same PAN is on another party's KYC row (publisher, advertiser or agent) | 0/1, links |
| `SHARED_BANK` | 0.35 | the same payout account number or UPI id is on another party's payout method (normalised: spaces and dashes out, case folded) | 0/1, links |
| `SHARED_IP_SUBNET` | 0.15 | another party signed in from the same /24 (IPv6: /64) inside 30 days — `RefreshToken.ipAddress` | 0/1, links |
| `SHARED_PHONE_ACROSS_ROLES` | 0.15 | the party's mobile is registered as a party of another type | 0/1, links |
| `SHARED_DEVICE` | 0.25 | another login registered the same device token (`DeviceToken.token`). The token is the only device identity the platform holds; an **app-side device id** (a stable install id the phone reports at sign-in) is a later addition — until it lands a phone that re-registers under a second account moves the token row rather than duplicating it, so this mostly reads 0. Kept so the weight and the read are in place for the id column. | 0/1, links |
| `BANK_NAME_MISMATCH` | 0.2 | the payout account is in another name — the rail's penny-drop `nameMatchPct` below 70 when it stored one, else the stored `accountHolder` shares no word with the party's name | 0/1 |
| `DUPLICATE_LISTING_PHOTOS` | 0.3 | a listing photo's dHash (`signals/dhash.ts`, 9×8 grayscale, 64 bits, ≤ 6 bits apart is the same photo) matches another publisher's. G10: the decoder is `sharp` (`signals/thumbnail-decoder.ts`), registered at boot by bootstrap's `installThumbnailDecoder()` — the bytes off the local `uploads/` directory for a `/uploads/<file>` URL, else over HTTP with a five-second timeout (20 MB cap), then `sharp(buf).grayscale().resize(9, 8, { fit: 'fill' }).raw()`; a photo that cannot be fetched or decoded is null through the seam (not compared, never a match). Unregistered — a test, or a process that never booted — the signal answers **null** rather than guessing | 0/1/null, links |
| `PROOF_FAR_FROM_SITE` | 0.3 | INSTALLATION proofs (`OrderPhoto`) in 90 days taken > 500 m from the listing's coordinates, or captured outside the order's `startDate`…`endDate` (a day's tolerance either side) | the share of proofs that are wrong |
| `SELF_DEALING` | 0.4 | a party of the opposite role (publisher ↔ advertiser) shares the PAN or the bank account — the detail names which | 0/1, links |
| `COMMISSION_FARMING` | 0.3 | an agent (≥ 3 publishers onboarded) whose publishers are > 40 % REJECTED at KYC, or of those ≥ 60 days old, more than half never received a booking | 0/1 |
| `REFUND_DISPUTE_RATE` | 0.25 | (refunds + disputes) / bookings > 30 % over 90 days, on at least 3 bookings | 0/1 |
| `WITHDRAW_AFTER_CREDIT` | 0.2 | a withdrawal requested within an hour of a wallet credit, each withdrawal counted once, over 90 days | count / 3, capped at 1 |
| `LISTING_VELOCITY` | 0.2 | more than 10 listings created inside any ten-minute window in 30 days | 0/1 |

The sum of the weights is well over 1 on purpose: two strong shared signals
saturate the score, and a single circumstantial one cannot. The score is
**never acted on alone** — nothing here suspends; a case is opened, a
person decides.

**There is no auto-suspension, by decision (Q118).** The score opens a
case and tells the desk; the only thing that ever touches the party is a
CONFIRMED decision signed by an admin, applied through `suspension`. So a
case's timeline has no "suspended automatically" row before its first row:
the first row is the case's opening (`FRAUD_CASE_OPENED`, by the desk or by
the nightly scan under the system user), and a suspension appears only after
`FRAUD_CASE_DECIDED`. A console that draws a timeline should start it there
rather than look for an earlier automatic step.

**The nightly scan** — `jobs/fraud-signal-scan.job.ts`, daily under a day
lock, `runSignalScan(systemUser)`: every party (each type bounded by
`fraud.scanLimitPerType`, most recently active first) is evaluated; any
signal above `fraud.scanThreshold` (default 0.6) on a party with **no open
case** (OPEN / INVESTIGATING / ESCALATED) opens one — kind `SIGNAL_SCAN`,
the hot signals in the summary, score and signals stored, `FRAUD_CASE_OPENED`
under the system user — and every admin is told once with the list. A party
already under a case is counted, not re-opened.

**Cases and KYC** (Q127/142): `openCaseRecord` — the insert the desk and the
scan share — tells `kyc.escalateKycForFraudLink` after the row is written,
so a PENDING KYC on the same party is escalated as FRAUD_LINK. The KYC side
never fails the open; it is logged and the case stands.

## Invariants

- **The number is `identifiers`' FRAUD_CASE series (prefix `FRD`).** Lot E
  put the series on the counter and E6 moved the mint: `openCase` calls
  `allocateIdentifier('FRAUD_CASE')` and the repository's `create` is a
  plain insert. The per-year `FRD-YY-NNNN` count is gone; the format is
  editable at `/identifiers/FRAUD_CASE` like every other series.
- **A case is opened against a party that exists.** `suspensionOf` is the
  existence check — it 404s on a party the platform does not have.
- **CONFIRMED applies scopes through `suspension.suspendParty`** with the
  reason `Fraud case FRD-…` and the deciding admin as `byUserId`. The default
  pair is `BLOCK_NEW + FREEZE_WALLET` — decision 121: the wallet freeze **is**
  the FREEZE_WALLET scope, not a second mechanism. Requested scopes are
  filtered to what the subject's type admits (`SCOPES_BY_PARTY`; a listing
  has no wallet) and to what the party is not already carrying, so
  `scopesApplied` is exactly what this case did.
- **DISMISSED lifts exactly what this case applied.** On an OPEN or
  INVESTIGATING case it touches the party not at all; on a CONFIRMED case
  (an overturn) it reads `FraudCase.appliedScopes` — the column the
  confirmation wrote (Lot E; E6 moved the read off the audit trail) — and
  reinstates those and nothing else. A scope the party was carrying
  before the case, or took from another case since, stays. The
  `FRAUD_CASE_DECIDED` audit row still carries the same list, so the trail
  keeps the record too.
- **Decided once in each direction.** A confirmation cannot be repeated; a
  dismissal is final (open a new case). A decided case takes no more notes,
  evidence or patches.
- **The opener and the investigator hear the decision** (`SYSTEM`
  notifications). The party hears through the suspension module's own
  notification, which names the reason — and so the case number.
- **A dispute names its open case.** `findOpenFraudCasesForDisputes` is the
  disputes export (an ESCALATED case is open too); `disputes` puts `openFraudCase` on the ADMIN read of a case
  (never on a party's — being investigated is not something the platform
  tells you). `disputeId` is taken on trust rather than validated against
  the disputes table: validating it would make this module read disputes
  while disputes reads this one, and a cycle is the wrong price for a
  foreign-key check the console already makes.

## Dependencies

G11-1: `wallets` (`findWalletFor`) and `orders` (`openOrderExposureFor`) for
the linked-accounts rail, both through their indexes; neither reaches back
here. `users.findUserLabels` names the people on a case.

`suspension` (`suspensionOf`, `suspendParty`, `reinstateParty`,
`SCOPES_BY_PARTY`), `users` (`userExists`, `listAdminUserIds`),
`notifications`, `identifiers`, `kyc` (`escalateKycForFraudLink`),
`app-config` (`fraud.scanThreshold`, `fraud.scanLimitPerType`),
`shared/geo` (`haversineMeters`), `shared/audit`.

## Tests

```bash
npx vitest run src/modules/fraud
```

## Order fraud screening (the owner, 2 Oct 2026) — `order-screening/`

"Watch mode, no automatic holds … I agree on both." Every order is scored,
explainably; a score at the review threshold FLAGS it for the desk; the
automatic HOLD exists and ships OFF (`fraud.orderScreening.autoHold`).
Automation never goes past a reversible hold; cancelling as fraud and
suspending a party are a person's acts. Parties never see the word: no
notification to a party about a flag or a hold, a held order reads "Your
order is being reviewed — we'll update you shortly", and a cancellation as
fraud reaches them as the ordinary cancel with the reason "Cancelled after an
ADX review".

**The score** (`order-signals.ts`, pure): the party rule `min(1, Σ weight ×
value)` over three sides at once — the advertiser's party signals (the
placing login's advertiser profile), the listing publisher's, and the
order's own six — every row `{ key, weight, value, detail, side, links? }`
(`side` ADVERTISER | PUBLISHER | ORDER; the case's `candidates` dropped).
Band LOW / REVIEW / HOLD against the thresholds.

| Key | Weight | Reads 1 when… |
| --- | --- | --- |
| `NEW_ACCOUNT_BIG_ORDER` | 0.35 | the account (the earlier of the profile and the login) is younger than `newAccountDays` and the order (`budget`) is over `bigOrderAmount` |
| `ORDER_VELOCITY` | 0.25 | more than `velocityCount` orders by the login in the `velocityMinutes` before this one (inclusive) |
| `DUPLICATE_ORDER` | 0.3 | another live order by the login on the same listing with an overlapping flight (undated: placed within a day) |
| `PAYMENT_TROUBLE` | 0.25 (graded) | `max(failed/3, refunds/2)` — failed payments on the order's campaign (else in the day before), gateway refunds and campaign refunds over 90 days. `payments` records no payer name, so that comparison is not made |
| `LINKED_PARTIES` | 0.5 | a shared signal on either side (PAN, bank/UPI, subnet, phone, device, self-dealing) names the other party, the same login is on both, or the same agent onboarded both (`agentId`, or QR-14 `onboardedById` through an AGENT/QR door) |
| `PRIOR_CONFIRMED_FRAUD` | 0.6 | a CONFIRMED fraud case on either party, or a CONFIRMED_FRAUD order by the login or on the publisher's spots |

**What a scoring does** (`screeningOutcome`): CONFIRMED_FRAUD is never
moved; at the review threshold FLAGGED — except a CLEARED order whose firing
signals (`SIDE:KEY`) were all dismissed by the Clear
(`riskClearedSignalKeys`): it re-flags only on a new one; below the
threshold the review stands (a flag is a person's to answer). A hold only
with `autoHold` on, at the hold threshold, on an open order not already held
(`heldById` null, audited `ORDER_HELD` under the system user,
`metadata.automatic`). A new flag tells the desk in-app — the admins whose
role holds `kyc.view` — once per order (placement, payment) or once per
nightly batch.

**When**: on placement (a direct booking) and on payment (a campaign's
orders, at authorisation and when the hold is captured) — `orders`' screening
port, filled by bootstrap; nightly (`jobs/order-risk-rescreen.job.ts`: hourly tick, day lock
in IST, Redis-locked, heartbeat `order-risk-rescreen`; every open order, 200
at a time, each party evaluated once per run), and on demand
(`POST /orders/:id/rescore`). With `enabled: false` the automatic triggers
do nothing; Rescore still scores. A scoring failure never reaches the order.

**Routes** (mounted at `/orders`, ahead of the orders router, guarded per
route — ADMIN + `kyc.view` to read, `kyc.edit` to act):

| Method | Path | What |
| --- | --- | --- |
| GET | `/orders/fraud-review?status=&q=&page=&pageSize=&sort=` | `status` FLAGGED (default) / HELD / CLEARED / CONFIRMED / ALL, `sort` score (default, highest first, unscored last) / newest, both case-insensitive. The list contract with `counts` per tab over the search. Rows: the board's row (`listing`, `agent`, `campaignSpot`, `placedBy`) plus every risk column. HELD is the hold whatever the review says; ALL is every order scored or held |
| POST | `/orders/:id/hold { reason }` | A person's hold. 409 when held or finished. `ORDER_HELD` |
| POST | `/orders/:id/release { note? }` | The hold lifted; the review stands. 409 when not held. `ORDER_RELEASED` |
| POST | `/orders/:id/clear { note? }` | Released if held, CLEARED, the firing signals added to `riskClearedSignalKeys`. 409 on CONFIRMED_FRAUD. `ORDER_RISK_CLEARED` |
| POST | `/orders/:id/confirm-fraud { reason }` | + `marketplace.edit`. CONFIRMED_FRAUD (the reason on `riskReviewNote`), then `orders.cancelOrder` with the neutral reason, `campaigns.cancelSpotsForOrders` and one `advertisers.requestRefund` per campaign owed (a second person releases it) — the suspension's STOP_OPEN_WORK path; any hold lifted. 409 CONFLICT on a cancelled order; 409 `ORDER_LIVE` from PENDING_OTP on (the advertisement is up — a dispute's to unwind). Answers the state plus `refunds[]`. `ORDER_CONFIRMED_FRAUD` |
| GET | `/orders/:id/cancel-impact` | Read only: `{ orderId, status, cancellable, blockedReason, refund: { amount, to: ADVERTISER_WALLET or NONE, note }, publisherReversal: { amount: what the cancel reverses (0.00 — it stops further days only), accruedToDate, note }, agentsReleased, campaignEffects: string[] (plain words), campaign: { campaignId, reference, spotsCancelled, refundNeeded } or null }` — the campaign figure is `cancelSpotsForOrders(…, { dryRun: true })`, the cancel's own computation |
| POST | `/orders/:id/fraud-case` | A case on the advertiser behind the order: attached (a note) to their open case, or opened (kind `ORDER_FRAUD`; the order id, score and top signals in the summary); `fraudCaseId` on the order. Answers `{ fraudCaseId, fraudCase: { id, displayId, status }, order, opened, attached }`; **201** when opened, 200 when attached (or the order already names an open case). 409 when the login holds no advertiser profile. `FRAUD_CASE_OPENED` (when opened) + `ORDER_FRAUD_CASE_LINKED` |
| POST | `/orders/:id/rescore` | Scored now (`MANUAL`), effects applied. Answers the state plus `held`. `ORDER_RESCORED` |
| POST | `/orders/fraud-review/bulk { action, orderIds[], reason? }` | `action` HOLD / RELEASE / CLEAR / CONFIRM_FRAUD; at most 100 distinct ids; HOLD and CONFIRM_FRAUD need the reason; CONFIRM_FRAUD needs `marketplace.edit` (403 for the whole call). Answers `{ action, results: [{ id, ok, code?, message? }], succeeded, failed }`; each success audited as its single route is |

Single acts answer the order's screening state (`OrderRiskState`: id,
displayId, status, the parties' ids, budget, dates and every risk column).
The reads behind the facts: `prisma-order-screening.repository.ts`
(read-only); every write to the order goes through `orders`.
