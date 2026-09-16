# hr

Lot E (Q98/Q99): the holiday calendar — the one HR record kept in-house —
and the people registry, the list of everyone the staff diary can put a
thing against.

Not to be confused with `employees`, which owns the `Employee` row and its
document set, or with `schedule`, which owns the diary. This module owns
`Holiday` and nothing else; the registry is a read over two other modules.

## Why holidays are here and everything else is not

Q98 decided that HR lives in an HR tool — Zoho People by default, Keka or
greytHR as alternatives — reached by a **portal link** from the console, with
no sync job until a tier with an API is bought. Leave, payroll, the employee
documents: the tool's. Holidays are the exception because the staff diary
shades them, and the diary is ours. So: one table, four routes, a seed.

## Owned routes

Mounted at `/api/v1/hr`, `authenticate` + ADMIN at the router.

| Method | Path | What |
| --- | --- | --- |
| GET | `/holidays?year=2026` | The year's list, in date order, as `{ id, date: 'YYYY-MM-DD', name, region }` |
| POST | `/holidays` | `{ date, name, region? }` → **201**; **409** when that date already has a holiday for that region |
| PATCH | `/holidays/:holidayId` | Any of the three; an empty patch is **400**; moving onto an existing day is **409** |
| DELETE | `/holidays/:holidayId` | 200, or 404 |
| GET | `/people?q&kind=STAFF\|AGENT&active=true&includeInactive=true` | The registry (below); E10-1: `includeInactive` |
| GET | `/departments?q&status=ACTIVE\|INACTIVE&sort=name\|newest\|members&page&pageSize` | Lot G (Q122): the list contract `{ items, total, page, pageSize, counts }`, a `memberCount` and the `head` card on every row |
| POST | `/departments` | `{ name, code?, description?, headId?, parentId?, regions?, openRoles?, isActive? }` → **201**; `code` derived from the name when omitted; a name or code already taken is **409**; a head who is not an Employee row or a parent that does not exist is **404** |
| GET | `/departments/:departmentId` | head, parent, children (each with its count), regions, openRoles, and `members` with `region`, `workMode`, `employmentType`, `active` |
| PATCH | `/departments/:departmentId` | Any of the create fields; an empty patch is **400**; a parent that is the department itself or anything under it is **400** |
| DELETE | `/departments/:departmentId` | 200; **409** with `details.reason: DEPARTMENT_HAS_MEMBERS` (and `members`) while people are in it, or `DEPARTMENT_HAS_CHILDREN` while departments sit under it |

Every holiday write is audited — `HOLIDAY_CREATED`, `HOLIDAY_UPDATED` (with
a diff over date, name, region and kind), `HOLIDAY_DELETED` — with
`targetType: 'Holiday'` and the row's id. Lot G (Q123): every holiday carries
`kind: 'PUBLIC' | 'OPTIONAL'` — a gazetted day everyone has off, or a
restricted one a person may choose — accepted on create (default `PUBLIC`)
and patch, seeded `PUBLIC`, and carried on every read including
`holidaysInRange`, so the diary's shading can tell the two apart.

## Departments (Lot G, Q122/Q140)

G11-1: `GET /hr/departments/:id` — every `members[]` row carries `joinedAt`,
the Employee row's `createdAt`: **"on record since"**, not the joining date,
which the HR tool holds (Q98). `POST /hr/departments` and `PATCH
/hr/departments/:id` take `headUserId` beside `headId` — the head by login,
resolved to the employee record through `employees.findEmployeeByUserId`
(404 when the login has no record); the row stores the record's id either
way, `null` clears, and both in one body is a 400.

Q122 chose a **full `Department` model** over the free string on the
Employee row: name and unique code, an optional head (an `Employee` row), a
parent (a tree), the regions it covers and the number of open roles — a
figure ops keep by hand, because hiring stays in the HR tool (Q98). Task
assignment and milestone analysis will build on it. `departments/` holds the
schema, service, controller and repository; the routes sit on `hrRouter`.

The row is this module's; **the people in it are `employees`'**, read
through that module's index (`listDepartmentMembers`,
`countEmployeesByDepartment`, `findEmployeeCard` for the head) and never its
table — the rule the people registry follows. Every write is ADMIN and
audited — `DEPARTMENT_CREATED`, `DEPARTMENT_UPDATED` (a diff over name, code,
description, headId, parentId, regions, openRoles, isActive),
`DEPARTMENT_DELETED` — with `targetType: 'Department'`. A delete is refused
while members or child departments exist, so nothing is re-rooted or
orphaned by one.

**`ensureDepartments()`** runs from bootstrap at boot beside `ensureHolidays`,
not awaited: every distinct free `department` string still on an Employee
row with no `departmentId` becomes a record (matched case-insensitively to
one that already exists, or created with a code derived from the name), and
the rows carrying it are linked. Idempotent — a second boot finds nothing
unlinked and writes nothing; a record ops renamed is never touched.

## The seed

`ensureHolidays()` runs from `bootstrap/register-modules.ts` at boot, beside
`ensureSystemRoles`, not awaited and skipped under `NODE_ENV=test`. It walks
`holidays-2026.ts` — **a short list in code, marked as such**: the three
national days and the central government's gazetted list, whose lunar dates
a state or a moon-sighting may move by a day — and inserts only the days
that are missing. It never rewrites a name and never touches a regional
entry, so ops corrects a date or adds a state holiday through the routes and
the seed does not undo it on the next restart. Next year's list is a new
constant beside this one.

## The people registry

G11-1: every STAFF row of `GET /hr/people` carries `employeeId` (the
Employee row's id) beside `userId`; an AGENT row has `agentProfileId` as
before and no `employeeId`.

`GET /hr/people` is the union of **active staff** (`employees.listActiveEmployeesForDirectory`)
and **ACTIVE agents who can sign in** (`agents.listActiveAgentsForDirectory`),
each through the module's index — this module queries neither table. A row
says which it is:

```
{ userId, name, kind: 'STAFF', designation, department }
{ userId, name, kind: 'AGENT', tier: 'GOLD II', agentProfileId }
```

`?kind` asks only one side; `?q` is passed to both; the registry only ever
lists the active, so `?active=false` is an empty list. A person who is both —
a staffer with an agent profile — appears once, as staff. Sorted by name.

E10-1: every row carries `active: boolean`, and `?includeInactive=true` lists
the people who have left too — inactive employees and non-ACTIVE agents (or
ones whose account can no longer sign in), each flagged `active: false` — so
the diary can still name whoever an old entry was put against. Off by
default; the two module reads take the same switch.

`findPerson(userId)` is the same question for one person, for `schedule`:
staff (with their `agentProfileId` if they have one, so the diary can overlay
their field work), agent, or `null` for nobody the registry knows.

## Owned Prisma entities

`Holiday` — `{ date @db.Date, name, region?, kind }`, unique on `(date, region)`;
`Department` (Lot G) — `{ name @unique, code @unique, description?, headId? → Employee, parentId? → Department, regions[], openRoles, isActive }`.
Postgres treats two NULL regions as distinct under that index, so the
national-day collision is checked by hand (`findHolidayOn`) before every
write, which is also what makes the seed idempotent.

## Public exports (`index.ts`)

- `hrRouter`.
- `holidaysInRange(from, to)` and `findPerson(userId)` — for `schedule`.
- `ensureHolidays()` — for bootstrap.
- `ensureDepartments()` — for bootstrap (Lot G); `DepartmentView`, `DepartmentDetail` types.

## Dependencies

`employees` and `agents` (indexes only), `shared/audit`, `shared/auth`,
`shared/errors`, `shared/http`, `shared/database` (repository only).

## Invariants

- Dates are `YYYY-MM-DD` on the wire and UTC midnight in the `@db.Date`
  column; a date that is not a calendar day (`2026-02-30`) is **400**.
- A blank or omitted `region` is a national day; `region` is trimmed.
- One holiday per `(date, region)`, NULL region included — **409**, never a
  constraint error.
- The registry keeps no copy: it is assembled on every read from the two
  modules that own the rows.

## Tests

```bash
npx vitest run src/modules/hr
```

## Suggested ownership

Platform, alongside `employees`.
