# audit

The console's window onto the trail — Lot A (Q28), 12 September 2026.

Not to be confused with `shared/audit`, which *writes* the trail: `logActivity`
(the hand-written rows every module already makes), `auditDiff` (the
`{ field: { before, after } }` helper for the money and status models), and
`auditAdminWrites` (the net under the hand-written rows — every successful
ADMIN write nobody logged gets a generic row). This module only reads.

## What it owns

Nothing in the schema. `ActivityLog` belongs to `shared/audit`; this module is
the three admin reads over it.

## Routes

```
GET /audit                                       ADMIN — list contract: q, action, module, targetType, targetId, userId, from, to, sort (newest|oldest), page, pageSize → { items, total, page, pageSize, counts by module }; actor (id, name, email) joined
GET /audit/export.csv                            ADMIN — same filter and sort, streamed as text/csv, capped at 50,000 rows; itself logged as AUDIT_EXPORTED
GET /audit/targets/:targetType/:targetId         ADMIN — the timeline for one record (same page shape)
```

## Invariants

- **Admin-only at the router.** `authenticate` and `requireRole('ADMIN')` sit on
  the router, not per route: there is no audit read for any other role.
- **The export is audited before it streams.** The `AUDIT_EXPORTED` row carries
  the filter and the cap, and is written before the first byte, so a download
  that failed half-way is still on record as an attempt.
- **Capped, streamed.** 50,000 rows, fetched a thousand at a time and written
  as they arrive. Nobody holds the trail in memory to export it.
- **`counts` is by module, with the module facet removed** — the chip row stays
  a way back out. Rows written before Lot A have no module and are counted
  under `(none)`.
- **Values never leak through here that were not already in the row.**
  Secrets are masked at write time by `auditDiff` and the generic tap records
  body *keys* only; the reads add nothing.

## Dependencies

`shared/audit` (findActivity, findActivityRows, logActivity), `shared/auth`,
`shared/pagination` (page size constants). No module imports.

## Tests

`__tests__/audit.service.test.ts` — the three routes through supertest with
`shared/audit` mocked, the batch walker's cap, and the CSV quoting.
`tests/contract/admin-write-audit.test.ts` pins the generic tap's coverage of
every ADMIN write route.
