# onboarding

The admin-driven intake flow for publishers, advertisers and partners:
versioned flow templates, and the submissions captured against them.

## NOT publisher onboarding

`publishers` also has "onboarding": the QR-claim flow an agent runs on site to
take a publisher through setup. This module is the **back-office intake form**
the admin panel drives, over `OnboardingFlowTemplate` and
`OnboardingSubmission`. Different tables, different actors.

## Owned routes

All at `/api/v1/onboarding`. The whole router is `authenticate` + **ADMIN** —
these endpoints provision user accounts.

| Method | Path |
| --- | --- |
| GET | `/flow-templates` |
| GET | `/flow-templates/:key` |
| PUT | `/flow-templates/:key` |
| GET | `/submissions` |
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
  (`PUBLISHER` → `['PUBLISHER']`, and so on).
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
