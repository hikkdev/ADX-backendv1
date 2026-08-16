# adx-backend-v1 — with legacy features ported

This is the v1 TypeScript/Express/Prisma/PostgreSQL backend with every feature
from the old JavaScript/Express/Mongoose backend now present. Stack is unchanged
from v1 (TypeScript, PostgreSQL via Prisma) — nothing was moved back to MongoDB;
v1 was already on Postgres, which is what carried forward here.

## What was ported in (this session's additions, on top of stock v1)

| Old backend module | New v1 module | Notes |
|---|---|---|
| `employee.*` | `Employee` model + `src/{controllers,routes}/employee.ts` | Full CRUD. Legacy per-document upload endpoints (~15 of them) replaced by URL fields populated via v1's existing generic `POST /upload`. |
| `rolesConfig.*` | `RoleConfig` model + `src/{controllers,routes}/rolesConfig.ts` | Additive — stores custom role/permission definitions. Route-level access control still runs on v1's fixed `Role` enum via `requireRole()`; this does not yet gate routes itself. |
| `advertiserKyc.*` | `AdvertiserKyc` model + `src/{controllers,routes}/advertiserKyc.ts` | Individual/Commercial/NGO/Agency document fields, self-service submit + admin review flow. |
| `adSpaceKyc.*` | Merged into existing `PublisherKyc` model | Extended with `businessRegCertUrl`, `directorIdUrl`, `businessAddressProofUrl`, `adAuthLetterUrl`, `ngoRegCertUrl`, `ngoAddressProofUrl`, `ngoTaxExemptionCertUrl`, `ngoOperationalOverviewUrl` — additive, nullable, existing KYC flow unchanged. |
| `advertisement.*` | `Advertisement` model + `src/{controllers,routes}/advertisement.ts` | Reusable ad-creative library per advertiser (the old app's advertisements were reusable across ad-space bookings; v1's `Order.designUrl` was a one-off per order). Added optional `Order.advertisementId` so an order can now reference a saved `Advertisement`. |
| `userSelfKyc.*` | `UserKyc` model + `src/{controllers,routes}/userKyc.ts` | Generic user self-video KYC, self-service + admin review. |
| (n/a — new) | `Agent` listing + `src/{controllers,routes}/agent.ts` | `GET /agents`, `GET /agents/:id` — admin-only. Didn't exist in either backend; added because the Flow Editor's "assign agent" picker needs it and no equivalent existed anywhere. |

All of the above are wired into `src/routes/index.ts`.

## Database

Everything above is expressed as Prisma models against PostgreSQL — see
`prisma/schema.prisma` for the full schema and `prisma/migrations/` for the
migration history, including:
- `20260705120000_add_legacy_modules` — Employee, RoleConfig, AdvertiserKyc,
  Advertisement, UserKyc tables + `Order.advertisementId`.
- `20260705121500_extend_publisher_kyc` — the 8 extra `PublisherKyc` columns.

No MongoDB anywhere in this codebase — v1 was Postgres-native from the start;
the "missing features" were only missing as *application code*, not as a
database technology gap.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT secrets, etc.
npx prisma generate
npx prisma migrate deploy   # or `migrate dev` in a fresh dev database
npm run dev
```

## Verified in this session

- Full `tsc --noEmit` across the entire `src/` tree passes with zero errors
  (checked with a temporarily-restored `node_modules` and a freshly generated
  Prisma client locally — this sandbox has no network access to run
  `prisma generate`/install packages itself, so do that first thing after
  unzipping).
- One pre-existing, unrelated bug fixed while verifying: `order.ts` referenced
  an `'INVALID_QR'` error code that wasn't declared in `ApiErrorCode` — added it
  to `src/lib/errors.ts`.

## This session: admin-override support for the admin panel's create/edit flows

No schema changes -- these are new request-body fields and route handlers only,
added so the admin panel (see the companion `adx-admin-ui` deliverable) can
manage records on behalf of other users, which none of these endpoints
supported before:

| Endpoint | What changed |
|---|---|
| `POST /advertisements` | Accepts optional `advertiserId` (ADMIN-only) to create on behalf of another advertiser instead of always using the caller's own id |
| `POST /listings` | Accepts optional `agentId` (ADMIN-only) to create on behalf of another agent; route now also allows the `ADMIN` role alongside `AGENT_PUBLISHER` |
| `PATCH /listings/:listingId` | Now also allows `ADMIN` alongside `AGENT_PUBLISHER` |
| `PUT /advertiser-kyc/:id` | New -- ADMIN-only update of any advertiser's KYC record by id (previously only `/me` self-service update existed) |
| `POST /user-kyc` | Accepts optional `userId` (ADMIN-only) to submit on behalf of another user |
| `GET /user-kyc/:id` | New -- ADMIN-only lookup of any user's KYC record by id (needed for the admin panel's edit flow, which has no "my" session to fall back on) |
| `DELETE /user-kyc/:id` | New -- ADMIN-only delete of any user's KYC record by id (previously only `/me` self-delete existed) |
| `GET /agents`, `GET /agents/:id` | Added last session -- still present, unchanged |

All additions are backward compatible: existing self-service calls (no
`advertiserId`/`agentId`/`userId` in the body) behave exactly as before.

## This session: nested Publisher KYC directly under the user object (admin panel fix)

Product context: Publisher KYC is agent-mediated (an ADX agent scans a QR
code generated in the publisher's own app to carry out KYC in person — a
dedicated agent app for this is in progress). The admin panel only ever needs
to *see* Publisher KYC status for business visibility, never review/approve
it directly. Investigating a reported "Publisher KYC won't load for admins"
gap confirmed it wasn't a maybe: `GET /publishers` (list) and
`GET /publishers/:id` (single) are both unconditionally agent-scoped — no
`ADMIN` bypass exists on either, by design (an agent should only see
publishers they've personally onboarded).

Rather than adding an admin bypass to those endpoints (which would blur the
agent-ownership model), `publisherProfile`'s Prisma `include` was changed from
a boolean (`publisherProfile: true`) to a nested include
(`publisherProfile: { include: { kyc: true } }`) in three places:

- `getAllUsers` (`GET /users`, admin list) — also added the previously-missing
  `updatedAt` field to this response while in there.
- `getMe` / `updateMe` (`GET/PATCH /users/me`)
- `verifyOtpHandler`, `sendOtpEmailHandler`'s companion `verifyOtpEmailHandler`,
  and `loginPasswordHandler` (all three login paths in `auth.ts`)

This means any endpoint that returns a "user" object now also returns that
user's Publisher record (if they have one) with its KYC document fields
inline — no extra request needed, and no dependency on the agent-scoped
`/publishers` endpoints for this purpose. `GET /publishers` and
`GET /publishers/:id` were left exactly as they were; they still correctly
serve their actual purpose (an agent listing/viewing publishers they own).

No schema changes — this is a query-shape change only, safe to deploy without
a migration.



- `RoleConfig` isn't wired into actual permission enforcement yet — it's a data
  store for custom roles, not yet consulted by `requireRole()`.
- No live database was available to actually run the migrations against in this
  sandbox — please run `prisma migrate deploy` against a real Postgres instance
  and sanity-check before deploying.
- `Listing` has no `DELETE` endpoint. The admin panel's Listings page currently
  surfaces this honestly (an explicit "not supported yet" message) rather than
  faking a delete. Add `DELETE /listings/:listingId` (ADMIN-only, presumably)
  if you want that supported.
