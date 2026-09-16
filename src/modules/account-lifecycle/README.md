# account-lifecycle

Closing an account (Lot A, Q21) and erasing the person behind it (Q60).

## What is NOT here

**Suspension.** `suspension` owns stopping work, freezing a wallet and
blocking sign-in. A closure *calls* it — with four scopes and a reason — rather
than reimplementing any of it. Two modules with two ideas of what "stopped"
means is how a suspended account keeps taking bookings.

**Deletion.** `users` owns `DELETE /users/:id` and refuses it with 409
`USER_HAS_HISTORY` for any account that has money, work, inventory, a signed
agreement or a KYC record behind it. That refusal names this module. Delete
stays for an account that is a mistake rather than a record.

## Why a module and not `users/closure/`

A closure review asks eleven questions of nine other modules — wallets,
payouts, orders, campaigns, listings, visits, order-milestones, agreements,
support — and the act adds `suspension` and `auth`. `users` is imported **by**
six modules (`support`, `employees`, `orders`, `safety`, `supply`, `disputes`),
so giving it those dependencies closes a cycle the first time any of them needs
a closure. Here every arrow points outward and nothing points back.

## Owned routes

Mounted at `/api/v1/users`, **ahead of** `userRouter` — see
`bootstrap/register-modules.ts`. `GET /users/closure-cases` and
`GET /users/erasure` would otherwise be matched by that router's `GET /:id` and
answered as "no such user". The guards are per route rather than
`router.use(authenticate)`, because a router mounted on `/users` sees every
request under it and would turn the deliberately public
`POST /users/bootstrap-admin` into a 401.

| Method | Path | Guard |
| --- | --- | --- |
| POST | `/me/closure-request` | `authenticate` (**201** when the case was opened, 200 when one was already pending) |
| POST | `/me/erasure` | `authenticate` (**201** / 200) — `requestedVia` is `APP` |
| POST | `/me/data-export` | `authenticate` (G6, Q104) — **201** with the new PENDING request; **409** `CONFLICT` (`details.code: DATA_EXPORT_OPEN`, `details.request` the open one) while a request is PENDING, or READY and not yet expired. Audited `DATA_EXPORT_REQUESTED`. |
| GET | `/me/data-export` | `authenticate` — the latest request, any status: `{ id, status, requestedAt, readyAt, expiresAt, fileId, deepLink, error }` — `fileId` (open it through `GET /files/:id`, owner only) and `deepLink` (`adx://account/data-export/:id`) only while READY, `error` only when FAILED; `null` when there has never been one. |
| GET | `/closure-cases` | ADMIN — list contract: `decision`, `q`, `page`, `pageSize` |
| POST | `/closure-cases/:id/decide` | ADMIN — `{ decision: CLOSED \| REFUSED, lossNote? }` |
| GET | `/erasure` | ADMIN — list contract: `status`, `q`, `page`, `pageSize` |
| POST | `/erasure/:id/approve` | ADMIN + `requirePermission('dpo.erasure')` — `{ dpoName }` |
| POST | `/erasure/:id/refuse` | ADMIN — `{ reason }` |
| POST | `/erasure/:id/execute` | ADMIN — only an APPROVED request |
| GET | `/:id/closure-review` | ADMIN — the blockers, with counts and a summary |
| POST | `/:id/closure-cases` | ADMIN (**201** / 200) — `{ reason, ticketId? }` |
| POST | `/:id/erasure` | ADMIN (**201** / 200) — `{ reason?, requestedVia }` |

`me/*`, `closure-cases` and `erasure` are registered **before** the `/:id`
routes, or the id parameter reads them as user ids.

## The data export (G6, Q104)

A person asks for a copy of what ADX holds about them and gets a zip a few
minutes later. `jobs/data-export.job.ts` ticks every minute under a Redis
lock and builds every PENDING `DataExportRequest`, oldest first, through
`buildDataExport`: `data-export/prisma-data-export.repository.ts` assembles
the records — profile, roles, the party records, KYC status and per-document
decisions (**no images or videos**: every `*Url`, `bankStatement`,
`digioPayload` and `fileId` column is dropped), listings, orders on both
sides, campaigns, each wallet with its ledger entries, withdrawals, invoice
metadata (figures, not PDFs), notifications, sessions (no token hashes),
activity and preferences; no password hash, no OTP state, no other person's
contact details. `adx-data-export.json` and a `README.txt` naming every
section go into one zip (`shared/zip` — a hand-written container over
`node:zlib`'s DEFLATE, because the build has no zip library), stored PRIVATE
as `DATA_EXPORT` **owned by the person**, the row marked READY with
`expiresAt` seven days out, audited `DATA_EXPORT_READY`, and the person
told through `notify('DATA_EXPORT_READY')` — email and push, with the deep
link — beside an in-app SYSTEM row. A build that throws marks the row
FAILED with the reason and the person may ask again.

The daily retention sweep (`ops`) calls `purgeExpiredDataExports`: a READY
row past `expiresAt` loses its file (`uploads.purgeStoredFile`) and becomes
EXPIRED; EXPIRED and FAILED rows older than ninety days are deleted. It is
the one thing the sweep destroys, and it is a copy the person already has.

## Owned Prisma entities

`AccountClosureCase`, `ErasureRequest`, `MobileTombstone`, and (G6)
`DataExportRequest`.

**And columns on tables other modules keep**: `User.closedAt / closeReason /
closedById`, and the PII columns an erasure blanks on `User`, `Publisher`,
`Advertiser`, `AgentProfile`, `PublisherKyc`, `AdvertiserKyc`, `UserKyc` and
`AgentKyc`. That is the `suspension` arrangement — one act, one writer — and it
is deliberate: an erasure has to be atomic across eight tables or it leaves a
half-erased person behind, which is the one outcome a DPO-signed request must
never produce. `docs/backend-modules.md` allows exactly this for
`users.deleteUserCascade`, for the same reason.

## Public exports (`index.ts`)

- `accountLifecycleRouter`.
- `closureReview(userId)` — the blockers, for the console and for `users`.
- `closeAccount(userId, reason, adminId, lossNote?)` — the act.
- `wasMobileErased(mobile)` — supplies auth's `MobileTombstonePort`.
- `erasuresDue(now)`, `erasuresPastRetention(now)` — Lot E: the PENDING
  requests past their thirty days and the DONE ones past `retainUntil`, read
  by `ops`' daily retention sweep. Reads only; the sweep tells the admins and
  writes a report, and nothing destroys a financial row on a timer.
- `financialYearEnd`, `retainUntilFor`, `hashMobile`, `DEFAULT_RETENTION_YEARS`.
- G6 (Q104): `processPendingDataExports(limit, now)` — the job's tick;
  `buildDataExport(id, now)` — one request; `purgeExpiredDataExports(now)` —
  the sweep's; `DATA_EXPORT_TTL_DAYS` (7).

## Dependencies

`suspension`, `auth` (`revokeSessions`), `wallets`, `payouts`, `orders`,
`campaigns`, `listings`, `visits`, `order-milestones`, `agreements`, `support`,
`notifications`, `app-config` (`getPlatformSettings`), G6: `uploads`
(`storeGeneratedFile`, `purgeStoredFile`) and `shared/zip`, and `shared/{audit,
errors, http, auth, money, pagination, validation, logging}`.

`auth` is the one inverted edge: this module imports `revokeSessions` from it,
so `auth` declares a `MobileTombstonePort` and
`bootstrap/register-modules.ts` fills it with `wasMobileErased`. Unregistered
it answers "no", which costs only the activity row beside a new account.

## Invariants

### Closure

- **Three things refuse a closure**, and nothing else does: a withdrawal in
  flight (`REQUESTED` / `APPROVED` / `PROCESSING`), a non-terminal order on
  either side, and a `SCHEDULED` or `LIVE` campaign. Each is ADX's money or
  ADX's promise, and cancelling one is a decision with a refund attached rather
  than something a close button does silently. 409 `CLOSURE_BLOCKED`, with
  `details.blockers` naming each and its count.

- **Open agent work never blocks.** The closure hands offers, visits and
  milestones back through the suspension's `STOP_OPEN_WORK`, so refusing on
  them would be refusing on something the very next step undoes. It is
  reported, because the desk should see it.

- **Agreements and open tickets never block either.** An acceptance is history
  and a ticket is correspondence; neither is money.

- **The review is re-run at the decision.** The case records what was true when
  it was raised — balance, payouts in flight, open orders, open work — and
  those four numbers are a snapshot, not a gate. Deciding a week-old case reads
  the world again.

- **The close runs before the case is marked decided.** A blocked closure
  leaves the case PENDING for somebody to work rather than recording CLOSED
  over an account that is still running.

- **One pending case per account.** Asking twice returns the pending one.

- **A closure never deletes anything.** Listings go `INACTIVE`, and orders,
  accruals and ledger legs still point at them.

- **The four closure scopes** are `BLOCK_NEW`, `STOP_OPEN_WORK`,
  `FREEZE_WALLET`, `BLOCK_SIGNIN`, filtered against what each party admits.
  `STOP_ACCRUAL` is deliberately not one: the closure stops new work and the
  money, not the earning on spots that are still coming down.

- **Sessions are revoked after the suspension.** `BLOCK_SIGNIN` takes the
  refresh tokens; `revokeSessions` takes the access tokens, which outlive the
  `isActive` flag by up to their whole lifetime otherwise.

- **The final payout is a request, not a payment.** A `REQUESTED`
  `WithdrawalRequest` to the default VERIFIED payout method, which a person
  still vets — DR 04's rule that nothing is auto-approved does not bend for a
  closure. No verified method means the balance stays frozen and the response
  and the case's `lossNote` say so. A `lossNote` on the decision suppresses the
  payout entirely: ADX has written the money off.

- **The person's own request raises the ordinary ACCOUNT support ticket**
  through `support.raiseAccountTicket`, and the id is linked onto the case, so
  ops works one queue. A ticket that cannot be raised does not lose the request.

### Erasure

- **Four gates, in order**: somebody asks, the account is CLOSED, a DPO
  approves, an admin executes. Approving an open account is 409
  `ERASURE_NOT_ALLOWED` — blanking the name on a running account would leave
  live orders and a publisher dealing with a ghost.

- **Approval and execution are separate people-acts.** The execution is
  irreversible and must not be a side effect of a signature.

- **`dpo.erasure` is its own permission group**, so a role holding every
  `settings` permission still does not hold this one.

- **What is kept**: `Wallet`, `Ledger`, `WithdrawalRequest`,
  `AgreementAcceptance` and `ActivityLog` rows, plus each KYC record's
  `digioRequestId`, `digioReferenceId`, `digioStatus`, `digioVerifiedAt` and the
  last four of its PAN. That is the minimum that lets a payout or a signed
  agreement be traced to a row which no longer names a person. `digioPayload`
  is **not** kept: the stored webhook body is the whole identity document as
  Digio read it, and keeping it would undo the erasure the four identifiers
  beside it are there to survive.

- **`retainUntil` is whole financial years.** The end of the Indian FY (31
  March, IST) containing the completion, plus
  `getPlatformSettings().retention.financialYears`. Written that way because
  the obligation is written that way — "eight years from the end of the
  relevant financial year", not eight years from a Tuesday in September. An
  unreadable settings row falls back to eight, the longer window and the only
  safe direction to be wrong in.

- **The number becomes `erased:<sha256 prefix>`.** `User.mobile`,
  `Publisher.mobile` and `Advertiser.mobile` are NOT NULL and unique, so the
  replacement is derived from the number itself and is therefore unique exactly
  where the number was.

- **The city goes as a pair.** Lot X-B stamped `cityId` beside the typed
  `city` on `Publisher`, `Advertiser` and `AgentProfile`; erasure nulls both
  together, so an anonymised profile neither names a place nor keeps pointing
  at one through the catalogue key (which the keyed city counts would
  otherwise still count). Pinned by
  `__tests__/erasure-city-key.repository.test.ts`.

- **The tombstone is a hash and never refuses anything.** An erased person may
  register again; all `MobileTombstone` decides is whether the new account
  carries a `REREGISTERED_AFTER_ERASURE` activity row, which is what support
  needs when that person rings about history they can no longer see.

## Audit

| Action | Target | Written by |
| --- | --- | --- |
| `ACCOUNT_CLOSED` | `User` | `closeAccount` |
| `ERASURE_APPROVED` | `ErasureRequest` | `approveErasure` |
| `ERASURE_REFUSED` | `ErasureRequest` | `refuseErasure` |
| `ACCOUNT_ERASED` | `User` | `executeErasure` |
| `REREGISTERED_AFTER_ERASURE` | `User` | `auth`'s OTP send |

## Tests

```bash
npx vitest run src/modules/account-lifecycle
```

## Suggested ownership

Senior, shared with `users` and `auth`. Every change here is either a money
decision or a data-protection one.

## E6

`GET /users/:id/erasure` (ADMIN) answers the request standing against the
account — PENDING or APPROVED — or `null`, so the account page shows the open
clock before it offers the button that would start one.
