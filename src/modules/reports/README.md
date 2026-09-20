# reports

Reports — Lot G (Q129/Q143), 14 September 2026.

Twelve reports defined in code, rendered on demand as CSV or PDF into a
private file, listed as runs, and scheduled daily / weekly / monthly at
06:00 IST with a time-limited link mailed to each recipient.

```
reports/
  catalogue.ts                the twelve kinds: name, description, filters, columns, query
  windows.ts                  presets and custom windows (Indian days); the cadence windows; nextRunAt
  render.ts                   CSV (shared/csv) and PDF (pdfkit, landscape A4, a table per page)
  links.ts                    the signed, time-limited file link a schedule mails
  reports.repository.ts       ReportsRepository (runs, schedules) and ReportData (the twelve reads)
  prisma-reports.repository.ts
  reports.service.ts          run now, list, open the file; schedules CRUD; the job's tick
  reports.schema.ts / .controller.ts / .routes.ts
```

## What it owns

`ReportRun` and `ReportSchedule`. The file behind a run is an `UploadedFile`
with purpose `REPORT` (private, folder `reports/`), stored through
`uploads.storeGeneratedFile` under the requester — or the system account for
a schedule — and read back through `uploads.openStoredFile` on a route that
has already decided who may read it.

The twelve reads (`ReportData`) walk the other modules' tables read-only —
campaigns, package sales, accruals, withdrawals, refunds, incentives, the
four KYC tables, listings, tickets, disputes, fraud cases, deliveries, the
daily campaign metrics, the ledger's revenue account — the way
`admin-overview` reads the ledger. Nothing here writes another module's row.

## The catalogue

| kind | rows | filters |
| --- | --- | --- |
| `bookings-gmv` | one per campaign or package paid in the window | advertiserId, agentId, kind |
| `publisher-earnings-payouts` | one per publisher with accruals in the window, payouts paid beside | publisherId, city |
| `advertiser-spend-refunds` | one per advertiser with bookings paid in the window, refunds beside | advertiserId, industry |
| `agent-commissions` | one per `AgentIncentive` recorded in the window | agentId, status, event |
| `onboarding-funnel` | one per party type: created, KYC submitted / verified / rejected, activated | city |
| `supply-listings` | one per listing created in the window | status, city, category |
| `kyc-ageing` | one per KYC record still PENDING at the window's end, oldest first | type |
| `support-sla` | one per ticket opened in the window, against its two deadlines | priority, status, team |
| `disputes-fraud` | disputes raised and fraud cases opened in the window, merged oldest first | type, status |
| `comms-deliveries` | deliveries queued in the window, counted per template × channel × outcome | channel, templateKey |
| `campaign-performance` | one per campaign with daily metrics in the window | advertiserId, campaignId |
| `platform-summary` | one line per headline number | — |

A filter a kind does not declare is a 400, never silently ignored. Money is
printed as a two-place string; instants as ISO. The window is Indian days,
inclusive (`from`/`to` as `YYYY-MM-DD`, at most 366 days) or a preset —
`today`, `yesterday`, `last7`, `last30`, `lastMonth`, `monthToDate`.

## Routes

All under `/reports`, ADMIN at the router except where noted.

```
GET    /reports/catalogue                 the twelve, with filters and columns (no query function on the wire);
                                          G11-2: `filterLabels: { [field]: label }` per kind, for printing a stored filter by its label
POST   /reports/run                       { kind, format: CSV|PDF, filters, window } → 201 the run (READY: fileId, rowCount, expiresAt);
                                          500 REPORT_FAILED { runId, error } when the query or the render threw — the run row says why
GET    /reports/runs                      list contract: ?q=&status=RUNNING,READY,FAILED&sort=newest|oldest&kind=&scheduleId=&page=&pageSize=
                                          G11-2: every row carries `mailedTo` (count) and `mailedAt` when the schedule mailed it, null for a run
                                          by hand or one that failed; `filters` is the declared filters only.
                                          G13-B: `summary { readyThisWeek, mailedThisWeek, uniqueRecipients }` beside the page — READY runs started
                                          this Indian week (Monday 00:00 IST), runs mailed this week by their `mailedAt`, and the distinct addresses
                                          across the enabled schedules' recipient sets (an empty set counting as every admin with an email)
GET    /reports/runs/:id                  one run, the same shape
GET    /reports/runs/:id/file             the bytes as an attachment. Guard: a valid `?t=` signed link (the schedule's mail)
                                          OR an ADMIN bearer token. 409 REPORT_NOT_READY, 404 FAILED/unknown, 410 REPORT_EXPIRED past 30 days
GET    /reports/schedules                 list contract: ?q=&status=ENABLED,DISABLED&sort=&kind=
POST   /reports/schedules                 { kind, name, cadence: DAILY|WEEKLY|MONTHLY, format, recipients[], filters, enabled } → 201, nextRunAt set.
                                          G13-B: `filters.window: { from, to }` (optional) is a fixed date range — a custom window, at most 366 days —
                                          the job renders instead of the cadence's own; it is kept beside the declared filters (never one the kind
                                          validates) and `filters: { window: null }` on a PATCH drops it
GET    /reports/schedules/:id
PATCH  /reports/schedules/:id             any subset; a cadence change or a re-enable recomputes nextRunAt
DELETE /reports/schedules/:id
```

Audit rows: `REPORT_RUN` (target `ReportRun`), `REPORT_SCHEDULE_CREATED` /
`_UPDATED` / `_DELETED` (target `ReportSchedule`, `auditDiff` over name,
kind, cadence, format, recipients, filters, enabled, nextRunAt), and
`REPORT_SCHEDULE_RUN` written by the job as the system account.

## Schedules and the job

`jobs/report-schedule.job.ts` ticks every five minutes under a Redis lock
and calls `runDueSchedules(now)`: every enabled schedule with `nextRunAt` at
or before now is rendered for its cadence's window — DAILY yesterday, WEEKLY
the seven days before today, MONTHLY the previous calendar month — and each
recipient is mailed through `notify('REPORT_READY', null, vars, { recipient
})` with `url` = `/api/v1/reports/runs/:id/file?t=<expiry>.<hmac>`, signed
on `JWT_ACCESS_SECRET` and dead at the run's `expiresAt`. Empty
`recipients` means every live ADMIN account with an email, resolved when the
schedule fires. `lastRunAt` and `nextRunAt` (the next 06:00 IST the cadence
names: tomorrow, next Monday, the 1st) move on whether or not the run
succeeded — a failing report fails once a period, not once a tick — and a
failed run is not mailed.

## Invariants

- **The catalogue is the contract.** `GET /reports/catalogue` and the
  validation of every run and schedule read the same `catalogue.ts`.
- **Private, then signed.** The file is never public; the only way to it
  without an admin token is the link the schedule mailed, for that run, until
  its expiry.
- **A schedule never loops.** `nextRunAt` advances before the outcome is
  known to the caller.
- **No secret in a row.** The run row carries the kind, the filters, the
  file id and a clipped error message; the link's HMAC is never stored.
- **The mailing is on the run** (G11-2). When the tick mails a READY run,
  `recordMailed(runId, { to, at })` writes how many addresses took the mail
  and when. `ReportRun` has no columns for it yet (schema need: `mailedTo
  Int?`, `mailedAt DateTime?`), so until they land the record sits under
  the reserved `$mailed` key of the run's `filters` JSON — `MAILED_KEY` in
  the repository seam — and `runView` splits it back out on every read, so
  the wire shows `mailedTo` / `mailedAt` beside clean `filters` and never a
  `$mailed` filter. When the columns arrive, only the repository and
  `runView` move.

## Dependencies

`uploads` (store and open the file), `notifications` (`notify`), `users`
(`systemUserId`, `listAdminUserIds`); `shared/audit`, `shared/csv`,
`shared/money`, `shared/time`, `shared/pagination`, `config/env`; `pdfkit`.
Nothing imports this module but `bootstrap` and the job.

## Tests

`__tests__/catalogue.test.ts` — the twelve, their columns against their
rows, the filter contract, CSV and PDF rendering. `__tests__/windows.test.ts`
— presets, cadence windows, `nextRunAtFor` at the 06:00 IST boundaries.
`__tests__/reports.routes.test.ts` — the routes through supertest, the
signed link, expiry, schedules CRUD with audits, and `runDueSchedules`.

## Suggested ownership

Platform — with `admin-overview`, which reads the same tables for the
console's numbers.

## The onboarding board (QR-14, 17 Sep 2026)

A thirteenth kind, `onboarding-board`, and one on-screen read, `GET
/reports/boards/onboarding?preset=|from=&to=[&via=&role=]` (ADMIN): who
onboarded whom in the window, one row per person on the ADX side (admins by
their console role, agents, anyone who committed an import), with the doors
they used and how far each party got — completed, a listing live within
seven days of onboarding, KYC verified, a first booking (a first paid
campaign or package for an advertiser). Ranked by onboarded, ties by how far
they got; self-signups sit apart as "organic", unranked. The rows come from
`prismaReportData.onboardingBoard`, the same for the CSV and the screen.
The agent leaderboard (commission) is untouched.
