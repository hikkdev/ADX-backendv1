# employees

HR records for internal staff: department, designation, active flag, and the
document set collected during employment onboarding.

Unrelated to `agents` (field workers with an `AgentProfile`) and to `users`
(identity and roles). An employee record hangs off a `User`, one per user.

## Owned routes

Mounted at `/api/v1/employees`, all `authenticate`d.

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/` | ADMIN | **201** |
| GET | `/` | ADMIN | 200, paginated |
| GET | `/:userId` | `selfOrAdmin` | 200 |
| PUT | `/:userId` | `selfOrAdmin` | 200 |
| DELETE | `/:userId` | ADMIN | 200 |

`selfOrAdmin` (`employees.policy.ts`) lets a user read and edit **their own**
record while ADMIN can reach anyone's. It answers 403, not 404, on a mismatch —
unlike the ownership checks in `banking` and `advertisements`.

## Owned Prisma entities

`Employee`.

## Public exports (`index.ts`)

- `employeeRouter`.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/database` (repository
  only).
- `users` — `userExists`, checked before creating an HR record.

## Invariants

- One employee record per user: a second create answers **409 CONFLICT**.
- Creating against an unknown user answers **404**.
- `PUT` validates the body **before** checking the record exists, so a malformed
  body against an unknown id answers **400**, not 404.
- List and single-record responses join a fixed slice of the user
  (`id, name, mobile, email`); widening it changes the API.
- The list response puts `meta` as a **sibling** of `data`, not nested.
- Document fields are URLs, not uploads: clients POST the file to `/upload`
  first and send the returned URL here.

## Tests

```bash
npx vitest run src/modules/employees
```

## Suggested ownership

Platform/admin team, alongside `access-control`.
