# wallets

The wallet primitives every party shares — open one, read it, move money.
No routes: every party reaches its wallet through its own module
(`/payouts/wallet`, `/advertisers/:id/wallet`, `/finance/wallets`).

## The four owners (Lot B)

One table, one row per party, and the CHECK on it says exactly one of the
owner columns is set:

| `WalletOwner.kind` | Column | Who |
| --- | --- | --- |
| `PUBLISHER` | `publisherId` | paid daily accruals |
| `AGENT` | `agentId` | paid verified incentives |
| `ADVERTISER` | `advertiserId` | tops up, spends on bookings |
| `PRINT_PARTNER` | `printPartnerId` | Lot B (Q50/B4b): paid approved job costs — a payee whose account cannot sign in |

`ensureWallet(owner, label)` opens the wallet **and** its ledger account
together; `findWalletFor(owner)` reads it; `listWallets({ kind })` is the
console's list, with the owner joined for every kind.

## `move()` — the one door

Wallet, statement line (`WalletEntry`) and the double-entry legs commit in a
single transaction, or not at all, keyed on an idempotency key the caller
derives from what caused the movement. Everything the movement has to check is
read **inside** that transaction — the freeze (`frozenAt`), the funds
(`requireFunds`), the hold (`captureHoldId`) — because a check outside it is a
check something else can invalidate between the read and the write.

Credits always land, frozen or not; only money leaving is stopped
(`allowFrozen` is the closure's final payout, and nothing else).

**One movement at a time per wallet (Lot J2, g).** The transaction takes a
Postgres advisory lock keyed on the wallet id — `SELECT
pg_advisory_xact_lock(hashtext(<walletId>))`, released with the commit —
**before** it reads the row, so two debits arriving together are
serialised: the second reads the balance the first left, and
`requireFunds` refuses it. Under READ COMMITTED alone both would read the
same balance and both would pass. Different wallets never wait on each
other.

## What the snapshot derives

`snapshot(walletId)` computes rather than stores: `balance`, `goodwill`,
`held` (open holds), `openWithdrawals` (REQUESTED + APPROVED — Lot B Q140,
approval reserves and release debits), `pendingClearance` (accruals inside the
clearing window), `spendable` and `withdrawable`, both floored at zero.

## Invariants

- Every ledger movement goes through `move()` with an idempotency key; the
  ledger is append-only — reversals, never updates.
- Money is a decimal string end to end (`shared/money`).
- `Wallet.frozenAt` is written only through `freezeWallet` / `unfreezeWallet`,
  which `suspension` calls.
- Prisma only in `prisma-wallets.repository.ts`.
