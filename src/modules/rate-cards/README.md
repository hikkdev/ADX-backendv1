# rate-cards

ADX's approved position on what a kind of spot is worth, and the gate DR 10 puts
in front of publishing.

## Not the pricing engine, on purpose

`pricing` is a **suggester**: it reports what the market within 200 m is doing
and never blocks anything. Its README says so in the first line, and that has to
stay true. This module is **governance**: a number a person signed off, and a
rule about what may go live against it.

They meet in exactly one place — the simulator, which traces a quote from either
base through the same pricing factors. That is what makes a card rate and a
market rate comparable rather than two opinions nobody reconciles.

| | `pricing` | `rate-cards` |
| --- | --- | --- |
| Question | What is the market doing near here? | What has ADX agreed is sellable? |
| Source | Listings and research within 200 m | A person's decision |
| Blocks anything | Never | Publishing, below the floor |

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/rate-cards/gate/:listingId` | ADMIN, PUBLISHER, AGENT_PUBLISHER — the verdict plus `belowFloor` (Lot E); E11-1: beside it `floorRatePerDay` (the floor of the card in force, null where no card reaches), `shortfall` (floor minus rate, a day, whenever the rate is under the floor — BELOW_FLOOR, AWAITING_APPROVAL and APPROVED_BELOW_FLOOR alike; null otherwise) and `case: { id, status, source, graceUntil, heldByRunningOrder } \| null` — the live PriceApproval on the listing (PENDING or APPROVED, CARD_REVISION or PUBLISH_REQUEST), looked up on its own so a CARD_REVISION case still open after the rate was raised is still named. The same shape for every caller; `AWAITING_APPROVAL` and `APPROVED_BELOW_FLOOR` verdicts now also carry `cardId`, `cardRate`, `floor`, `rate`. E11 verify: `assertMayAskGate` before the read — 403 unless the caller is ADMIN, the listing's publisher, the agent who onboarded them (`Publisher.agentId`) or an agent under a live LISTINGS grant reaching the listing; 404 for an unknown listing, 403 for one no publisher has claimed |
| POST | `/rate-cards/approvals` | ADMIN, PUBLISHER, AGENT_PUBLISHER — E11 verify: the same `assertMayAskGate` check as the gate read, so nobody opens a price case on another publisher's listing |
| GET/POST | `/rate-cards` | ADMIN |
| POST | `/rate-cards/quote` | ADMIN |
| GET | `/rate-cards/approvals` | ADMIN — E10-2: `?status=`, `?source=PUBLISH_REQUEST\|CARD_REVISION`, `?listingId=`; with `?page=` or `?pageSize=` (≤ 100) the list contract `{ items, total, page, pageSize, counts }` (counts by status with the status facet removed), otherwise the bare array it always answered, one release |
| PATCH | `/rate-cards/approvals/:id` | ADMIN |
| GET/PATCH | `/rate-cards/:id` | ADMIN (`graceDays` patchable on a draft — Lot E) |
| GET | `/rate-cards/:id/impact` | ADMIN — Lot E (Q97): the ACTIVE listings this card leaves under its floor, with the shortfall and any live case; readable on a draft |
| POST | `/rate-cards/:id/impact/dry-run` | ADMIN — E10-2: `{ entries: [{ mediaTypeId, grade, ratePerDay }], floorPct?, graceDays? }` — the same shape as `GET /:id/impact` measured against the draft grid (and floor and grace, where given) instead of the stored cells; the card's identity, city and status stay the stored card's; nothing persisted, no case raised |
| PUT | `/rate-cards/:id/entries` | ADMIN |
| POST | `/rate-cards/:id/{submit,approve,reject,archive,revise}` | ADMIN |

A publisher may ask why their listing will not go live and may ask for a price
to be signed off. Everything else is ADX deciding what a spot is worth.

## Owned Prisma entities

- `RateCard` — a versioned, effective-dated grid with a floor and a rounding
  step. Approved by a person, whose id is on the row.
- `RateCardEntry` — one cell: media type x grade -> rate **per day**. Null means
  "not sold at this grade", which is not the same as free.
- `PriceApproval` — a listing priced under the floor, and the decision about it.
  Lot E: `source` says who asked — `PUBLISH_REQUEST` (the publisher, or the
  pricing engine's binding factor above its cap) or `CARD_REVISION` (a
  revised card moved the floor over a live listing) — and `graceUntil` is
  the CARD_REVISION case's clock.

## The gate

`assertPublishable` runs on `publishListing`. It passes when:

- **No card covers the listing.** This is every listing until ops build a card,
  and it is the most important case in the module. Refusing here would punish a
  publisher for an ADX omission, and the failure would look like a bug in
  publishing rather than a missing card.
- **The rate is at or above the floor.** Inclusive — exactly 82% is at the
  floor, not under it.
- **Somebody approved it anyway.** `APPROVED` lets it through; `PENDING` does
  not, because asked-for is not granted.

Who may ask (E11 verify): the gate view names the floor ADX set, the rate the
publisher asked for and the case standing between them — that publisher's
business. `assertMayAskGate(listingId, { userId, isAdmin })` guards the gate
read and the approval request with the line `listings` draws for an edit: ADX,
the publisher, the agent who onboarded them, or an agent under a live LISTINGS
grant. It reads the owner through this module's own repository
(`findListingOwner`) and the agent and grant through `agents` and
`access-grants`, never through `listings`, which depends on this module.

## Lot E (Q97): a revised card and the listings already live under it

The gate ran only at publish, so a listing priced fine under v3 could sit
under v4's floor for ever. Now:

- **`approveCard`** still supersedes the overlapping ACTIVE cards and goes
  ACTIVE first; then it measures its impact and raises **one `CARD_REVISION`
  PriceApproval per affected ACTIVE listing** that has no live case — the
  card, its rate and its floor frozen on the row, `graceUntil = now +
  graceDays` (14 by default, per card), the publisher told "Raise the rate or
  ask ADX to keep it", and one audit row `RATE_CARD_IMPACT_RAISED` on the
  card naming every listing. The response carries `impact: { affected,
  raised, listingIds }`.
- **`GET /rate-cards/:id/impact`** answers the same question for any card,
  measured against *this* card's grid rather than the effective-card lookup,
  so ops can read a draft's consequences before approving it. On an ACTIVE
  card only listings this card actually governs count — a national card does
  not reach a spot in a city with its own card.
- **`decideApproval` REJECTED on a CARD_REVISION case** is the act the case
  warned about: the listing is unpublished through `listings.unpublishListing`
  (the port bootstrap registers; audited `LISTING_UNPUBLISHED` there). Three
  things stop it. The grace still running → **409 `GRACE_PERIOD_RUNNING`**;
  the publisher was told a date and the platform keeps it. An order still
  running on the listing (anything short of COMPLETED / CANCELLED /
  rejected) → the case **stays PENDING** with `heldByRunningOrder: true` —
  E7-2 (Lot E addendum 2): the column `PriceApproval.heldByRunningOrder`,
  written by `holdApproval` and cleared by any decision; the note is prose
  and nothing is derived from it. Rows held before the column carry the old
  `HELD_BY_RUNNING_ORDER` note prefix, still read for one release. Audited
  `PRICE_APPROVAL_HELD`; ops decide again once the order completes. The publisher already raised the
  rate above the frozen floor → nothing to unpublish, the case just closes.
- APPROVED keeps the price whatever raised the case. A rejected
  `PUBLISH_REQUEST` is a decision on paper — the listing was never live under
  it. Every decision is audited `PRICE_APPROVAL_DECIDED`.
- **`raisePriceCase`** (exported) is what pricing's binding factor calls above
  its cap: a `PUBLISH_REQUEST` case carrying the rate the factor wanted,
  frozen against the card in force when there is one, or the PENDING case
  already standing.
- **`belowFloorFlags(listingIds)`** stamps `GET /listings` rows — and, E11-1,
  `GET /publishers/me/listings` and the agent's `GET /publishers/:id/listings`:
  true when the rate sits under the floor of the card in force, whatever case
  stands on it. `isBelowFloor(verdict)` is the same reading of one verdict.
- **`gateView(listingId)`** (E11-1) is what the gate route answers: the
  verdict, `belowFloor`, `floorRatePerDay`, `shortfall` and the live `case`.
- **`floorFor(mediaTypeId, cityId)`** (Lot U) is the floor for a kind of
  spot before a listing exists — the same card lookup as the gate at the
  default grade, null where no card reaches — for the listing importer's
  per-row warning. It warns; the gate still refuses.

## Invariants

- Per day, everywhere. The old rate-card screens quoted per week while the
  platform settled on a daily rate for listings, comparables and the indicator;
  one card in a second unit is how a card rate and a listing rate get compared
  wrongly.
- An ACTIVE card is never edited. `revise` copies it into the next version and
  approving that supersedes the old one, because a listing published against a
  card was published against those numbers and that has to stay answerable.
- Approving supersedes overlapping ACTIVE cards in the same operation. Two
  active cards over one city is a state the lookup cannot resolve honestly.
- City-scoped beats national. A national card is a floor of coverage; a city
  card is a considered local number.
