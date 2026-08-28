# banking

Payout bank accounts belonging to a user.

## Responsibilities

- List, add, edit and delete a user's own bank accounts.
- Maintain exactly one default account per user.

## Owned routes

All mounted at `/api/v1/banking`, all `authenticate`d, all scoped to the caller.
Note there is no `requireRole` here: any authenticated user manages their own
accounts.

| Method | Path | Status |
| --- | --- | --- |
| GET | `/` | 200 |
| POST | `/` | **201** |
| PATCH | `/:accountId` | 200 |
| DELETE | `/:accountId` | 200 |
| POST | `/:accountId/set-default` | 200 |

## Owned Prisma entities

`BankAccount`.

## Public exports (`index.ts`)

- `bankingRouter`.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/database` (repository
  only).
- No other business module.

## Invariants

- An account belonging to another user is reported **404**, never 403, so the
  endpoint does not confirm an id exists.
- The first account a user adds is automatically the default.
- The default account cannot be deleted — **400** until another is promoted.
- Promoting a default unsets the previous one in the same transaction, so a user
  can never end up with two defaults or none.
- Editing an account resets `isVerified` to false.
- `PATCH` checks ownership **before** validating the body, so an unknown id
  answers 404 even when the body is also invalid. This ordering is inherited
  from the original controller; do not "tidy" it.
- `ifscCode` is upper-cased on both create (during parsing) and update (after
  validation).

## Tests

```bash
npx vitest run src/modules/banking
```

## Suggested ownership

Small; a natural pair with `earnings`, which shares the payouts domain.
