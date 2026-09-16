# employees

HR records for internal staff: department, designation, active flag, and the
document set collected during employment onboarding.

Unrelated to `agents` (field workers with an `AgentProfile`) and to `users`
(identity and roles). An employee record hangs off a `User`, one per user.

## Owned routes

Mounted at `/api/v1/employees`, all `authenticate`d and — since Lot E,
Q143 — all ADMIN.

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/` | ADMIN | **201** — mints `displayId`, may also invite to the console |
| GET | `/` | ADMIN | 200, paginated; `?q`, `?department`, `?active=true\|false`, `?page`, `?pageSize` (clamped to 100). E10-1 / Q-B: with `?page=` OR `?pageSize=` in the query `data` is the list contract `{ items, total, page, pageSize, counts }` — the chips `ACTIVE` / `INACTIVE` counted over the filter with the `active` facet removed — and the `meta` sibling stays one release (owner's item 8: employee-kyc's console read sends `pageSize=100` alone and is a list request too); with neither, the bare array and its `meta` are what they were, kept for the two readers that exist. Lot G (Q113): `?sort=NAME\|ROLE\|JOINED` with `?dir=asc\|desc` on both paths — NAME on the person, ROLE on the designation (nulls last), JOINED on `createdAt`; `dir` defaults `asc` for the two words and `desc` for the date (newest first, as the table always drew); the sort never reaches the chip count. G13-B: `?sort=REGION` too (A to Z, blanks last); every row is the Employee record with `region`, `workMode` and `employmentType` on it |
| GET | `/:userId` | ADMIN | 200 — document URLs masked without `hr.documents.view`; carries `hrmsLink`. N3-B: and `kyc: { state, kycId, submittedAt, requestedAt, requestedChannel, method }` — the `EmployeeKyc` record's summary (joined on `findByUserId`), `state` derived by `shared/kyc-state` the way `GET /employee-kyc` derives it: AWAITING_DOCUMENTS from the moment the row exists (no mirror column), REQUESTED after HR's one click, PENDING once recorded, then the decision |
| PUT | `/:userId` | ADMIN | 200 — accepts `externalHrmsId` (unique; `null` unlinks); Lot G (Q122/Q140): `departmentId` (a `Department` row `hr` owns — 404 when it does not exist, `null` unlinks), `region`, `workMode` (`OFFICE\|REMOTE\|HYBRID\|FIELD`), `employmentType` (`FULL_TIME\|PART_TIME\|CONTRACT\|INTERN`); `POST /` takes the same four |
| GET | `/workload?from&to&granularity=week\|month` | ADMIN | 200 — Lot G (Q120/Q139): the workload measure, below. Literal path, ahead of `/:userId` |
| GET | `/overview` | ADMIN | 200 — G13-B: `{ headcount: { total, active, inactive }, openPositions }`; `openPositions` is Σ `Department.openRoles` over the active departments (a read of `hr`'s table inside this module's repository, like `departmentExists`). Literal path, ahead of `/:userId` |
| DELETE | `/:userId` | ADMIN | 200 |

**`selfOrAdmin` is gone (Q143).** An employee without a console role cannot
sign in, so there was nobody to serve a self-service read or edit to; the
policy file keeps only the document mask. The per-route `requireRole('ADMIN')`
is kept rather than one guard on the router so the inventory records each
route's chain as it always has.

## The department record and the work fields (Lot G, Q122/Q140)

`Employee.departmentId` points at the `Department` row `hr` owns;
`region`, `workMode` and `employmentType` say where and how the person
works. Every read joins the record as `departmentRecord: { id, name, code }`
and prints **its name under `department`** when the row is linked, the free
string otherwise — one release of both, so a console still reading the
string sees the same department the record says. On every write that names
`departmentId` the free string is set to the record's name (`null` clears
both). `?department=` on the list matches either the string or the record's
name; `?departmentId=` matches the record.

The reads `hr`'s departments make — the members of one department with
their work fields, the count per department, the head's card, the unlinked
free strings and the link `ensureDepartments()` writes — are exported from
`index.ts`; `hr` imports this module, never the other way. `departmentExists`
on the repository is a read of `hr`'s table inside this module's repository:
the foreign key alone would only answer a 500.

## The workload measure (Lot G, Q120/Q139)

`GET /employees/workload` is drawn from ADX's own data — what each active
staffer is holding, and what they did — bucketed by week (Monday) or month
over `[from, to]` (calendar days, Indian time; at most a year; defaults: the
last twelve weeks or six months, ending today). For each employee and each
bucket:

```
load (items per week) =
    Σ open items assigned right now × weight          — KYC cases (PublisherKyc + AdvertiserKyc, PENDING / NEEDS_INFO,
                                                        by assignedToId) ×2, tickets (not CLOSED, by assignedAdminUserId) ×1,
                                                        fraud cases (OPEN / INVESTIGATING / ESCALATED, by assignedToUserId) ×3
  + Σ diary entries in the bucket × 1 × 7 / days       — ScheduleEntry rows against the person
  + Σ actions in the bucket × weight × 7 / days         — ActivityLog rows by the person, classed by action name:
                                                        decisions ×2 (…_REVIEWED / _APPROVED / _REJECTED / _RESOLVED …),
                                                        moderation ×1 (CREATIVE_ / REVIEW_ / LISTING_ / SAFETY_ …),
                                                        ops ×1 (ORDER_ / VISIT_ / SCHEDULE_ / PAYOUT_ / …_ASSIGNED …),
                                                        replies ×0.5 (…_NOTE_ADDED / SUPPORT_TICKET_ / DISPUTE_ …),
                                                        other ×0.5 (the admin-write tap's `module.METHOD /path` rows);
                                                        sign-ins, sessions, file views and the platform's own SMS/EMAIL rows are not work
```

**Open items are a snapshot** — what the person holds today — so they count
once, in the bucket that contains today (or the last bucket of a window in
the past), never into earlier buckets. The load is banded by
`getPlatformSettings().hr.workloadThresholds` (defaults `medium: 10`,
`high: 25` items per week): below `medium` LOW, from `medium` MEDIUM, from
`high` HIGH. The response is `{ from, to, granularity, thresholds, weights,
buckets: [{ start, end, days, staff, counts: { LOW, MEDIUM, HIGH }, share:
{ LOW, MEDIUM, HIGH } }], employees: [{ userId, employeeId, name,
designation, department, open: { kyc, tickets, fraud, total }, buckets:
[{ start, actions: { decisions, moderation, ops, replies, other, total },
schedule, open, load, level }] }] }` — **`buckets[].share` is what the chart
draws**, the share of staff in each band per bucket of time; `employees` is
the table under it. The weights ride the response so the legend can quote
them. Disputes carry no assignee column and so enter only through the
actions their moves leave.

The four reads (`workload.repository.ts`) are counts over `kyc`'s,
`support`'s, `fraud`'s and `schedule`'s tables inside this module's
repository, because all four sit above `employees` in the graph and an
import would close a ring.

## The HR tool (Lot E, Q98)

Everything about a person beyond department, designation and the active flag
— leave, payroll, the documents — lives in the HR tool, not here. Zoho People
is the default provider, and it is **a portal link, not a sync**: the
`integrations` row's `hrms` section holds the provider, the portal URL and an
`employeeLinkTemplate` (`https://…/employees/{externalId}`), and this module
holds `Employee.externalHrmsId`. `GET /employees/:userId` answers `hrmsLink`
when both halves exist and the provider is not `NONE` — built by `hrmsLinkFor`
in the service, the id URL-encoded — and `null` otherwise. The seam for a sync
job, if a tier with an API is ever bought, is `getEffectiveHrmsConfig()` in
`shared/integrations` (`apiBaseUrl`, `apiKey` are stored, masked, and read by
nothing today) plus `findByExternalHrmsId` on the repository; nothing else
would move.

`PUT /employees/:userId { externalHrmsId }` is a **409** when another record
already carries that id — checked before the write, so it is a named
conflict and not a constraint error from Postgres. The audit diff on an update
now includes `externalHrmsId`.

The document URL columns stay for what was already uploaded; new documents go
to the tool.

## Identifiers, documents and the console (Q71)

**Every record is minted an `EMP-1209-2601`** from the `identifiers` counter on
create — never derived on read, because it ends up on a letter and an ID card
and a format change years later must not rewrite what was printed. The `EMP`
prefix is already reserved in `identifiers.service`.

**The document URLs are masked** for a caller who does not hold
`hr.documents.view`: marksheets, an NDA, a salary account letter, and they are
effectively bearer links once handed out. Masking, not omitting — the response
carries `documentsMasked: true` and `documentsOnFile: [...]`, the names of the
fields that do have a value, so the console can still draw "on file" against
"missing" for everybody; only opening one is privileged. One exception: the
launch rule stands — an ADMIN with no role config holds every permission. The
old "the person sees their own" exception went with the self-service route
(Q143).

**`POST /employees` may carry `inviteToConsole: { roleConfigId?, method }`**,
which sends the ordinary `auth` invitation to the address on the user record —
a new joiner who also needs a login, without opening a second screen. The
record is created first: an invitation with no employee row behind it is the
worse half-state of the two, because it is a live credential. No email on the
user record is a 409, not a silent skip.

Every write leaves an audit row — `EMPLOYEE_CREATED`, `EMPLOYEE_UPDATED` (with
a diff over department, designation and the active flag), `EMPLOYEE_DELETED` —
carrying the field *names* that changed and never a document URL.

## Owned Prisma entities

`Employee` (including `displayId` and, Lot E, `externalHrmsId`).

## Public exports (`index.ts`)

G11-1: `listDepartmentMembers` rows carry `joinedAt` — the row's
`createdAt`, "on record since" (the joining date proper is the HR tool's,
Q98) — and `listActiveEmployeesForDirectory` rows carry `employeeId` beside
`userId`; `hr` prints both.

- `employeeRouter`.
- Lot D: `findEmployeeByUserId`, `employeeExists` — for `kyc/employee` (the
  employee's own KYC read and the on-behalf record); `createEmployee`,
  `inviteEmployeeToConsole` — for `onboarding`, which provisions the HR row and
  the optional console invitation when an EMPLOYEE intake is approved. The
  direct create screen (`POST /employees`) stays.
- Lot E (Q99): `listActiveEmployeesForDirectory(q?, { includeInactive? })` —
  active records with the person's name, designation and department, for
  `hr`'s people registry, which unions them with the ACTIVE agents. E10-1:
  every row carries `active`; `includeInactive: true` lists the inactive
  records too, flagged `active: false`.

## Dependencies

- `shared/http`, `shared/auth`, `shared/errors`, `shared/database` (repository
  only).
- `users` — `userExists`, checked before creating an HR record.
- `identifiers` — `allocateIdentifier('EMPLOYEE')`.
- `auth` — `createInvite`, for the optional console invitation.
- `shared/auth` — `hasPermission`, for the document mask.
- `shared/integrations` — `getEffectiveHrmsConfig`, for `hrmsLink`.
- `app-config` — `getPlatformSettings().hr.workloadThresholds` (Lot G).

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
- `displayId` is issued **once**, at create, from the identifiers counter, and
  is never reissued or recomputed.
- `inviteToConsole` is **not a column**: it is stripped before the row is
  written and turned into an `AdminInvite`.
- The document mask reports presence (`documentsOnFile`) but never a URL, and
  it only touches fields the row actually carries.
- `externalHrmsId` is unique across records; a second record claiming one is
  a **409**. `hrmsLink` is derived on read, never stored — a change of portal
  or template on the integrations row moves every link at once.
- The list filter `active` is a string `true|false`, `department` matches
  case-insensitively, and `q` searches the person's name, email and mobile
  and the record's designation and `displayId`.

## Tests

```bash
npx vitest run src/modules/employees
```

## Suggested ownership

Platform/admin team, alongside `access-control`.
