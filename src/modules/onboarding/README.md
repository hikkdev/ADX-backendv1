# onboarding

The admin-driven intake flow for publishers, advertisers and partners:
versioned flow templates, and the submissions captured against them.

## NOT publisher onboarding

`publishers` also has "onboarding": the QR-claim flow an agent runs on site to
take a publisher through setup. This module is the **back-office intake form**
the admin panel drives, over `OnboardingFlowTemplate` and
`OnboardingSubmission`. Different tables, different actors.

## Agents and employees (Lot D, Q131)

`userType` also takes **AGENT** and **EMPLOYEE**, each with a shipped template
(`agent-onboarding`, `employee-onboarding`). The intake form is their
onboarding record; the direct create screens (`POST /agents`, `POST /employees`)
stay. The difference is what an **APPROVED** status does:

- **AGENT**: `data` (`mobile`, `name`, `email?`, `side: PUBLISHER|ADVERTISER`,
  `city?`, `state?` — mobile and name fall back to the linked user) is handed to
  `agents.createAgent`, the same door the direct screen uses, so an agent has
  one way of coming into being. An inline user provisioned at create is
  attached, not duplicated (`createAgent` finds the mobile first); a submission
  with no user is linked to the one created. The response carries
  `provisioned: { agentId, userId }`. No side is 400.
- **EMPLOYEE**: the submission must hold a user (inline or linked; 409
  otherwise). `data.department`, `data.designation` and the document URLs go
  to `employees.createEmployee`; an existing row for that user is reused rather
  than 409'd; `data.inviteToConsole { roleConfigId?, method }` sends the
  ordinary console invitation to the user's email, skipped with
  `inviteSkipped: 'NO_EMAIL'` when there is none. The response carries
  `provisioned: { employeeId, userId, inviteId }`.
- Provisioning runs **before** the status moves, so a failure leaves the
  submission where it was; and only on the first approval, so a second press
  creates nothing twice. Publisher, advertiser and partner approvals provision
  nothing, as before. Their KYC is recorded afterwards on the twins
  (`/agent-kyc`, `/employee-kyc`).

## Owned routes

All at `/api/v1/onboarding`. The whole router is `authenticate` + **ADMIN** —
these endpoints provision user accounts.

| Method | Path |
| --- | --- |
| GET | `/flow-templates` |
| GET | `/flow-templates/:key` |
| PUT | `/flow-templates/:key` |
| GET | `/submissions` — E7-3: `?q=` (the intake's name / mobile, or the linked user's), `?status=` one or a comma list, `?userType=`; with `?page=`/`?pageSize=` the answer is the list contract `{ items, total, page, pageSize, counts }` (chips minus the status facet), without either the bare array it always answered, one release |
| POST | `/submissions` (**201**) |
| GET | `/submissions/:id` |
| PATCH | `/submissions/:id` |
| DELETE | `/submissions/:id` |
| PATCH | `/submissions/:id/status` |

## Owned Prisma entities

`OnboardingFlowTemplate`, `OnboardingSubmission`. Creates `User` and `UserRole`
rows when provisioning a subject inline — see below.

## Dependencies

- `auth` — `normalizeMobile`.
- `agents` (Lot D) — `createAgent` on an approved AGENT intake.
- `employees` (Lot D) — `createEmployee`, `findEmployeeByUserId`, `inviteEmployeeToConsole` on an approved EMPLOYEE intake.
- `shared/audit` — every mutation writes an activity entry.

## Invariants

- **Default templates seed lazily on read**, not by migration, so a fresh
  install and an upgrade converge without a deploy step. A stored template is
  overwritten only when its `version` is behind the shipped one, so an
  operator's hand-edits at the current version survive. Bump `version` in
  `onboarding.flow-defaults.ts` to roll a change out.
- Template resolution on create: explicit `flowTemplateId` wins, then
  `flowTemplateKey`, then the convention `<usertype>-onboarding`. A template
  whose `userType` disagrees with the submission is **400**.
- A submission can either **link** an existing user by `userId` or **provision**
  one inline via `user`. Provisioning happens in the same transaction as the
  submission — a created account without its submission would be an orphan
  nobody is tracking. Duplicate mobile or email is **409**.
- Inline users get roles from the request, or the default for their user type
  (`PUBLISHER` → `['PUBLISHER']`, and so on). AGENT and EMPLOYEE default to no
  role: the agent's comes from `createAgent` at approval (the side decides
  which), the employee's console access from the invitation.
- Default status on create is `SUBMITTED`, not `DRAFT`.
- **Only `DRAFT` submissions can be edited or deleted** — anything further along
  is audit history and can only be `CANCELLED` through the status endpoint.
  Both answer **409**, not 403.
- A draft's `userType` can change mid-flow; the linked template is re-resolved
  to match.
- The status endpoint always stamps `reviewedById` and `reviewedAt`, including
  for a move back to `DRAFT`.
- `userType` and `status` query filters are **upper-cased before validation**,
  so `?status=draft` works; an unrecognised value is **400**.
- `?active=` defaults to true unless the literal string `'false'` is sent.

## Tests

```bash
npx vitest run src/modules/onboarding
```

## Suggested ownership

Platform/admin team, alongside `users` — it provisions accounts.
