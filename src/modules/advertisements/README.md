# advertisements

Creative assets an advertiser registers on the platform. Booking a creative onto
a listing is `orders`; verifying an advertiser's identity is `kyc`.

## Responsibilities

- CRUD over an advertiser's own advertisements.
- Let admins manage advertisements on behalf of an advertiser.

## Owned routes

All mounted at `/api/v1/advertisements`, all `authenticate`d. There is
deliberately **no `requireRole`**: admins and advertisers share the same
endpoints and visibility is decided per row.

| Method | Path | Status |
| --- | --- | --- |
| POST | `/` | **201** |
| GET | `/` | 200, paginated |
| GET | `/:id` | 200 |
| PUT | `/:id` | 200 |
| DELETE | `/:id` | 200 |

## Owned Prisma entities

`Advertisement`.

## Public exports (`index.ts`)

- `advertisementRouter`.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/database` (repository only).
- No other business module.

## Invariants

- Non-admins see and touch only rows where `advertiserId` is their own user id.
  An `advertiserId` query filter is **ignored** for them, not honoured.
- An advertisement that exists but belongs to another advertiser is reported
  **404**, never 403.
- Passing `advertiserId` on create is admin-only and answers **403** otherwise —
  distinct from the 404 used for reads, and validated after the body schema.
- `PUT` checks access **before** validating the body, so an unreachable id
  answers 404 even when the body is invalid.
- The list response puts `meta` as a **sibling** of `data`, not nested inside
  it: `{ success, data: [...], meta: { page, pageSize, total, totalPages } }`.
- `page` floors at 1; `pageSize` is clamped to 1..100 and defaults to 20.
- At most 5 `photoUrls`.

## Tests

```bash
npx vitest run src/modules/advertisements
```

## Suggested ownership

Pairs with `kyc` (advertiser onboarding) under an advertiser-side owner.
