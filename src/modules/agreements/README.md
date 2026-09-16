# agreements

The text each party accepts, versioned, and the record of who accepted which
version and when. This is the module behind DR 10's Agreements screen and the
reason both personas can get past their agreement gate at all: with no live
version of the platform terms, `acceptPlatformAgreement` on either side answers
`NO_ACTIVE_TEMPLATE` and the party sits at activation forever.

## The click: whose route, whose row (Lot D, Q123)

| | `agreements` (here) | `supply` | `advertisers` | `packages` | `orders` |
| --- | --- | --- | --- | --- | --- |
| Writes the text | yes | — | — | — | — |
| Records a publisher's platform / listing click | — | `POST /supply/agreements/accept-platform`, `accept-listing` | — | — | — |
| Records an advertiser's platform click | — | — | `POST /advertisers/:id/agreements/platform` | — | — |
| Records the insertion order | **yes** — `acceptInsertionOrder`, rendered here | — | the route: `POST /advertisers/:id/agreements/insertion-order { campaignId }` | — | — |
| Records the package terms | **yes** — `recordAcceptance` | — | — | the route: `POST /packages/sales/:id/accept-terms` | — |
| Records the agent's job terms | **yes** — `recordAcceptance` | — | — | — | inside `agentAcceptOrder`, on the agent's own tap |
| Reads the record | yes | its own funnel counts | its own gate | its payment gate | — |

The platform clicks stay where activation happens. The **transaction** kinds
are recorded here, through `recordAcceptance`, by the module that owns the
transaction: one row per anchor (campaign, sale, order, attempt) per template
version, idempotent on the version, with the click's IP and user agent and
the document exactly as rendered. Nothing is e-signed (`signatureProvider`
stays NONE); the columns are the seam for Digio later.

The legacy `GET/POST /supply/agreements/templates` and
`/advertisers/agreements/templates` pairs are **retired** (Lot D): they
published-and-activated in one step without stamping `activatedAt`, and the
console has only ever used `/agreements/templates`.

## Kinds

| Kind | Party | Scope | Anchor | Gates |
| --- | --- | --- | --- | --- |
| `PLATFORM` | publisher | platform terms | — | activation (gate 3 of the supply funnel); the listing agreement |
| `LISTING` | publisher | per attempt | `attemptId` | publishing the listings in that attempt |
| `ADVERTISER_PLATFORM` | advertiser | platform terms | — | activation (gate 4 of the demand funnel); `assertCanBook` |
| `INSERTION_ORDER` | advertiser | per campaign | `campaignId` | `checkout.authorizeCampaign` — 403 `AGREEMENT_REQUIRED` until accepted on the live version |
| `PACKAGE_SALE` | advertiser | per sale | `packageSaleId` | `/packages/sales/:id/pay` and `record-payment` — same code |
| `JOB_TERMS` | agent | per order | `orderId` | the agent's tap on Accept records it in the same call; no live version refuses the tap with `NO_ACTIVE_TEMPLATE` |

`KIND_META`, `PLATFORM_KIND_FOR` and `ANCHOR_FOR` are exported for anything
that needs the mapping rather than restating it. An agent has no platform
terms: their party view carries `platform: null`.

## Re-acceptance (Lot D, Q55)

A platform-scope version may be activated with `requiresReacceptance`. Until
then any acceptance of the kind clears the gate; with it, only the live
version or later does. The rule is `isCurrentAcceptance(acceptance,
template)` — pure, exported, and applied by `advertisers.bookingEligibility`
/ `acceptInsertionOrder` and by `supply.acceptListingAgreement`, never
restated. A party's next platform click writes a new row for the new version
(the older row stays; it was agreed). `GET /agreements/stale?kind=` lists who
is behind the live version and says whether that is `enforced`. Transaction
kinds never need it: each transaction is bound by the version live at that
moment, which is what `transactionAcceptance(...).current` reports.

## The insertion order (Lot D, Q123)

`renderInsertionOrder(body, snapshot)` fills `{{spots}}` (or appends a
"Sites covered by this insertion order" section) with the campaign's
reference, advertiser, flight and every non-cancelled spot at its rate, days,
quantity and line total. `acceptInsertionOrder(campaignId, advertiserId,
ctx)` reads the campaign narrowly here (this module sits under `campaigns`),
refuses 403 when the campaign is not that advertiser's, and records the row.
The text a client sends is never recorded.

## Owned routes

All under `/api/v1/agreements`.

| Method | Path | Guard | Notes |
| --- | --- | --- | --- |
| GET | `/current/:kind` | `authenticate` | the live text of any of the six kinds; 404 `NO_ACTIVE_TEMPLATE` when nothing is published |
| GET | `/templates?kind=` | ADMIN | every version, with acceptance counts and `state` |
| POST | `/templates` | ADMIN | a new version, numbered after the highest; a draft unless `activate: true`; `requiresReacceptance` on the platform kinds (**201**) |
| GET | `/templates/:id` | ADMIN | |
| PATCH | `/templates/:id` | ADMIN | drafts only; 409 otherwise |
| DELETE | `/templates/:id` | ADMIN | drafts only; **204** |
| POST | `/templates/:id/activate` `{ requiresReacceptance? }` | ADMIN | makes it live, retires the previous; idempotent. E7-3: the optional body sets the re-acceptance switch in the same transaction as the activation — platform kinds only, 400 otherwise; on an already-live version only the switch moves |
| GET | `/acceptances?publisherId=&advertiserId=&agentId=&templateId=&kind=&campaignId=&orderId=&packageSaleId=&attemptId=` | ADMIN | paged, newest first; E7-3: the four transaction anchors filter too, and `agentId` now applies to the list as it always did to the count |
| GET | `/stale?kind=PLATFORM\|ADVERTISER_PLATFORM` | ADMIN | parties whose highest accepted version is below the live one; `enforced` says whether the live version blocks them |
| GET | `/parties?q=` | ADMIN | publishers and advertisers by displayId, name or mobile |
| GET | `/parties/:partyType/:partyId` | ADMIN | what one party accepted (`publisher`, `advertiser`, `agent`), and where they stand on the platform terms |

## Owned Prisma entities

- `AgreementTemplate` — one version of one kind. `isActive`, `activatedAt`,
  `retiredAt`, `createdByUserId`, `changeNote` are this module's; the body is
  Markdown and a `LISTING` body may hold `{{listings}}` for supply to fill.
- `AgreementAcceptance` — the platform kinds written by supply and
  advertisers; the transaction kinds written here through `recordAcceptance`.
  Exactly one of `publisherId` / `advertiserId` / `agentId`; the anchor
  column the kind names; the migration's partial indexes make each (party or
  anchor, template) pair unique.

`Publisher`, `Advertiser` and `AgentProfile` are read for the party lookup and
never written; `Campaign` and its spots are read for the insertion order.

## Invariants

- **A version is one of three things.** `ACTIVE` (`isActive`), `SUPERSEDED`
  (was live: `activatedAt`, `retiredAt`, or any acceptance on it), else
  `DRAFT`. Only a draft may be edited or discarded. A version that has been
  live is what people accepted, and an acceptance points at the row rather than
  a copy of it, so its text is frozen.
- **Version numbers only go up.** The next version is the highest that exists
  plus one, drafts and retired versions included, so a number never means two
  different texts. A concurrent create loses with a 409, not a 500.
- **Never two live, never none by accident.** Activation retires the previous
  live version and promotes the new one in a single transaction. Activating a
  retired version is the rollback: it goes live again, restamped, and the one
  it replaces is retired.
- **Activation does not touch acceptances.** Nobody's row is rewritten when
  a new version goes live. Whether they must click again is the live
  version's `requiresReacceptance` (Lot D, Q55), read through
  `isCurrentAcceptance`; without it the gates accept *any* acceptance of the
  kind, and the party view and the stale report show `outdated` for ops.
- **A transaction accepts the version live at that moment.** One row per
  anchor per version; a retry returns the row; a version change since the
  click makes `transactionAcceptance(...).current` false and the gate asks
  again. The rendered document is what was shown, never what was sent.
- **`effectiveFrom` is when it went live**, not when somebody started drafting
  it. Activation moves it.

## Dependencies

`shared/*` only — this module imports no other, which is what lets
`advertisers`, `supply`, `campaigns`, `packages` and `orders` all import it.
The console reads the rest over HTTP, and the apps read `/current/:kind` for
the agreement-text screens.

Exports that leave the module:

- `countAcceptancesFor({ publisherId, advertiserId })` — `account-lifecycle`,
  Lot A's closure review (Q21). Reported, never blocking: an acceptance is
  never withdrawn, because the text *was* agreed.
- `recordAcceptance`, `transactionAcceptance`, `platformStanding`,
  `isCurrentAcceptance`, `currentTemplate`, `acceptInsertionOrder`,
  `renderInsertionOrder`, `staleParties`, `ANCHOR_FOR` — Lot D (Q123/Q55), for
  the modules named in the table at the top.

## E6: the placeholder drafts

A fresh database has no template of any kind, so every gate answers 503
`NO_ACTIVE_TEMPLATE` and nothing tells ops where to type. `ensureAgreementDrafts()`
— called at boot beside `ensureSystemRoles` — seeds version 1 of each of
PLATFORM, ADVERTISER_PLATFORM, INSERTION_ORDER, PACKAGE_SALE and JOB_TERMS as a
DRAFT whose body opens with `[PLACEHOLDER - ADX legal text to be supplied
before publishing]` and names the variable the kind renders (`{{spots}}`,
`{{sale}}`). A DRAFT satisfies no gate, so behaviour is unchanged until ops
edit and publish it at `/agreements/templates`; a kind with any row — draft,
live or superseded — is never touched. LISTING is not seeded: the supply desk
publishes it with its own enumeration.
