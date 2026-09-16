# work

Lot AA — the DR 10 **Tasks** section on real tables, essentials only. The
owner's Q70 (12 Sep 2026) was "PMO: minimal, essentials only"; on 15 Sep the
owner asked "there was a Tasks section in DR 10 — where is it?". This is it:
projects, tasks with sub-tasks, people, reviewers, prerequisites, comments,
hours and issues; the overview, the board and a person's own list.

**Coordination only.** A task assigned to an agent never pays. Paid field
work stays where the money is — `orders`, `order-milestones`, `visits` — and
a task may *point at* one of those records (`linkedKind`/`linkedId`) without
ever moving it or paying for it.

Not to be confused with `schedule` (the staff diary: a meeting at a time),
`order-milestones` (the per-order fulfilment checklist) or `support` (tickets
from parties). Those keep their tables; this module has its own seven.

## Owned tables

`WorkProject` (PRJ-), `WorkTask` (TSK-), `WorkTaskAssignee`,
`WorkTaskReviewer`, `WorkTaskDependency`, `WorkTaskComment`, `WorkTimeLog`,
`WorkIssue` (ISS-). The three display ids come off the `identifiers` counter
(`PartyType` TASK / ISSUE / PROJECT) like every other number ADX prints.

People and linked records are **read** from their owners' tables
(`employees`, `agents`, `hr`'s `Department`, `geo`'s `City`, orders,
listings, leads, visits, publishers, advertisers, print partners, campaigns)
inside `prisma-work.repository.ts` and never written.

## Owned routes

Mounted at `/api/v1/work`. `authenticate` at the router. `/me/*` is any
EMPLOYEE (ADMIN session) or AGENT session, scoped in the service to the
caller's own tasks; everything else is ADMIN + `work.view`, the writes
`work.edit`. `work.approve` is checked in the service where it matters.

| Method | Path | What |
| --- | --- | --- |
| GET | `/people?q&kind=EMPLOYEE\|AGENT` | The assignee picker: up to 50 active employees and agents |
| GET | `/overview?projectId&from&to` | The numbers the overview screen draws (below) |
| GET | `/board?projectId&assigneeUserId` | Columns per status but ARCHIVED, 100 newest-updated each with a `more` count |
| GET | `/time-logs?userId&from&to&projectId` | A person's week: the rows + `totals { hours, billableHours }` |
| GET | `/projects?kind&status&cityId&departmentId&q&sort&page&pageSize` | List contract, chips by status |
| POST | `/projects` | `{ name, description?, kind, departmentId? / cityId?, ownerUserId, startsAt?, endsAt? }` → **201** PRJ- |
| GET | `/projects/:projectId` | The project + `counts { tasks by status, openIssues, hoursLogged }` |
| PATCH | `/projects/:projectId` | Name, description, owner, dates; the department or city of its kind only |
| POST | `/projects/:projectId/archive` | Status ARCHIVED; 409 if already |
| GET | `/tasks?…` | List contract (facets below), chips by status over the filter minus its status |
| POST | `/tasks` | Create → **201** TSK- (fields below) |
| GET | `/tasks/:taskId` | The whole record (below) |
| PATCH | `/tasks/:taskId` | Fields; `progress` 409 on a parent; `projectId` 409 on a sub-task that differs from its parent |
| DELETE | `/tasks/:taskId` | **204** for a DRAFT with no children; anything else is archived (200 `{ archived: true }`) |
| POST | `/tasks/:taskId/status` | `{ status, reason? }` under the status rules |
| POST | `/tasks/:taskId/review` | `{ decision: APPROVE\|REJECT, note? }` by a reviewer, or `work.approve` |
| PUT | `/tasks/:taskId/assignees` | `{ userIds }` — replace; newcomers told |
| PUT | `/tasks/:taskId/reviewers` | `{ reviewers: [{ userId, approver }] }` — replace; a stayer keeps their mark |
| PUT | `/tasks/:taskId/prerequisites` | `{ ids }` — replace; no self, no cycle (409 names the path) |
| POST | `/tasks/:taskId/comments` | `{ body }` → **201**; the task's people told, minus the author |
| POST | `/tasks/:taskId/time-logs` | `{ forDate, hours 0.25–24, billable?, note? }` → **201**; the actor's own hours |
| DELETE | `/tasks/:taskId/time-logs/:logId` | **204**; own, or `work.edit` |
| GET | `/issues?status&severity&projectId&taskId&assigneeId&q&sort&page&pageSize` | List contract, chips by status |
| POST | `/issues` | `{ title, description?, severity, projectId? / taskId?, assigneeId? }` → **201** ISS- |
| GET | `/issues/:issueId` | The issue, its raiser, assignee and task named |
| PATCH | `/issues/:issueId` | Title, description, severity, assignee, `status: OPEN\|IN_PROGRESS` |
| POST | `/issues/:issueId/resolve` | `{ status: RESOLVED\|WONT_FIX, resolution }` stamps `resolvedAt` |
| POST | `/issues/:issueId/reopen` | Back to OPEN, resolution cleared |
| GET | `/me/tasks?status=&reviewing=` | The caller's own assigned tasks (open ones by default), deadline-sorted, overdue first. AB-B: `reviewing=true` answers instead the tasks the caller reviews that are `PENDING_REVIEW` and still lack their mark (`approvedAt` and `rejectedAt` both null), deadline-sorted; `status` is ignored under the flag |
| GET | `/me/summary` | `{ open, dueToday, overdue, awaitingMyReview }` — `awaitingMyReview` is the length of the `reviewing=true` list (one helper reads both) |
| GET | `/me/tasks/:taskId` | The detail — 404 unless assigned or a reviewer |
| POST | `/me/tasks/:taskId/status` | `IN_PROGRESS \| PENDING_REVIEW \| BLOCKED` (+ reason) — the assignee's own moves |
| POST | `/me/tasks/:taskId/comments` | As above, as the caller |
| POST | `/me/tasks/:taskId/time-logs` | As above, an assignee's own hours |
| POST | `/me/tasks/:taskId/review` | As above, when the caller is a reviewer |

`/me` is mounted ahead of the ADMIN guard so "me" is never read as an id.

### Task list facets

`?status` (csv) `?priority` `?projectId` `?assigneeUserId` `?reviewerUserId`
`?q` (title or display id) `?dueFrom` `?dueTo` `?overdue=true`
`?linkedKind&linkedId` `?parentTaskId` `?tag`
`?sort=DEADLINE|PRIORITY|UPDATED|CREATED` `?dir`. ARCHIVED rows are hidden
unless the status facet names them; the chips still count them. Each item:
`id, displayId, title, status, priority, progress, deadline, startDate,
project { id, displayId, name, kind }, assignees (people), openIssues,
childCount, overdue, tags, parentTaskId, updatedAt`.

A date given as `YYYY-MM-DD` is read in Indian time: a start is that day's
midnight, a deadline the last instant of that day — "due on the 16th" is not
overdue until the 17th begins. A full ISO instant is taken as it is.

### Create fields

`title, description?, projectId?, parentTaskId?, priority (MEDIUM),
status DRAFT|TODO (TODO), startDate?, deadline?, effortEstimateH?,
linkedKind?+linkedId?, recurrence?, tags?, assigneeUserIds?,
reviewers? [{ userId, approver }], prerequisiteIds?`. `createdById` is the
actor. A sub-task inherits its parent's project (409 if it names another).
The linked pair is `ORDER | LISTING | LEAD | VISIT | CITY | PUBLISHER |
ADVERTISER | PRINT_PARTNER | CAMPAIGN` and the row must exist — 404 naming it.

### The detail

The task + `project` + `parent { id, displayId, title }` + `children (id,
displayId, title, status, progress, deadline)` + `assignees` + `reviewers`
(each with `approver, approvedAt, rejectedAt, note`) + `prerequisites` +
`dependents` + `comments` (author resolved) + `timeLogs { rows, totals }` +
`issues` (open first, then by severity) + `linked { kind, id, label }` where
`label` is the row's display name (the order's campaign name, the listing
title, the lead's business, the city name …). Three read-time flags:
`overdue`, `blockedByIssue` (an OPEN CRITICAL issue sits on it — no status
change) and `childrenAllVerified` (the parent is *offered* VERIFIED, never
moved there).

## The people rule

A task's people are **employees and agents** — the two registries `hr`'s
people list unions. `resolvePeople(userIds)` reads both tables in one go and
answers `{ userId, name, kind: EMPLOYEE|AGENT, role (the designation, or
"Field agent"), departmentName }`; a staffer who also carries an agent
profile is an EMPLOYEE. Putting anyone else on a task — or someone no longer
active — is **422** with the ids named. Every read resolves people the same
way, active or not, so a task against someone who has left still says who.

## The status rules

`DRAFT → TODO → IN_PROGRESS → PENDING_REVIEW → VERIFIED`, with `BLOCKED` off
TODO / IN_PROGRESS and `ARCHIVED` from anywhere.

- `TODO → IN_PROGRESS` stamps `actualStartDate` (once) and is **409** with
  the list when an unfinished prerequisite exists — a prerequisite is
  finished at VERIFIED or ARCHIVED. The same check guards
  `BLOCKED → IN_PROGRESS`, so BLOCKED is no side door past a prerequisite.
- `IN_PROGRESS → PENDING_REVIEW`: a task with **no reviewers goes straight to
  VERIFIED** (Q70: review is optional). With reviewers, the marks of any
  earlier round are cleared and each reviewer is told.
- `PENDING_REVIEW → VERIFIED` only through the review endpoint — **409**
  otherwise — unless the actor holds `work.approve`.
- `→ BLOCKED` needs a `reason` (**400** without), stored as `blockedReason`
  and cleared on leaving. `BLOCKED → TODO | IN_PROGRESS`.
- `→ ARCHIVED` from any status needs `work.edit`.
- `VERIFIED` stamps `completedAt` and sets `progress` 100; a VERIFIED task
  cannot move (**409**) except to ARCHIVED.

Every change writes `WORK_TASK_STATUS_CHANGED` with `auditDiff` over
`status, blockedReason, actualStartDate, completedAt, progress` and
`metadata { from, to, requested, reason, via: status|review }`, so
`GET /audit/targets/WorkTask/:id` is the status history the detail screen
draws.

**Parent rollup.** A task with children has a derived `progress`: the mean
of the children's, recomputed on every child change (create, patch, status,
delete) all the way up. Setting it by hand is **409**. When every child is
VERIFIED the detail says `childrenAllVerified: true` — offered, not forced.

## The review rule

`POST /tasks/:id/review { decision, note? }` by a reviewer of that task
(**404** if not, unless `work.approve`). APPROVE stamps `approvedAt`; when
every approver row (`approver: true`) has approved the task becomes
VERIFIED; when there are no approver rows, any reviewer's approve verifies;
`work.approve` verifies outright. REJECT stamps `rejectedAt`, files the note
as a comment, sends the task back to IN_PROGRESS and tells the assignees.
Both decisions leave `WORK_TASK_REVIEWED`.

## Hours

Hours are a number a person logs against a task for a day — by an assignee,
or `work.edit` for anyone; the `userId` is always the actor's. Deleting is
the owner's or `work.edit`. `GET /time-logs` is a person's week with totals.
That is all: there is no approval workflow on hours beyond the reviewer's
sign-off on the task, no rate, no payroll.

## Issues

An issue sits on a project or a task (the task's project when both are
absent), by severity `CRITICAL | HIGH | MEDIUM | LOW`. `OPEN | IN_PROGRESS`
are open; `RESOLVED | WONT_FIX` are closed through `/resolve` with a
resolution, reopened through `/reopen`. An OPEN CRITICAL issue on a task
marks the task's read `blockedByIssue: true` — a flag, never a status move.

## The overview

`GET /overview?projectId&from&to` (default: this Indian month) →
`tasks { total, byStatus, byPriority, overdue, dueThisWeek, verifiedInWindow }`,
`trend [{ month, planned (deadline in month), completed (completedAt in month) }]`
over the window's months, `issues { open, bySeverity, byStatus }`,
`workload [{ person, open, inProgress, overdue, hoursInWindow }]` top 12 by
open, `overdueList` top 8 by deadline, `projects [{ id, displayId, name,
kind, open, verified, progress }]` over the ACTIVE projects (the one named
when `projectId` is given). ARCHIVED tasks are outside every number.

## Notifications and the job

`NotificationType` WORK, through `notifications.notify` with the in-app copy
here and a push template seeded per event (`work-*` keys; ops may add email).
Every row carries `relatedType: 'WORK'` beside `relatedId` (the task) — AB-B;
the phones resolve a row through `relatedType` first:

| Event | To | When |
| --- | --- | --- |
| `WORK_ASSIGNED` | the assignee | put on a task — create, `PUT /assignees`, a recurrence spawn |
| `WORK_REVIEW_REQUESTED` | each reviewer | the task reaches PENDING_REVIEW; a reviewer added while it is there |
| `WORK_REJECTED` | the assignees | a reviewer sends it back |
| `WORK_DUE` | the assignees | the 08:00 IST sweep: due tomorrow |
| `WORK_OVERDUE` | the assignees | the 08:00 IST sweep: overdue |
| `WORK_COMMENT` | assignees, reviewers, creator — minus the author | a comment |

`src/jobs/work-due.job.ts` ticks every quarter hour, heartbeats as
`work-due`, and from 08:00 IST runs `sweepDueTasks` once per day (a day key)
— the sweep itself keys `work:due:<task>:<day>` / `work:overdue:<task>:<day>`
with SET NX, so a task's people hear each notice **once per task per day**
whatever the tick count. A key Redis could not write skips the task for
that tick rather than risk telling twice.

**Recurrence.** `recurrence { frequency DAILY|WEEKLY|MONTHLY, occursOn?,
endDate?, totalOccurrences? }` spawns the next TODO copy — same title,
description, project, parent, people, priority, tags, link; the dates
advanced by the frequency — when the current one is VERIFIED, until
`endDate` (the next deadline would fall past it) or `totalOccurrences` (the
original counts as 1; the copy carries `occurrence`). In the service, on the
verification itself; no cron. Audited `WORK_TASK_RECURRED`.

## Audit

Every ADMIN write leaves a row under `module: 'work'` with its target:
`WORK_PROJECT_CREATED / UPDATED / ARCHIVED`, `WORK_TASK_CREATED / UPDATED /
DELETED / STATUS_CHANGED / REVIEWED / RECURRED / ASSIGNEES_SET /
REVIEWERS_SET / PREREQUISITES_SET / COMMENTED`, `WORK_TIME_LOGGED /
TIME_LOG_DELETED`, `WORK_ISSUE_CREATED / UPDATED / RESOLVED / REOPENED`. A
person's own moves through `/me` (a comment, their hours) are theirs and
not ADMIN writes; their status moves and review decisions are audited
because they are the task's history.

## What is NOT here, and why (Q70)

The DR 10 frames drew more than this. The owner's answer was "PMO: minimal,
essentials only", so:

- **No baseline, buffer or slack engine.** A task has a `deadline` and a
  `revisedEndDate`; there is no planned-vs-actual variance, no critical
  path, no float. The PMO tool ADX links to does that.
- **No overtime.** Hours are a number; nothing compares them to a working
  day or a contract.
- **No Gantt.** Dependencies exist for the "cannot start until" rule and
  the cycle check, not for a chart.
- **No payroll, no rates, no invoicing from hours.** Hours logged are a
  number, approvals are a reviewer's mark on the task. `work.approve` signs
  off a review as an approver; it does not pay anyone.
- **Coordination only.** A task assigned to an agent never pays — paid field
  work stays in `orders`, `order-milestones` and `visits`.

## Permissions

`work.view` opens the desk; `work.edit` creates, patches, archives, sets
people and prerequisites, resolves issues, and may log or remove anyone's
hours; `work.approve` verifies a task under review outright and reviews a
task one is not a reviewer of. `/me` needs none of them — an employee or
agent session and the task being theirs.

## Features

`work.projects`, `work.tasks` (the root prefix and the `work-due` job),
`work.issues`, `work.my-tasks`.
