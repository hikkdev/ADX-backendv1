# kyc

Identity verification records that stand on their own, and the admin review
workflow they share.

```
kyc/
  kyc.schema.ts     review decision + pagination shared by both subfeatures
  advertiser/       AdvertiserKyc — documents, by entity type
  user/             UserKyc — a single self-recorded video
```

## Why these two are together

Both are a submitted record plus an admin PENDING/VERIFIED/REJECTED decision
with an optional rejection reason, and the review endpoint is identical. One
owner for both review flows is the point of the module.

## What is deliberately NOT here

**Publisher KYC.** `PublisherKyc` is part of the publisher onboarding aggregate,
its routes hang off `/publishers/:publisherId/kyc`, and it is driven by the
Digio integration. It belongs to the `publishers` module.

## Owned routes

`/api/v1/advertiser-kyc`, all `authenticate`d:

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/` | any | **201** |
| GET | `/me` | any | 200 |
| PUT | `/me` | any | 200 |
| GET | `/` | ADMIN | 200, paginated |
| GET | `/:id` | ADMIN | 200 |
| PUT | `/:id` | ADMIN | 200 |
| PATCH | `/:id/review` | ADMIN | 200 |
| DELETE | `/:id` | ADMIN | 200 |

`/api/v1/user-kyc`, all `authenticate`d:

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/` | any | **201 or 200** |
| GET | `/me` | any | 200 |
| DELETE | `/me` | any | 200 |
| GET | `/` | ADMIN | 200, paginated |
| GET | `/:id` | ADMIN | 200 |
| PATCH | `/:id/review` | ADMIN | 200 |
| DELETE | `/:id` | ADMIN | 200 |

`/me` is registered ahead of `/:id` in both routers. Do not reorder.

## Owned Prisma entities

`AdvertiserKyc`, `UserKyc`.

## Public exports (`index.ts`)

- `advertiserKycRouter`, `userKycRouter`.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/database` (repositories only).
- No other business module.

## Invariants — the two differ, deliberately

| | advertiser | user |
| --- | --- | --- |
| Second submission | **409 CONFLICT** | upsert: replaces, answers **200** |
| First submission | 201 | 201 |
| Resubmit path | `PUT /me` | `POST /` again |
| Submit for someone else | not supported | ADMIN-only via `userId`, else **403** |

Shared:

- Review sets `reviewedAt` and clears `rejectionReason` to `null` when absent.
- Owner resubmission resets status to `PENDING` and clears the rejection reason;
  the **admin** `PUT /:id` edit does **not** touch status.
- `status` is case-insensitive (`upperEnum`); advertiser `kycType` is **not** —
  it uses a plain `z.enum` and is case-sensitive. Inherited; do not "fix".
- On the advertiser listing an unparseable `status` filter is **ignored**, and
  the listing returns unfiltered. It is not a 400.
- Join slices differ and are part of the contract: the advertiser listing joins
  `id, name, mobile, email`; the user listing and user by-id join
  `id, name, mobile`; `advertiser-kyc GET /:id` and `user-kyc GET /me` join
  nothing.
- Both listings put `meta` as a **sibling** of `data`.

## Tests

```bash
npx vitest run src/modules/kyc
```

## Suggested ownership

One owner for both review flows — that is why they share a module.
