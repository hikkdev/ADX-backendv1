# earnings

An agent's transaction ledger and the balances derived from it.

Payout *destinations* are `banking`. This module records only what is owed and
what has moved.

## Owned routes

Mounted at `/api/v1/earnings`.

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/balance` | `authenticate` + AGENT_PUBLISHER \| AGENT_ADVERTISER \| ADMIN |
| GET | `/transactions` | same |

The role guard is applied router-wide, not per route.

## Owned Prisma entities

`Transaction`.

## Public exports (`index.ts`)

- `earningsRouter`.
- `createTransaction(data)` — for wherever the platform credits or debits an
  agent.

## Dependencies

- `agents` — `requireAgentProfile`.
- `shared/http`, `shared/auth`, `shared/errors`, `shared/database` (repository
  only).

## Invariants

- Both endpoints act on the **caller's own** agent profile. An ADMIN passes the
  role guard but, having no agent profile, gets **404 Agent profile not found**
  rather than 403 or an empty ledger. Inherited behaviour.
- The agent profile is resolved **before** the query is validated, so a caller
  without one answers 404 even when the query string is also malformed.
- The three balance figures are not interchangeable:
  - `totalEarnings` — credits only (`amount > 0`), all time.
  - `currentBalance` — credits **minus** debits, all time.
  - `thisMonthEarnings` — credits only, since the 1st of the current month.
- `currency` is hardcoded `'INR'`. There is no multi-currency support; the field
  exists so clients need not assume.
- The month boundary uses server local time (`new Date(year, month, 1)`), not
  UTC.
- Transactions are returned newest first, `limit` 50 by default.

## Tests

```bash
npx vitest run src/modules/earnings
```

## Suggested ownership

Agent-experience team, alongside `agents` and `banking`.
