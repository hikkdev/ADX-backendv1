# advertisers

How demand gets from "signed up" to "able to book", and how money moves once it
can. Specification: [`docs/advertiser-onboarding.md`](../../../docs/advertiser-onboarding.md).

This is the demand-side mirror of `supply`. Where a decision could have gone
either way it went the way the publisher side already goes, so the two funnels
read alike in the console and neither needs its own vocabulary.

## What it owns

- **The advertiser account** and its five gates.
- **Brands.** Campaigns, creatives and brand-safety decisions belong to a brand;
  KYC, the wallet, invoices and the platform agreement belong to the account.
- **Two agreements** — `ADVERTISER_PLATFORM` once per account (once per
  version when the live version demands re-acceptance — Lot D, Q55, through
  `agreements.isCurrentAcceptance`), `INSERTION_ORDER` once per campaign per
  version — recorded in the shared `AgreementAcceptance` table. Since Lot D
  (Q123) the insertion order is rendered and written by `agreements`
  (`acceptInsertionOrder`): `POST /:id/agreements/insertion-order` takes only
  `{ campaignId }`, and the legacy `GET/POST /advertisers/agreements/templates`
  pair is retired — templates are `/agreements/templates`.
- **The wallet**: settled balance, goodwill, holds and the entry ledger.

## The city key (Lot X-B)

`Advertiser` carries `cityId` beside the free-text `city` — the `City` row the
string denotes, stamped by the service through `pricing.withCityKey` on
`registerAdvertiser` and `updateProfile` (the party importer goes through both); null for a typed town the catalogue lacks, and the string stays as typed
(the owner's rule). A caller never sends the key. The section overview and `geo` count advertisers by the key, the spelling only for rows whose key is null.

## What it does not own

- **Campaigns and bookings.** That is B2, unbuilt. The seam is `campaignId`,
  which this module stores and never dereferences, so the campaign model can
  land without reopening anything here.
- **KYC documents.** `kyc/advertiser` owns submission and review; this module is
  told the outcome through `applyKycDecision`. N3-B (14 Sep 2026): the record
  is keyed by the Advertiser **profile** (`AdvertiserKyc.advertiserProfileId`,
  the relation `Advertiser.kyc`), the user id riding along only when the
  profile has an app account — so an advertiser ops created on the console
  (no user) can be asked for and hold a record. `applyKycDecision(profileId,
  status)` now takes every `KycStatus` and mirrors it onto `kycStatus` on
  **every** status write (PENDING at a submission, NEEDS_INFO at a re-upload
  ask, the decision); only VERIFIED can activate. `findAdvertiser(id)` (null,
  not 404) is the desk's profile lookup for its `:id` resolution. **The later
  link:** when the owner signs in and registers with the profile's number,
  `registerAdvertiser` → `repository.attachUser` sets `userId` and, in the
  same transaction, stamps `advertiserId` on the record the desk made against
  the profile alone (skipped, never forced, when the user already owns a
  legacy user-keyed record — `advertiserId` is unique). Pinned by
  `n3b-kyc-link-on-claim.test.ts`.
- **Who is owed goodwill.** `supply` decides that when a listing lapses. This
  module credits one advertiser's share.

## Three things worth knowing before changing it

**Money is `Decimal`, and crosses the wire as a string.** The columns are
`Decimal(14,2)` because a running balance accumulates float error; serialising
through a JSON number would hand that back. `moneySchema` is the wire contract.

**Holds, not debits.** Confirmation places a hold, campaign start captures it,
cancellation releases it. A release is cheap and a refund is not — the same
reasoning behind `EarningsHold` on the supply side. Every wallet operation is a
single transaction, because splitting "check the balance" from "spend it" is how
a wallet gets double-spent under load.

**Goodwill spends first.** It cannot be withdrawn and exists only to be spent on
a booking, so capturing settled balance while leaving goodwill behind would
quietly strand it.

## Lot A: suspension and the frozen wallet

`bookingEligibility` reports `SUSPENDED` as its own blocker and `assertCanBook`
raises 409 `ADVERTISER_SUSPENDED` **before** the ordinary gates: an account ADX
has suspended is told so, rather than being sent to KYC or to top-up for a
problem it does not have. That one check covers the whole demand side, because
checkout and the package purchase both go through it.

`assertNotSuspended` is the same check on its own, for a path with no KYC or
funds question to answer: an admin recording a bank transfer that has already
arrived (`POST /packages/sales/:id/record-payment`) still may not start a plan
for a suspended advertiser.

`holdForCampaign` and `payForPackage` additionally refuse 409 `WALLET_FROZEN`
when the wallet is frozen, checked explicitly rather than left to the funds
test, which would report a frozen wallet as merely short. `requestRefund` is
exported for `modules/suspension`, which raises one request per campaign that a
suspension stopped — never a direct wallet write.

The suspension columns on `Advertiser` are written by `modules/suspension`;
this module only reads them.

## Lot B: the cash side, top-ups and the refund desk (B3a)

**Every wallet movement is a `wallets.move`.** Top-up, hold capture, package
debit, goodwill, refund and expiry all go through the wallets service with
their counter-legs, so the statement line, the double-entry twin and the
FREEZE_WALLET check are one path — the repository here keeps only the hold
(a reservation, not a movement) and the `WalletTopUp` record. The legs are
listed at the top of the wallet section in `advertisers.service.ts`; the
capture is booked whole to `platform:payables`, and ADX's take is recognised
day by day when the accrual splits each day's gross. `cash-legs.test.ts`
proves `verifyLedger` stays healthy across top-up → capture → refund.

**Structured top-ups (Q41/Q118).** `POST /advertisers/:id/wallet/top-up`
takes `{ amount, method: BANK_TRANSFER|CHEQUE, utr?, receivedAt,
bankAccountId?, proofFileId?, note? }` — a bank transfer needs its UTR, a
cheque puts its number in `utr`, and the proof is an upload with purpose
`TOPUP_PROOF`. The wallet is credited against `platform:suspense` until
reconciliation matches the bank line; the same UTR on the same wallet is one
top-up and a second entry answers 409. `GET /advertisers/:id/wallet/top-ups`
lists them. The gateway does not call the route: Lot C calls
`recordGatewayTopUp`, which books against `platform:cash`, marks the row
reconciled at once, and answers a replayed webhook with the top-up it
already made. Audited `WALLET_TOPUP_RECORDED` against the Wallet with the
balance before and after.

**Refund requests carry a destination (Q41).** `WALLET_CREDIT` (the default)
needs nothing more: approval releases the frozen slice back to spendable
balance and the request records that ADX answered with credit.
`BANK_TRANSFER` needs the advertiser's recorded `consentNote` and a VERIFIED
`payoutMethodId` of their own; approval captures the hold as a REFUND debit
(wallet − / payables +) and leaves the request APPROVED for finance, who
`POST /advertisers/refund-requests/:id/mark-paid { railReference }` (payables
− / cash +, status PAID) or `/fail { reason }` (the money returns to the
wallet as a REFUND credit, payables reversed, status FAILED). T-B: both answer
the desk's row — the request with its `advertiser { id, displayId, name }`,
as `GET /advertisers/refund-requests` lists it (the same include on the
write, `refundDeskInclude`).
`ORIGINAL_METHOD` (Lot C, Q110) is allowed only when `payments` says — through
`OriginalMethodRefundPort`, registered by bootstrap — that the advertiser has a
captured gateway payment with enough left to return to (409
`GATEWAY_NOT_CONFIGURED` otherwise, and always while the port is unregistered);
approval takes the same REFUND debit a bank transfer does, and finance sends it
back with `POST /payments/:id/refund { refundRequestId }`, which marks the
request PAID with the gateway's refund id (rail stays unset — a gateway return
is not a payout rail) or FAILED, through `markRefundPaid` / `failRefund`. The
desk reads `GET /finance/refund-requests?status=&page=&pageSize=` on the list
contract. Every step is audited against the `WalletRefundRequest`.

**Campaign refunds** are the other queue: a campaign cancelled after capture
records a PENDING `CampaignRefund` in `campaigns`, and finance releasing it
credits the wallet through `creditCampaignRefund` here — REFUND legs out of
payables, keyed on the refund.

Dormant credit is expired the same way: one EXPIRY movement per wallet,
goodwill first, against `platform:revenue`; a frozen wallet is skipped
rather than expired underneath a review.

## Gate 4 is not an admin action

Top-up and goodwill are `ADMIN`-only, and should be. Accepting the platform
agreement is not, and must not become so: it is the advertiser's own click,
exactly as the publisher's is. An agreement accepted by ADX on an advertiser's
behalf is not an agreement.

## The door-to-door code (self routes)

The same code the publisher shows, for an advertiser, mounted with the other `/me` routes and ahead of `/:id`:

- `GET /me/qr?latitude&longitude` — a 90-second one-time code, reused while live, reissued once dead; the query is the phone's fix.
- `GET /me/qr/status` — polled while the code is on screen: is it live, and who scanned it (name, ADX id, photo, distance).
- `POST /me/qr/scans/:scanId/approve` — the owner's yes: burns the code, attaches the agent (attribution, set once), opens the ONBOARDING grant (authority, 48 h, revocable).
- `POST /me/qr/scans/:scanId/decline` — the owner's no: burns the code, logs USER_DECLINED.

An advertiser has no onboarding-status column; "an agent is mid-way" is read off the live ONBOARDING grant. The claim port `advertisers` registers with `qr` at bootstrap is in `advertiser-onboarding.service.ts`.

### U9 — the advertiser's access log

`GET /advertisers/me/access-log`: every scan of the advertiser's door-to-door
codes (refusals included), every grant opened on the account and how it ended,
and every write made under one — composed by `access-grants` (`accessLogFor`).
Advertiser-side agent writes are not yet gated on a grant, so `changes` is
empty until they are.

## Who may act on an account (advertisers.policy)

Every `/advertisers/:id/*` read and write passes `assertMayActFor`: the OWNER
and an ADMIN may do anything; the agent the account is attributed to may READ,
and may WRITE only while the owner's `DelegatedAccessGrant` on the account is
live — the approval they gave at the door, closed when onboarding ends or they
withdraw it. Agent writes are logged against the grant, which is what the
owner's access log (`GET /advertisers/me/access-log`) reads back. Before this,
these routes checked only that the id named a row.

## The agent's book, the detail card and the brands (DR 06, `book/`)

`GET /advertisers/mine` is on the list contract — `?q=&status=ACTIVE|PENDING&sort=&page=&pageSize=`
→ `{ items, total, page, pageSize, counts }` — and every figure on a row is
read from rows that already exist:

- **The next action decides the footer.** `CHECK_IN` when an open `FieldVisit`
  is on the calendar for the account; else `FOLLOW_UP` once no campaign has
  been created in `DORMANT_AFTER_DAYS` (45, named once, with the line "No
  campaigns in 45 days"); else `METRICS`. Check in beats Follow up beats metrics.
- **Fields with no source are absent, not zero-filled.** An advertiser has no
  category — the card's "QSR" is the newest campaign's `industry`, null when
  there is none — and no locality, so the card draws the city.
- **Spend is committed budget** across SCHEDULED / LIVE / PAUSED / COMPLETED
  campaigns, as money; a draft commits nothing and is not counted as a campaign.
- **The histogram ignores the chip in force**, as on every other list.
- **Check in and Follow up are `AccountActivity` rows (decision 14)** —
  `POST /advertisers/:id/activity { kind, note? }`, one party per row, logged
  by the account's own agent. Not a `LeadActivity`: a lead converts and stops
  being one; an account keeps its log. A READ-level act: a phone call is not a
  write to the account and needs no live grant.
- **`GET /advertisers/:id/summary`** is the detail card: the row, the metrics
  (campaigns · spots · spend), the campaigns, and an activity feed merged from
  the action log, field visits, campaigns that went live and packages paid.
- **Brands (S8).** `GET /advertisers/:id/brands?status=ACTIVE|ARCHIVED` now
  answers cards with per-brand live/scheduled/total counts, lifetime committed
  spend and the newest campaign's `awareness`; `isActive` is still on the row
  for the two readers that already existed. Archiving is `PATCH … { isActive:
  false }`, unchanged; the third chip is `?status=ARCHIVED`.
  `GET /advertisers/:id/brands/:brandId` is the card with its campaigns.

The `campaignId`/`advertiserId` trap the brief warns about holds here too:
`Order.advertiserId` is a **User** id; everything this feature joins on is an
**Advertiser** id, so it never touches orders.

## E6: the reads the console asked for

| Route | Who | What |
| --- | --- | --- |
| `GET /advertisers/:id` | owner, their agent, admin | now carries `user: { closedAt, closeReason } \| null` — null while no account backs the profile (an agent holding it open); an open account answers both null. N3-B: and `kyc: { state, kycId, submittedAt, requestedAt, requestedChannel, method }` — the record by the profile first, then (a legacy row) by the user (`repository.findKycSummary`), `state` derived by `shared/kyc-state` the way `GET /advertiser-kyc` derives it (AWAITING_DOCUMENTS with no record), so the party page and the queue agree |
| `GET /advertisers/:id/wallet/refund-requests?status=&page=&pageSize=` | owner or their agent (`assertMayActFor` READ), admin | the advertiser's own requests on the list contract `{ items, total, page, pageSize, counts }` (`counts` by status with the status facet removed); every row carries `destination`, `status`, `amount` (decimal string), `consentNote`, `railReference`, `paidAt`, `createdAt` (nulls kept, never dropped) beside the rest of the WalletRefundRequest row and `advertiser { id, displayId, name }` — E11-1: pinned by `e11-refund-requests-read.test.ts` |
| `GET /finance/refund-requests` | ADMIN | every row now carries `advertiser { id, displayId, name }` and `amount` as a decimal string through `money()` |

## Lot G (Q119): the industry

| Route | Who | What |
| --- | --- | --- |
| `GET /advertisers/industries` | any session | the picklist — `ADVERTISER_INDUSTRIES`, a constant list in code: Retail, Food & beverage, Real estate, Education, Healthcare, Automotive, Finance, Entertainment, E-commerce, Government, NGO, Other. Ahead of `/:id` |
| `POST /advertisers` / `PATCH /advertisers/:id` | as before | `industry`, one of the list (the patch may send `null` to clear it); a value off the list is **400** |

`Advertiser.industry` rides every read of the row (`GET /:id`, `/me`, the
roster, the funnel rows). A new industry is a line in the constant, not a
free string, so the analytics can group on it.

## E7-3

| Route | Who | What |
| --- | --- | --- |
| `GET /advertisers?q=&limit=&cursor=` | ADMIN | the roster takes `q` beside its cursor page — a case-insensitive contains over `name`, `companyName`, `email`, `displayId`, and `mobile` as typed; the page shape is unchanged |
| `GET /finance/top-ups?q=&from=&to=&status=RECONCILED\|UNRECONCILED&page=&pageSize=` | ADMIN | the register of every `WalletTopUp` on the list contract — `q` is the UTR (contains), `from`/`to` bound `receivedAt`, the chips are reconciled / not; each row names the advertiser. Its own router (`topUpDeskRouter`), mounted by bootstrap at `/finance/top-ups` for the same reason as the refund desk |
