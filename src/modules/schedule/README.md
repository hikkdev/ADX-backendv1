# schedule

Lot E (Q72/Q99): the staff diary ADX owns — a meeting, a call, a day at the
printer — put against a person the registry knows, with the field work of a
person who is also an agent **overlaid** from its own tables and never
copied in.

Not to be confused with `visits` (the field visit itself), `order-milestones`
(the per-order site visit) or `orders` (the job with a slot). Those rows stay
where they are; this module reads them back as one read-only list, through
`visits`' fold, for the grid to draw beside the entries.

## Owned routes

Mounted at `/api/v1/schedule`, `authenticate` + ADMIN at the router. The
diary is admin-only (Q99); an agent reads their own day through
`GET /agents/me/day`.

| Method | Path | What |
| --- | --- | --- |
| GET | `/?from&to&assigneeUserId&include=visits,milestones,jobs` | The window: `{ from, to, entries, holidays, overlay }` |
| GET | `/log?from&to&page&pageSize` | The trail, by this module's actions, over the window's Indian days |
| POST | `/` | `{ date, startTime, endTime?, title, notes?, assigneeUserId, department? }` → **201** |
| PATCH | `/:entryId` | Any field, plus `status: PENDING\|IN_PROGRESS\|PAUSED\|COMPLETED`; an empty patch is **400** |
| DELETE | `/:entryId` | 200, or 404 |

`/log` is declared ahead of `/:entryId` so "log" is never read as an id.

## The window read

`from` and `to` are `YYYY-MM-DD`, inclusive, at most 93 days apart (a
quarter), `to` not before `from`. The answer is three lists:

- **`entries`** — the diary rows in the window, narrowed to one person when
  `assigneeUserId` is given; in date, then start-time order. E10-1: each
  carries `assignee { id, name }` beside `assigneeUserId`, one
  `users.findUserLabels` lookup for the window — active or not, because an
  entry against a person who has since left still has to say who.
- **`holidays`** — `hr.holidaysInRange(from, to)`, so the grid can shade them.
  Always present, whoever is selected.
- **`overlay`** — read-only rows `{ kind: FIELD_VISIT | SITE_VISIT | JOB, id,
  title, where, at, status, link }` from `visits.agentWorkInWindow`, over
  the Indian days the window names (`dayWindowISTFor`). Only when all three
  hold: `include` names at least one table, `assigneeUserId` is given, and
  that person has an agent profile (`hr.findPerson`). Otherwise `[]` — a
  staffer with no field work has nothing to overlay, and that is an empty
  list, not an error. The overlay is for the **selected person only** (Q99);
  the grid never walks the orders table for everybody on it.

`include` says which tables are asked at all: `visits` are the agent's slotted
field visits in the range (any status — a declined visit is drawn declined),
`milestones` the site visits due in it or in hand, `jobs` the orders with a
slot in it. Each row's `link` is where the console opens it
(`/visits/:id`, `/orders/:orderId/milestones/:id`, `/orders/:id`).

## The writes

An entry's `assigneeUserId` must be somebody the registry knows — active
staff or an ACTIVE agent, both assignable (Q99) — checked through
`hr.findPerson` on create and whenever a patch changes it; anyone else is a
**404**. `endTime`, when given, must be after `startTime`; a patch that
supplies one half is checked against the stored other half. `date` is a
calendar day, times are `HH:mm`. `createdByUserId` is stamped from the
session.

Every write is audited — `SCHEDULE_ENTRY_CREATED`, `SCHEDULE_ENTRY_UPDATED`
(with a diff over date, times, title, assignee, department and status),
`SCHEDULE_ENTRY_DELETED` — with `targetType: 'ScheduleEntry'`, the row's id,
and `module: 'schedule'`.

## The log

`GET /schedule/log` reads `ActivityLog` back through `shared/audit`'s
`findActivity`, filtered to `module: 'schedule'` and the three actions above,
over the window's Indian days by the row's `createdAt`; each item carries the
actor, the diff and the metadata — and (E10-1) `assignee { id, name } | null`,
the person the row's `metadata.assigneeUserId` names, through the same
`users` lookup; null when the row names nobody. **There is no delete**, here or anywhere:
the trail is the record of the diary, not part of it.

## Owned Prisma entities

`ScheduleEntry` — `{ date @db.Date, startTime 'HH:mm', endTime?, title,
notes?, assigneeUserId, department?, status, createdByUserId }`, indexed on
`(date, assigneeUserId)` and `(assigneeUserId, date)`. `assigneeUserId` is a
user id, not a foreign key to either profile table, because a person may be
staff, an agent, or both.

## Public exports (`index.ts`)

- `scheduleRouter`. Nothing imports this module but bootstrap; it is a leaf.

## Dependencies

- `hr` — `holidaysInRange`, `findPerson`.
- `visits` — `agentWorkInWindow` (which itself reads `agents`, `orders` and
  `order-milestones`; the fold lives there so the direction stays
  `schedule → visits → …` with no cycle).
- `shared/audit` (`logActivity`, `auditDiff`, `findActivity`), `shared/time`
  (`dayWindowISTFor`), `shared/auth`, `shared/errors`, `shared/http`,
  `shared/database` (repository only).

## Invariants

- Field work is **never copied** into `ScheduleEntry`; the overlay is derived
  on every read and cannot be edited here.
- The overlay is shown only for the selected person, and only when asked for.
- Holidays come back with every window read, so the grid can shade them
  without a second call.
- Dates are `YYYY-MM-DD` on the wire and UTC midnight in the column.

## Tests

```bash
npx vitest run src/modules/schedule
```

## Suggested ownership

Platform, alongside `hr` and `employees`.
