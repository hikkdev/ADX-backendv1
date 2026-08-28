# access-control

The admin-defined catalogue of named roles and their permission lists.

## Scope, and what it is not

`RoleConfig` is **data the admin UI edits**. It is not what guards routes.
Route guarding uses the fixed `Role` enum from the Prisma schema, enforced by
`requireRole()` in `shared/auth`. Nothing enforces `RoleConfig.permissions` at
runtime today — the rows exist so the admin UI can render and manage them.

Granting a `Role` to a user is `POST /api/v1/users/roles` and belongs to the
`users` module, not here.

## Owned routes

Mounted at `/api/v1/roles-config`, all `authenticate`d.

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/` | ADMIN | **201** |
| GET | `/` | any authenticated | 200 |
| GET | `/:id` | any authenticated | 200 |
| PUT | `/:id` | ADMIN | 200 |
| DELETE | `/:id` | ADMIN | 200 |

Reads are deliberately open to any authenticated user so the admin UI can render
role pickers.

## Owned Prisma entities

`RoleConfig`.

## Public exports (`index.ts`)

- `rolesConfigRouter`.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/database` (repository
  only).
- No other business module.

## Invariants

- `name` is unique; a duplicate answers **409 CONFLICT**, not a second row.
- `PUT` validates the body **before** checking the row exists, so a malformed
  body against an unknown id answers **400**, not 404. This is the opposite
  ordering to `banking` and `advertisements` — both are inherited from the
  original controllers and both are pinned by the READMEs on purpose.

## Tests

```bash
npx vitest run src/modules/access-control
```

## Suggested ownership

Platform/admin team, alongside `employees`.
