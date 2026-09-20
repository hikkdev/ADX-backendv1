# Advertiser onboarding

Companion to `publisher-supply-lifecycle.md`. That document describes how
inventory gets onto ADX; this one describes how demand does.

The two are deliberately symmetrical. An advertiser passes gates in the same
shape a publisher does, signs an umbrella agreement and then a per-transaction
one, and carries a wallet whose money moves through holds rather than direct
debits. Where the shapes match, the code should match — the console screens,
the funnel query and the agreement machinery are all reused rather than
rebuilt.

## What already existed

Worth stating, because it constrains the design:

- An advertiser is a `User` carrying `Role.ADVERTISER`. There was no profile
  row, which is why `Order.advertiserId` points at `User.id`.
- `AdvertiserKyc` already encodes four advertiser types with distinct document
  sets: `INDIVIDUAL`, `COMMERCIAL`, `NGO`, `AGENCY`. Those document lists are
  settled and are not revisited here.
- `Role.AGENT_ADVERTISER` exists alongside `AGENT_PUBLISHER`, so a sales-led
  demand path was already anticipated.
- Self-service KYC submission and admin review endpoints are live, and the
  console has `/advertisers`, `/advertisers/[id]` and `/kyc/advertisers`.

`Order.advertiserId` keeps pointing at `User.id`. `Advertiser` hangs off `User`
by a unique `userId`, exactly as `Publisher` does, so nothing existing has to
be repointed.

## The five gates

| # | Gate | Cleared by | Blocks |
|---|------|-----------|--------|
| 1 | Account | Mobile + OTP, or an `AGENT_ADVERTISER` creating it on their behalf | Everything |
| 2 | Profile | Advertiser type, company details, GSTIN, billing address | KYC submission |
| 3 | KYC verified | Digio, documents per type, reviewed in `/kyc/advertisers` | Agreement |
| 4 | Platform agreement | One click, one per account — since QR-16 no longer post-KYC | Booking |
| 5 | Funded | Wallet balance or a payment method on file | Booking |

Browsing and pricing are open from gate 1 — an advertiser sees inventory and
what it costs before proving anything. Booking blocks until gate 5.

**QR-16 (the owner, 17 Sep 2026): gate 3 holds the launch, not the booking.**
An unverified advertiser browses, fills a cart, accepts the agreement and
pays; `bookingEligibility` names KYC under `launchBlockedBy` rather than
`blockedBy`. A paid campaign whose advertiser is still unverified stays
SCHEDULED — its hold uncaptured, one due today included — and the lifecycle
tick launches it on the first pass after the record is verified (identity,
and the business documents for a business). The advertiser is told at
authorisation and once a day after; ops once a day. `GET /campaigns/:id`
carries `launchBlockedBy` so the app says "paid — verify to launch".
`Advertiser.activatedAt` still means gates 3 and 4 both clear.

An `AGENT_ADVERTISER` can drive gates 1 and 2 for an account and can assemble a
campaign, but **gate 4 is the advertiser's own click**. This is the same rule
as the supply side, where ADX may do the listing work but acceptance belongs to
the publisher. An agreement accepted by ADX on an advertiser's behalf is not an
agreement.

`Advertiser.activatedAt` is set when gates 3 and 4 are both clear, matching
`Publisher.activatedAt`.

## Two agreements

Symmetrical with the publisher's platform + per-attempt structure.

**Advertiser platform agreement** — `AgreementKind.ADVERTISER_PLATFORM`. One
per account, click-accepted once the profile is in (QR-16: before the KYC
too — activation still waits for both). The terms under which ADX sells
inventory: what is being bought, what ADX warrants about a site, what happens
when a site lapses mid-campaign, how goodwill credit works, and what the
advertiser may not advertise.

**Insertion order** — `AgreementKind.INSERTION_ORDER`. One per campaign, not
per site. A campaign covering 40 hoardings produces one IO enumerating all 40
with their flight dates and total value, rendered into `renderedDocument` at
acceptance so the enumeration survives later edits to the campaign.

The IO carries a **substitution clause**, which is the demand-side mirror of
the supply-side conditional publication clause. If a site lapses mid-flight —
the publisher misses re-verification and the enforcement ladder runs — the IO
provides for substitution onto a comparable site plus goodwill credit, rather
than the campaign being void. This is what makes the lapse ladder survivable:
the advertiser has already agreed to the remedy at the point they agreed to the
campaign.

`AgreementAcceptance` is extended rather than duplicated. `publisherId` becomes
nullable and `advertiserId` and `campaignId` are added, each with its own
unique constraint. Postgres treats NULLs as distinct, so one constraint governs
publisher acceptances and the other advertiser acceptances without either
weakening the other. One table remains the single answer to "who accepted what,
and when".

## Agencies and brands

An agency holds one KYC'd account carrying `Brand` rows.

- Campaigns, creatives and brand-safety decisions belong to a **brand**.
- The wallet, invoices, KYC and the platform agreement belong to the
  **account**.
- A direct advertiser is the degenerate case: one account, one brand, created
  automatically from the company name at gate 2.

This mirrors Partner Publisher on the supply side — a commercial designation
distinct from legal entity form. An agency is an `AGENCY` for KYC purposes and
carries brands; it is not a separate kind of account.

## Restricted sectors

Alcohol, tobacco, gambling, pharmaceutical, political and several other sectors
are restricted in Indian OOH, variably by state and by media type.

The **brand** carries its sector. The **category rules** already modelled at
`/pricing/categories` decide what that sector may do per media type and
location — blocked outright, or permitted subject to legal approval.

The consequence is that one brand-level fact governs every campaign that brand
ever runs, rather than the question being re-asked per campaign (where a
self-serve advertiser has every incentive to understate it) or discovered per
creative at moderation (after the booking and the print spend). Creative
moderation still runs; it is the second line, not the first.

## Money

**Debit point: held at booking, debited at campaign start.**

1. Campaign confirmed → `WalletHold` placed for the campaign value. The balance
   is still the advertiser's, but it cannot be spent twice.
2. Campaign starts → hold converts to a `WalletEntry` debit.
3. Cancelled before start → hold released. No refund path, no reconciliation.

This is the same shape as `EarningsHold` on the publisher side, and for the
same reason: a release is cheap and a refund is not.

**Goodwill credit.** When a publisher's verification lapses mid-campaign, the
forfeited daily earning arrives here. It is spendable on bookings, is **not
withdrawable**, and where several advertisers are affected it is split in the
ratio of what each paid — not evenly. It exists to keep an inconvenienced
advertiser booking, so it has no value outside a booking.

**One wallet model, every party.** The wallet is not advertiser-specific. It
carries nullable keys for advertiser, publisher and agent with exactly one set,
enforced by a CHECK constraint, and the agent ledger that used to live in
`Transaction` was absorbed into it. The polymorphic `partyType` + `partyId`
shape was considered and rejected: Prisma cannot express a polymorphic
relation, so it would cost the foreign key, and a row holding a balance with no
owner is the one orphan a money table must not permit.

The two sides of the ledger exit differently, and the distinction matters:

- A **publisher, agent or partner** wallet holds money ADX owes for work done.
  Its exit is a **withdrawal** to a verified bank account, requested by them.
- An **advertiser** wallet holds credit for future bookings. That is its
  purpose, not a side effect: money in it is meant to be spent on ADX. There is
  no advertiser-initiated withdrawal, and no self-serve refund button.

### Refunds

A refund is a **support-mediated, admin-approved exception**, never a
self-service action.

1. The advertiser or their team **asks support** for a refund.
2. Support checks eligibility and **raises a refund request** against the
   wallet. Raising it places a `WalletHold` for the amount, so money that has
   been asked back cannot be spent on a booking while the request is open.
3. An **admin approves or rejects**. Approval captures the hold into a `REFUND`
   entry and reverses to the original payment instrument. Rejection releases
   the hold and the credit stays spendable.

**The approver may not be the raiser.** There is no distinct support role on
the API yet — support staff and approvers are both `ADMIN` — so four-eyes is
enforced on the *user* rather than the role: the service refuses a decision
from whoever raised the request. That is weaker than a capability check and
should be replaced by one, but it does stop one person moving money out on
their own say-so.

### When an advertiser is eligible

Not an exhaustive rule, deliberately. Support judges, an admin ratifies, and
the reason is recorded on the request:

| Reason | Case |
| --- | --- |
| `NO_SUITABLE_ALTERNATIVE` | ADX could not offer a replacement the advertiser found acceptable |
| `PUBLISHER_WITHDREW` | The publisher stopped providing the site mid-campaign |
| `ADVERTISER_LEAVING` | Leaving ADX entirely, with unspent top-up left over |
| `OTHER` | Support judged it warranted; the note carries the case |

`OTHER` exists because the list will not stay complete. A taxonomy that forces
support to mislabel a real case is worse than one that admits its own limits —
the note is required in every case, so nothing is unexplained either way.

Three rules that hold regardless of eligibility:

- **Refund to source only.** Funds leave the way they arrived. This is what
  keeps the wallet closed-loop rather than a cash-out instrument, and it is the
  reason the advertiser side has no bank-account payout path at all.
- **Never goodwill, never held.** Goodwill is issued to keep an inconvenienced
  advertiser booking; it has no value outside a booking and cannot become cash.
  The separate `goodwill` column is what makes this enforceable rather than a
  convention.
- **Capped at top-ups minus spend.** Nobody can take out more than they put in,
  which closes the route from an adjustment or a goodwill credit to cash.

### Credit expires after 12 months

Credit left unused for twelve months lapses, taking both settled balance and
goodwill, and writes an `EXPIRY` entry so the statement explains where it went.

The clock runs from the **last movement on the wallet**, not from the age of
each individual credit: any top-up or spend resets it for the whole balance.
That reading is simpler to state in an agreement, cheaper to sweep — one
indexed `lastActivityAt` column rather than a per-credit ageing queue — and it
does not punish an active advertiser for an old deposit. If the intent was
per-credit ageing instead, this is the decision to revisit.

The sweep is idempotent and batched, one transaction per wallet, so a run that
fails partway leaves the wallets it already settled alone.

All of the above is stated in the advertiser platform agreement, so the posture
is one the advertiser accepted rather than one discovered at the point they ask.
Expiry in particular cannot be applied retrospectively — it has to be in
version 1 of the agreement, because credit already held was granted under
whatever terms were in force when it arrived.

**Credit terms are deliberately deferred.** `Advertiser.creditLimit` exists and
is null for everyone. Prepay is the only funded state today; the column is
there so that granting terms later is a value change rather than a migration.

## Inventory visibility

Before a site is booked, an unverified or unfunded advertiser sees the
locality, photographs, size, category, illumination and price — enough to
decide. They do not see the exact address or GPS coordinates.

Exact location is released on booking. The supply map is the asset the platform
is built on, and a phone number is not a sufficient price for it.

## What an advertiser identifier looks like

`ADV-1909-2601` — an advertiser who joined 19 September 2026, first that day.
Issued at account creation, from the same allocator as `PUB-`, and never
reissued. The format is already configurable at `/settings/identifiers`; this
is the first party besides publishers to actually consume it.

## Still open

Recorded so they are not mistaken for settled:

- **Wallet top-up minimum.** None enforced. Configurable when a number exists.
- **Invoice timing.** Currently assumed to be raised at campaign start, so it
  coincides with the debit. GST treatment of a hold is not a question this
  document is competent to answer.
- **Credit limits.** Who may grant them, and whether that needs its own
  capability in the roles model.
- **Agent commission on advertiser spend.** `Advertiser.agentId` records who
  brought the account, mirroring `Publisher.agentId`, but nothing pays out on
  it yet. That is B5.
- **How approximate is approximate.** Locality plus a jittered pin is the
  working assumption; the radius is a product decision, not a technical one.
- **Self-serve spend ceiling.** Whether an unassisted advertiser can book
  arbitrarily large campaigns, or whether value above some threshold routes to
  an `AGENT_ADVERTISER`.
- **A distinct support role.** Refund raising and approval are both `ADMIN`
  today, with separation enforced by refusing a self-decision. A real
  capability split belongs in the roles model.
- **Expiry notice.** Nothing warns an advertiser before their credit lapses.
  The supply side gives 15 and 7 days of reminders before a verification
  expires; this should do the same before taking someone's money, and the
  notice period belongs in the agreement.
- **Whether the closed-loop reading holds.** The wallet is credit for future
  bookings, refunds go back to source only, and there is no advertiser payout
  path. That is deliberately the side of the line that avoids stored-value
  treatment — but it is a question for counsel, not for this document.
