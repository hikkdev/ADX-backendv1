# listings

Advertising inventory a publisher offers: location, size, price, photos and
availability.

## Owned routes

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/api/v1/listings` | ADMIN |
| POST | `/api/v1/listings` | AGENT_PUBLISHER \| ADMIN (**201**) |
| PATCH | `/api/v1/listings/:listingId` | AGENT_PUBLISHER \| ADMIN |
| POST | `/api/v1/listings/:listingId/publish` | AGENT_PUBLISHER \| ADMIN |
| GET | `/api/v1/listings/:id/similar` | **none** |

### The `/similar` route is load-bearing

`GET /listings/:id/similar` is **unauthenticated** and is registered on the API
router *directly*, before `listingRouter` is mounted. `listingRouter` calls
`use(authenticate)`, so if `/similar` were moved inside it, or registered after
it, the route would start returning 401 and the public discovery flow would
break. `bootstrap/register-modules` keeps the order; the route-inventory test
asserts it.

`GET /publishers/:publisherId/listings` is owned by `publishers`, which calls
this module's `getListingsForPublisher`.

## Owned Prisma entities

`Listing`, `ListingPhoto`.

## Public exports (`index.ts`)

- `listingRouter`.
- `similarListingsHandler` — mounted separately, see above.
- `getListingsForPublisher(publisherId)` — used by `publishers`.

## Dependencies

- `agents` — `requireAgentProfile` when resolving the owning agent on create.
- `shared/http`, `shared/auth`, `shared/errors`, `shared/validation`,
  `shared/database` (repository only).

## Invariants

- **Publishing is a state transition, not a patch.** `status` is deliberately
  absent from the update schema; only `POST /:listingId/publish` changes it, and
  only from `DRAFT` or `PENDING_REVIEW`, stamping `publishedAt`. Anything else
  is **400**.
- `PATCH` performs no existence check — an unknown id surfaces as Prisma's own
  error, as it did before. Adding a 404 would change the response.
- Passing `agentId` on create is ADMIN-only (**403** otherwise); an unknown
  agent is **404**. Everyone else gets their own agent profile.
- The admin listing joins `publisher`, `agent` and `photos`; the per-publisher
  listing joins only `photos`. Both shapes are contract.
- "Similar" means: same category, same city, `status: ACTIVE`, price within
  ±30%, cheapest first, at most 5, excluding the listing itself.

## Tests

```bash
npx vitest run src/modules/listings
```

## Suggested ownership

Supply-side team, alongside `publishers`.
