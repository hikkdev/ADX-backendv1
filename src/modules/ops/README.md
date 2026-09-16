# ops

Resilience and housekeeping — Lot E (decisions 95 and 126), 12 September 2026.
System health — Lot G (Q130), 14 September 2026: the five-minute samples, the
incident log, the public status page and the region read.

Not to be confused with `app-config` (the settings ops *set*) or
`bootstrap/health.ts` (whether the process can answer at all). This module is
what the on-call admin checks: is there a recent dump, did the last restore
drill pass, what has retention flagged, and is every job still ticking.

```
ops/
  ops.keys.ts               the three AppConfig rows this module keeps
  ops.notify.ts             notifyAdmins — every ADMIN, until there is a rota
  ops.service.ts            the health read
  ops-history.service.ts    the heartbeats, the 5xx series and (Lot G) the per-service sample series
  restore-drill.service.ts  the monthly drill, every step injectable
  retention.service.ts      the daily sweep
  health-sample.service.ts  Lot G: the five-minute probe of the five services, and the thirty-day series
  incidents.service.ts      Lot G: the incident log — open, update, resolve; admins told, subscribers mailed
  status.service.ts         Lot G: the public status read, subscribe / confirm / unsubscribe, the region
  status.links.ts           the confirm and unsubscribe links (root-mounted)
  ops.repository.ts         Lot G: HealthSample, Incident, IncidentUpdate, StatusSubscriber
  prisma-ops.repository.ts
```

## What it owns

Since Lot G: `HealthSample` (one row per service per five minutes, thirty
days kept), `Incident` and `IncidentUpdate`, `StatusSubscriber`. Before it,
nothing in the schema — three `AppConfig` rows, written through
`app-config`'s `saveConfigObject` and never read directly:

| Row | Written by | Holds |
| --- | --- | --- |
| `ops:last-drill` | the restore drill | `{ ranAt, status: PASSED\|FAILED, dump: { name, size }, durationMs, ledger: { unbalanced, drift, healthy }, warnings, error }` |
| `ops:retention-due` | the retention sweep | `{ generatedAt, count, items: [{ erasureId, userId, completedAt, retainUntil }] }` — the erased people whose financial rows have outlived their retention |
| `ops:erasure-due` | the retention sweep | `{ notified: { [erasureId]: at } }` — which past-due erasure requests the admins have already heard about |

## Routes

```
GET /settings/system-health/ops     ADMIN — { targets: { rpoHours: 1, rtoHours: 4 },
                                              backup: { last: { name, takenAt, size } | null, count, ageHours, stale, rotationDays, error? },
                                              drill: <ops:last-drill> | null,
                                              retention: { dueCount, generatedAt, erasureOverdue },
                                              jobs: [{ job, lastTickAt, staleMinutes, stale }],
                                              subscribers: { confirmed, pending } }   G11-2: StatusSubscriber rows, confirmedAt set / null
```

```
GET /settings/system-health/history ADMIN — E6: { generatedAt, jobs: [{ job, lastTickAt, staleMinutes, stale }],
                                                serverErrors: { days: 30, series: [{ day, count }] (oldest first, IST days), total, source: 'redis' } }
```

The 5xx series comes from the hash `shared/errors`' rate alert keeps beside
its per-minute window (`errors:5xx:days`, one field per IST day, pruned past
thirty on read). A day with no field is zero, and days before this build
first served a 5xx read zero too.

Lot G (Q130): `history` also answers, per service, thirty Indian days of the
five-minute samples —
`services: { API|POSTGRES|REDIS|STORAGE|JOBS: { days: [{ date, okPct, p95Ms }] } }`,
`sampleDays: 30` — `okPct` the share of samples that passed, `p95Ms` the
p95 of the sampled latency (`percentile_cont` in Postgres; null for JOBS,
which carries none), a day with no samples reading null rather than being
left out.

```
GET   /settings/system-health/regions              ADMIN — { regions: [{ region: env.APP_REGION, current: true,
                                                            latency: { postgresMs, redisMs, apiP95Ms }, errorRatePct, lastIncidentAt, checkedAt }] }
                                                    one region until there is a second deployment; the round trips are live.
                                                    G13-B: `errorRatePct` is the 5xx share of the requests served over the last 24 h, two places,
                                                    null with nothing served — from the hourly request / 5xx hashes `shared/logging`'s request
                                                    logger keeps (`api:requests:hours`, `api:5xx:hours`; the daily 5xx series has no denominator);
                                                    `lastIncidentAt` is when the newest incident naming any service started, resolved or not
GET   /settings/system-health/incidents            ADMIN — list contract: ?q=&status=OPEN,MONITORING,RESOLVED&sort=newest|oldest&service=
POST  /settings/system-health/incidents            ADMIN — { title, severity: MINOR|MAJOR|CRITICAL, services[], body, startedAt? } → 201,
                                                    the incident with its first update (OPEN, the body)
GET   /settings/system-health/incidents/:id        ADMIN — with its updates, oldest first
POST  /settings/system-health/incidents/:id/updates ADMIN — { status, body } → 201; the incident's status follows; RESOLVED stamps
                                                    resolvedAt, a later non-RESOLVED update clears it (an incident can be reopened)
PATCH /settings/system-health/incidents/:id        ADMIN — { title?, severity?, services?, status: 'RESOLVED'?, body? } — an edit, or
                                                    "resolve" with a closing note (the body becomes the RESOLVED update)
```

Every incident change is audited — `INCIDENT_CREATED`, `INCIDENT_UPDATED`,
`INCIDENT_RESOLVED`, `INCIDENT_EDITED` (target `Incident`, `auditDiff` over
title, severity, status, services, startedAt, resolvedAt) — tells every
ADMIN in-app (`notifyAdmins`) and mails every confirmed `StatusSubscriber`
through `notify('INCIDENT_UPDATE', null, vars, { recipient })`, each with
their own unsubscribe link. A mail that fails is logged; the change stands.

### The public status page (root-mounted, no token)

```
GET  /status                          { region, generatedAt, overall, services: [{ service, status, latencyMs, sampledAt }],
                                        incidents: [{ id, title, severity, status, services, startedAt, updates: [{ status, body, at }] }] }
POST /status/subscribe { email }      202 always — a new or unconfirmed address is mailed STATUS_SUBSCRIBE_CONFIRM (in the request);
                                        a confirmed one is not; the answer never says which
GET  /status/confirm/:token           a page; stamps confirmedAt
GET  /status/unsubscribe/:token       a page; deletes the row
```

Rate-limited by IP (`statusPageLimiter` 60/min; `statusSubscribeLimiter`
5/hour, because it sends a mail). A service's `status` is OPERATIONAL /
DEGRADED / OUTAGE / UNKNOWN from its newest sample and the platform
settings' `health` section: no sample, or one older than
`sampleStaleMinutes` (15), is UNKNOWN — the sampler itself has stopped; a
failed probe is OUTAGE; an API p95 over `apiP95DegradedMs` (1500) is
DEGRADED. An open incident naming the service raises it to at least
DEGRADED, CRITICAL to OUTAGE — ops' word outranks a passing probe. The page
carries no sample `detail`, no user id, no count of anything.

Mounted at `/settings/system-health` ahead of `platformSettingsRouter`, with
its own `authenticate + requireRole('ADMIN')`. `Cache-Control: no-store`.
`backup.stale` is true past 26 hours (a nightly plus two hours of run);
`jobs[].stale` is true past 180 minutes — no job's interval is longer than an
hour, so three missed ticks is a stopped process, not a slow one.

## The jobs

All live in `src/jobs/` and are started from `server.ts`. The two Lot E jobs
tick hourly under a Redis lock and a day/month key, the way `kyc-purge` and
`monthly-statements` do; the Lot G sampler ticks every five minutes.

**`health-sample.job.ts`** (Lot G, every five minutes, Redis-locked, a
first tick fifteen seconds after boot) → `sampleHealth(now)`: one
`HealthSample` per service — API (`ok` always, `latencyMs` the p95 of the
minute the request logger just finished keeping in Redis, null when nothing
was served), POSTGRES and REDIS (the readiness pings with their round trip —
the Postgres ping reaches the module through `registerPostgresProbe`, filled
in bootstrap, because `shared/database` is type-only for a module), STORAGE
(`probeStorage`: a HEAD on the bucket, or an access check on the local
folder; the message is scrubbed of any `scheme://…` before it is written),
JOBS (`ok` when every name in `JOB_NAMES` has a heartbeat under 180 minutes;
`detail` names the stale ones) — then prunes rows past thirty days.

**`retention.job.ts`** (daily, IST) → `retentionSweep(now)`:

1. Every `ErasureRequest` still PENDING past `dueAt` — the thirty statutory
   days — is raised to every admin **once** (`Erasure request past due`,
   SYSTEM, `relatedId` = the request). `ops:erasure-due` remembers who has
   been told; a request that leaves the past-due set is forgotten, so one
   re-opened later is raised afresh. No admin to tell means not marked told.
2. Every erasure DONE past `retainUntil` (eight financial years from the end
   of the one it completed in — decision 126) goes on the `ops:retention-due`
   report. **Nothing is destroyed.** The ledger is append-only; a destruction
   is a DPO decision with a signature on it, and no job in this codebase
   deletes a financial row on a timer. The row is rewritten every day, empty
   when nothing is due, so the page never shows a stale list.
3. The `NotificationDelivery` purge is the notifications work's own (E1) and
   is not repeated here.

**`restore-drill.job.ts`** (monthly, on or after the 2nd IST so the month's
first nightly exists) → `runRestoreDrill(defaultDrillDeps(actor), now)`:

1. `DRILL_DATABASE_URL` unset → SKIPPED with a warning; nothing written. A
   missing drill on the ops page is the signal.
2. `DRILL_DATABASE_URL` naming the production database (by name, against
   `DIRECT_URL` / `DATABASE_URL`) → FAILED before a byte moves.
3. Otherwise: the newest `backups/<instant>.dump.enc` is downloaded,
   unsealed with `BACKUP_KEY`, gunzipped, `pg_restore --clean --if-exists`'d
   into the scratch database, and the ledger verify — the same two queries
   as `ledger.verifyLedger`, as plain SQL in `LEDGER_VERIFY_SQL` because
   they have to run against a different database — is run on what came
   back. Unbalanced transactions or wallet drift fail the drill: the data is
   there, the platform behind it would not be.
4. The result is written to `ops:last-drill`, audited `BACKUP_DRILL_RUN`
   (targetType `AppConfig`, targetId `ops:last-drill`, attributed to the
   system account, `users.systemUserId()` — E7-2; logged and skipped when it
   cannot be ensured), and on failure
   every admin is told (`Restore drill failed`). Working files are removed
   either way.

## Invariants

- **The sweep reads; a person destroys.** `retentionSweep` calls exactly two
  reads on `account-lifecycle` and writes two rows of its own. The test pins
  that the module's surface it touches is those two reads.
- **Told once.** An erasure request past due produces one notification per
  admin, ever, unless it leaves and re-enters the past-due set.
- **Never production.** The drill and `scripts/restore.ts` both refuse a
  target whose database name is production's before downloading anything.
- **Nothing here prints a URL or a key.** Tool output is scrubbed of the
  host, user and password by `shared/backup`'s `redactUrl`; the row, the
  audit metadata and the notification carry the dump's name and size only.
- **Verify SQL is a copy, on purpose.** `LEDGER_VERIFY_SQL` mirrors
  `ledger/prisma-ledger.repository.ts` (`findUnbalanced`, `findWalletDrift`).
  Change one, change the other.

- **Told by the probe, overruled by a person.** The status page never lowers
  what an open incident says; resolving the incident is the only way down.
- **Subscribe is confirm-first.** No address hears anything until its own
  mailbox clicked the link, and the subscribe form answers the same for every
  address.

## Dependencies

`account-lifecycle` (the two reads), `app-config` (`getConfigObject`,
`saveConfigObject`, `getPlatformSettings` for the `health` thresholds),
`users` (`listAdminUserIds` for the alerts, `systemUserId` for the drill's
audit row), `notifications` (`createNotification`, `notify`);
`shared/backup`, `shared/storage`, `shared/jobs`, `shared/logging`
(`readPreviousMinuteLatency`), `shared/cache` (`pingRedis`),
`shared/security` (the two status limiters), `shared/audit`, `shared/auth`,
`config/env`. Nothing imports this module but `bootstrap` and the jobs.

## Tests

`__tests__/retention.test.ts` — told once, forgotten when no longer due, the
report row, no destruction. `__tests__/restore-drill.test.ts` — skip, refuse
production, pass, failed verify, no dump, restore error, no key, warnings,
no actor. `__tests__/ops-health.test.ts` — the route through supertest:
ADMIN-only, the composed answer, the empty answer, storage down.
`shared/backup/__tests__` covers the seal, the names and the URL handling;
`shared/jobs/__tests__` the heartbeats. Lot G: `__tests__/health-sample.test.ts`
— the five rows, a failing ping, a stale job, a throwing probe, the prune,
the thirty-day series; `__tests__/incidents-status.test.ts` — the incident
routes with their audits and fan-out, the state derivation, the public page
and what it withholds, subscribe / confirm / unsubscribe, the region read.

## Suggested ownership

Platform — the same hands as `bootstrap/health.ts` and the runbook
(`docs/runbooks/backup-restore.md`).
