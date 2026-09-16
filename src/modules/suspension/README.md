# suspension

Modular suspension for listings, publishers, advertisers and agents, and the
wallet freeze — Lot A (Q40/Q48/Q52), 12 September 2026.

ADX suspends *sections* of a party rather than the party. A listing can stop
taking bookings while the orders already on it run to the end; a publisher's
wallet can be frozen while their spots keep earning; an agent can be taken off
new work without losing the job they are half-way through. Five scopes say
which section, one vocabulary covers all four parties, and every step and every
reversal is a row with a reason and a name against it.

## What it owns

`PartySuspensionEvent` outright, and the five suspension columns wherever they
appear — on `Listing`, `Publisher`, `Advertiser` and `AgentProfile`
(`suspensionScopes`, `suspendedAt`, `suspensionReason`, `suspendedById`, plus
the party's own status where BLOCK_NEW moves it).

That is a deliberate exception to "a module owns its own tables": one act with
one record beats four modules each with their own idea of what suspended means.
Every other module **reads** those columns where its work needs the answer —
the booking gate, the dispatch sweep, the accrual run, the wallet debit — and
none of them writes one.

`Wallet.frozenAt` is the exception to the exception: it is written through the
`wallets` module's `freezeWallet` / `unfreezeWallet`, because that module owns
the money.

## Routes

```
POST /listings/:id/suspend              ADMIN — scopes[] + reason (3..500) → current scopes + what the suspension did
POST /listings/:id/reinstate            ADMIN — scopes[] (omit to lift everything) + reason
POST /publishers/:id/suspend            ADMIN — same body; BLOCK_NEW and STOP_ACCRUAL cascade onto every listing
POST /publishers/:id/reinstate          ADMIN — lifts the cascade with it
POST /advertisers/:id/suspend           ADMIN — BLOCK_NEW refuses checkout and package purchase
POST /advertisers/:id/reinstate         ADMIN
POST /agents/:id/suspend                ADMIN — BLOCK_NEW sets AgentProfile.status SUSPENDED
POST /agents/:id/reinstate              ADMIN — restores ACTIVE, or ON_LEAVE if that is what they were
GET  /suspension/:partyType/:partyId    ADMIN — current scopes, what the party admits, and the event history
```

The router is mounted at the API root, **ahead of** `/orders`, `/publishers`,
`/listings` and `/agents`, because those routers would otherwise take the
request and answer 404 from inside their own tree. See
`bootstrap/register-modules.ts`.

`authenticate` and `requireRole('ADMIN')` sit on each route rather than on the
router. A router mounted at the root sees every request under `/api/v1`, and an
authentication layer on it would answer 401 for every unknown path on the whole
API instead of letting it fall through to the 404 handler —
`tests/contract/auth-topology.test.ts` pins exactly that.

## Which scopes a party admits

| | BLOCK_NEW | STOP_OPEN_WORK | STOP_ACCRUAL | FREEZE_WALLET | BLOCK_SIGNIN |
| --- | --- | --- | --- | --- | --- |
| Listing | ✓ | ✓ | ✓ | | |
| Publisher | ✓ | ✓ | ✓ | ✓ | ✓ |
| Advertiser | ✓ | ✓ | | ✓ | ✓ |
| Agent | ✓ | ✓ | | ✓ | ✓ |

A listing has no wallet and cannot sign in. An advertiser earns nothing, so
STOP_ACCRUAL would be a scope that did nothing. A scope outside the party's row
is a 400 naming both what was rejected and what is allowed.

## What each scope does, and who honours it

| Scope | Party | Consequence | Enforced in |
| --- | --- | --- | --- |
| BLOCK_NEW | listing | `status` → SUSPENDED, so the marketplace and the matcher skip it | `listings`, `campaigns.candidateListings` |
| BLOCK_NEW | publisher | cascades onto every listing, one event per listing marked as a cascade | this module |
| BLOCK_NEW | advertiser | `assertCanBook` refuses 409 `ADVERTISER_SUSPENDED` — checkout, and package pay / record-payment | `advertisers.service` |
| BLOCK_NEW | agent | `status` → SUSPENDED; no offer, visit, milestone or lead reaches them | `agents.agentAcceptsWork`, read by `orders/assignment`, `visits`, `order-milestones`, `leads` |
| STOP_OPEN_WORK | listing / publisher | every non-terminal order on the spot(s) cancelled through the ordinary cancel; ONE refund request per affected campaign | `orders.cancelOrder`, `campaigns.cancelSpotsForOrders`, `advertisers.requestRefund` |
| STOP_OPEN_WORK | advertiser | SCHEDULED and LIVE campaigns cancelled through `cancelCampaign`; the unused days raised as a refund request | `campaigns.cancelAdvertiserCampaigns` |
| STOP_OPEN_WORK | agent | unanswered offers handed back and re-offered, open visits cancelled, dispatched milestones returned to ADX | `orders.releaseAgentOffers`, `visits.cancelAgentVisits`, `order-milestones.releaseAgentMilestones` |
| STOP_ACCRUAL | listing | the daily accrual skips the spot | `payouts.findAccruableSpots` + a re-check in `accrual.service` |
| STOP_ACCRUAL | publisher | cascaded onto every listing, so the accrual has one place to look | this module |
| FREEZE_WALLET | publisher / advertiser / agent | `Wallet.frozenAt` set; debits refused 409 `WALLET_FROZEN`, credits still land | `wallets.move`, `payouts.requestWithdrawal` / `approveWithdrawal`, `advertisers.holdForCampaign` / `payForPackage` |
| BLOCK_SIGNIN | publisher / advertiser / agent | `User.isActive` → false, refresh tokens revoked and the revocation marker written, so access tokens already in flight stop too | this module, via `auth.revokeSessions` |

## Invariants

- **Nothing here moves money.** What a suspension costs an advertiser goes to
  the refund desk as a request, which a second admin decides. A suspension can
  never quietly credit or debit a wallet.
- **One refund request per campaign**, for unused days × rate × quantity summed
  over the spots that stopped — today counts as unused, because a spot that
  comes down this morning did not run today. A request the desk refuses (one is
  already open, or the cap is lower than the loss) is recorded on the
  suspension as a note rather than swallowed; the suspension itself still
  stands, because the work stopped whether or not the money moved.
- **Suspend adds, reinstate subtracts.** Suspending a scope already present is
  a no-op on the list, and the case keeps the date and reason it started with.
  Reinstating with no scopes lifts everything; with scopes, only those.
- **The three columns move as a set.** Each table's CHECK ties `suspendedAt`
  and `suspensionReason` to a non-empty `suspensionScopes`, so the repository
  writes all four together and clears all four together.
- **Reinstatement never lies.** Lifting STOP_OPEN_WORK does not un-cancel an
  order or un-cancel a campaign — that work stopped, and the record says so.
  Only BLOCK_NEW, FREEZE_WALLET and BLOCK_SIGNIN have reversals at all.
- **A listing comes back ACTIVE only if it can.** On lifting BLOCK_NEW, the
  spot returns to ACTIVE when it was published and its verification has not
  lapsed; otherwise it stays SUSPENDED and the supply funnel decides. A listing
  whose verification expired while it was suspended must not be let back onto
  the marketplace by a reinstatement that was only ever about the booking block.
- **An agent who was ON_LEAVE comes back ON_LEAVE.** The prior status is
  recorded in the audit row's metadata at suspension and read back from the
  trail at reinstatement — `PartySuspensionEvent` has no metadata column, and
  putting an agent who is away back on the rota would be a real dispatch bug.
- **Every call writes two records**: the `PartySuspensionEvent` row, and an
  audit row (`<PARTY>_SUSPENDED` / `_REINSTATED`) carrying `targetType`,
  `targetId` and a diff of `suspensionScopes`.
- **The party is told.** A SYSTEM notification goes to the party's user when
  there is one; a notice that fails to deliver never fails the suspension.

## Dependencies

`advertisers` (requestRefund), `auth` (revokeSessions), `campaigns`
(cancelSpotsForOrders, cancelAdvertiserCampaigns), `notifications`, `orders`
(cancelOrder, findOpenOrdersForListings, releaseAgentOffers),
`order-milestones` (releaseAgentMilestones), `visits` (cancelAgentVisits),
`wallets` (freezeWallet, unfreezeWallet), `shared/audit`.

Nothing imports this module, which is what keeps the graph acyclic: the gates
read their own columns rather than calling back here.

## Tests

`__tests__/suspension.service.test.ts` — the shape of the act: admitted scopes,
add-and-lift, the event and audit rows, the notification, the CHECK columns.
`__tests__/scope-consequences.test.ts` — what each scope actually does, the
cascade, the refunds, and the two asymmetric restores.

## E6

`GET /suspension/:partyType/:partyId` events carry `byUser { id, name }`,
joined through `users.findUserLabels` in one query for the whole history
(`name` null for an actor the platform no longer has).

## E10-1

The same read carries `suspendedBy { id, name } | null` beside
`suspendedById` on the current case — the same lookup as the history, one
query; null while nobody has suspended the party.
