# access-control

The console's roles, what each one may do, and who holds one — Lot A, 12
September 2026.

## Scope, and what it is not

Two different things are called a role in this codebase, and keeping them apart
is most of understanding this module:

| | |
| --- | --- |
| `Role` (Prisma enum) | ADMIN, PUBLISHER, ADVERTISER, AGENT_*, PARTNER. Fixed in the schema, enforced per route by `requireRole()`. Which *app* you are using. |
| `RoleConfig` (this module) | A named list of permission ids — "Finance", "KYC reviewer". Resolved into the access token at session start and enforced by `requirePermission()`. What you may do *inside the console*. |

A `RoleConfig` is console access, so only an account holding the ADMIN `Role`
may be given one. Granting the `Role` itself is still `POST /users/roles`, in
the `users` module.

## The permission catalogue

`src/shared/auth/permissions.ts`, generated from one table so an id can only
exist in one place. Thirteen module groups × the tiers each has, plus seven
named capabilities:

```
marketplace  view edit            supply   view edit approve
demand       view edit            kyc      view edit approve
comms        view edit            finance  view edit approve
support      view edit            content  view edit approve
growth       view edit            hr       view edit + hr.salary.view, hr.documents.view
settings     view edit            system   view edit + system.impersonate, system.audit.export, system.roles
flows        edit                 dpo      dpo.erasure
```

`approve` exists only where the group owns a queue somebody signs off: payouts
and refunds, party verification, listing verification and claims, moderation.
`flows` has no view tier of its own — reading a flow is `settings.view` — and
`dpo` has no tiers at all, so "give them everything in settings" can never
quietly include erasing a person.

The tiers **nest by convention, not by code**: a role that may approve is given
view and edit as well, and the console's matrix does that. `requirePermission`
checks exactly the id it is given.

`tests/contract/permission-catalogue.test.ts` walks `src/` for anything shaped
like a permission id at a guard call site and fails if the catalogue does not
have it. A typo cannot reach production as a permission that silently never
matches.

## The six seeded roles

`system-roles.ts`, upserted by name at every boot by `ensureSystemRoles()` —
called from `bootstrap/register-modules.ts`, not from `prisma/seed.ts`, so a
long-running database gets them too. They are **code, not data**: a permission
added to the catalogue reaches the roles that should hold it on the next
restart, and an accidental edit in the console is undone.

| Role | Holds | System |
| --- | --- | --- |
| **Super admin** | every id in `PERMISSIONS` | ✅ |
| Ops manager | marketplace, supply, demand, comms, support, content in full; view on finance, kyc, growth, settings | |
| Finance | finance in full, `system.audit.export`; view on the rest of the marketplace | |
| KYC reviewer | kyc in full; view on the parties it verifies | |
| Support | support and comms in full; view across the marketplace | |
| Read-only | every `*.view` id and nothing else | |

Only Super admin is `isSystem`. The other five are ordinary rows seeded for
convenience — deleting one (once nobody holds it) is a legitimate thing to do.

K-B1 pins two rules on `assignRoleConfig` (`PUT /users/:id/role-config`, and
the `roleConfigId` on `POST /users`): the system role is **granted only by a
super admin** — a member of it, and nothing else since RP-1 (the first super
admin is seated at boot; see the role rule below) — 403
`SUPER_ADMIN_ONLY` otherwise; and its **last member is never moved off it**,
neither cleared nor moved to another role — 409 `LAST_SUPER_ADMIN`.

## Owned routes

Mounted at `/api/v1/roles-config`, all `authenticate`d.

| Method | Path | Guard | Status |
| --- | --- | --- | --- |
| POST | `/` | ADMIN | **201** — validates every id; audited `ROLE_CONFIG_CREATED`; T-B: answers the list's row (`memberCount`, `isSystem`) |
| GET | `/` | any authenticated | 200 — each row with `memberCount` and `isSystem` |
| GET | `/capabilities` | any authenticated | 200 — `{ groups, permissions }`, the console matrix |
| GET | `/:id` | any authenticated | 200 — the list's row, `memberCount` included (T-B) |
| PUT | `/:id` | ADMIN | 200 — audited `ROLE_CONFIG_UPDATED` with a diff; ends the members' sessions; T-B: answers the list's row |
| DELETE | `/:id` | ADMIN | 200 — audited `ROLE_CONFIG_DELETED` |

`/capabilities` is registered **before** `/:id`, or the id parameter swallows
it. Reads stay open to any authenticated user, as they were, so the admin UI
can render role pickers.

The membership route lives in `users`, because the console asks it of a person:
`PUT /users/:id/role-config { roleConfigId | null }` (ADMIN, audited
`ROLE_CONFIG_ASSIGNED`), and `GET /users/:id` carries `roleConfig {id,name}`.

## Owned Prisma entities

`RoleConfig`, `UserRoleConfig`.

## The last super admin (Lot K2)

`assertNotLastSuperAdmin(userId, action)` is the one rule behind five doors:
`PUT /users/:id/role-config` (the move, pinned by K-B1 on `countMembers`),
and — Lot K2 — `PATCH /users/:id { isActive: false }`, `DELETE /users/:id`
(both in `users`), the closure in `account-lifecycle` and — M-B —
`PATCH /users/:id { roles }` dropping ADMIN (`DEMOTE`). It refuses 409
`LAST_SUPER_ADMIN` (`details.action`: `DEACTIVATE | DELETE | CLOSE | DEMOTE`) when the
person holds the system role and no *other* member of it can still sign in
(`listMemberUserIds(…, { activeOnly: true })`): a role whose only other
member is deactivated or closed is a role with nobody in it. Somebody
outside the system role is never refused here. Granting the role stays with
its holders (`SUPER_ADMIN_ONLY`).

## Public exports (`index.ts`)

| Export | Consumer |
| --- | --- |
| `rolesConfigRouter` | bootstrap |
| `assignRoleConfig`, `getRoleConfigForUser`, `assignRoleConfigSchema` | `users` |
| `consoleStandingFor(userId, roles)` | M-B: `users` (`GET /users/me`) and, registered on `auth`'s `registerConsoleStandingResolver` **at this module's load**, `GET /auth/2fa/status` — `{ roleConfig: { id, name, isSystem } \| null, isSuperAdmin }`, the one predicate (`isSuperAdminMembership`) the `SUPER_ADMIN_ONLY` guard applies: a member of the system role and nothing else (RP-1); a non-admin is null / false with no read |
| `permissionsFor` | bootstrap — registered as `auth`'s `PermissionResolver` |
| `ensureSystemRoles` | bootstrap — the seeded roles, at startup |
| `findRoleMemberUserIds(roleName)` | `kyc` (Lot G, Q127/142) — the Compliance pool for a KYC escalation: the open-account members (isActive, not closed) of the role named Compliance, else KYC reviewer, else Super admin; an unknown role is an empty list |

## Dependencies

- `shared/auth` (the catalogue), `shared/audit`, `shared/errors`,
  `shared/logging`, `shared/http`, `shared/database` (repository only).
- `auth` — `revokeSessions`, whenever a role's permissions change.

It does **not** import `users`, and `auth` does not import it: the resolver
reaches `auth` through a port registered in `bootstrap/register-modules.ts`,
because `auth` needs nothing from here except the answer to one question and a
cycle would be the alternative. M-B: the console-standing port is registered
from this module's own `index.ts` at load (it already imports `auth`), so the
answer never depends on a second wiring step; bootstrap may take it over.

## Invariants

- **Every permission id is validated on write.** An unknown one is **400
  UNKNOWN_PERMISSION** with `details.unknown` listing them, checked *before*
  the name-conflict check, so a typo is a 400 rather than a 409. Lists are
  deduplicated on write.
- **A system role cannot be deleted, renamed or emptied** (409). Its membership
  is editable; its definition is not.
- **A role with members cannot be deleted** — **409 ROLE_HAS_MEMBERS**, with
  the count. Move the people first.
- **Changing what a role may do ends its members' sessions.** The permissions
  live in the access token, so a narrowed role that left live sessions alone
  would not actually be narrowed. Best-effort per member: one unreachable Redis
  must not leave the role half-changed.
- **One role per person.** `UserRoleConfig.userId` is unique, so assigning a
  second role moves the membership rather than adding to it.
- **Only an ADMIN may hold a console role** (409 otherwise), and the **last
  member of the system role cannot be moved off it** (409).
- **The role rule (RP-1, 24 Sep 2026).** Only Super admin holds every
  permission. An ADMIN with a role holds exactly that role's list; an ADMIN
  with no `UserRoleConfig` holds *none* and is refused **403 ROLE_REQUIRED**
  on every `requireRole('ADMIN')` route until a super admin assigns one;
  everyone else holds none. The launch rule that gave a role-less admin
  everything is gone, so the chair is seated deterministically instead: at
  boot, when no open account holds the system role, `ensureSuperAdminHolder`
  seats the account `BOOTSTRAP_SUPER_ADMIN` names (mobile or email), else the
  oldest open ADMIN; on a fresh platform with no member at all, the first
  ADMIN to sign in is seated by `permissionsFor`. Every seating is audited
  `SUPER_ADMIN_SEATED`.
- **Every admin route asks for a permission (RP-2, 24 Sep 2026).** A route
  an ADMIN can reach carries `requirePermission(<id>)` behind its
  `requireRole`, so a role's list means the same thing on every desk. The id
  is the desk's group and the verb's tier: a read asks for `<group>.view`, a
  write for `<group>.edit`, a decision (review, decide, approve, reject,
  resolve, publish, a payout's submit or cancel) for `<group>.approve` where
  the group has one; the named capabilities guard what they name — the role
  builder and role assignment `system.roles`, the audit export
  `system.audit.export`, erasure `dpo.erasure`, flow templates `flows.edit`.
  Only the routes an operator uses about themselves stay role-only — their
  own second factor (`/auth/2fa/*`), their own tasks (`/work/me/*`), their
  own flag view (`/flags/me`) — and
  `tests/contract/admin-routes-need-permission.test.ts` lists those twelve
  by name and refuses any other admin route without a guard. On a route a
  party may also call (a publisher accepting an agreement, an agent filing a
  claim), the permission is what an ADMIN needs: `requireRole` stamps which
  role admitted the token on `res.locals.matchedRoles`, and
  `requirePermission` passes an account admitted as a party. The desks map
  onto the groups so: **marketplace** — dashboard and analytics, orders and
  milestones, party imports, QR codes, reports, visits, competitor sightings,
  geography reads; **supply** (Publishers & listings) — publishers, listings,
  the supply desk, listing imports; **pricing** — rate cards, pricing, the
  price model, rate-card and market-data imports; **print** — print partners,
  quotes, print jobs on an order; **agents** — agents and their applications,
  live locations, training, reviews; **demand** — advertisers and campaigns;
  **kyc** — every verification queue, fraud cases, document reading;
  **finance** — the finance desk, wallets and refunds, revenue and plans,
  agent compensation, print-partner invoices; **content** — pages, legal
  documents, agreements and signing, creatives; **comms**, **support**
  (tickets, disputes, safety), **growth** (leads), **hr** (employees,
  departments, holidays, schedule), **work**, **settings** (platform
  settings, config, integrations, branding, identifiers, the app status,
  geography writes), **system** (users and admin accounts, flags, audit),
  **flows**, **dpo**.
- **The finer grain (RP-3, 24 Sep 2026).** Pricing, Print partners and Agents
  are groups of their own (they shared Supply and Marketplace), and the
  actions an Edit tier must not carry are named powers: `<group>.suspend`
  (suspend, reinstate, deactivate, exit — supply, demand, agents, print),
  `finance.issue` (top-up, goodwill, expiring credit), `system.jobs` (every
  sweep, run, seed and backfill triggered by hand), `<group>.import`
  (committing a bulk import — marketplace, supply, pricing), `<group>.delete`
  (every DELETE route — marketplace, pricing, kyc, content, support, hr,
  system), `system.accounts` (deleting, resetting or closing another
  account, ending an impersonation) and `<group>.export` (records as CSV —
  marketplace, finance; the audit trail keeps `system.audit.export`). The
  seeded roles hold the powers their description implies — Ops manager
  suspends, imports and deletes on its desks, Finance issues credit and
  exports — and no seeded role but Super admin runs jobs or touches accounts.
  Sixty-six ids in eighteen groups.
- `name` is unique; a duplicate answers **409 CONFLICT**, not a second row.
- `PUT` validates the body **before** checking the row exists, so a malformed
  body against an unknown id answers **400**, not 404 — the opposite ordering
  to `banking` and `advertisements`, inherited from the original controllers.

## Tests

```bash
npx vitest run src/modules/access-control
npx vitest run src/shared/auth
npx vitest run tests/contract/permission-catalogue.test.ts
```

## Suggested ownership

Platform/admin team, alongside `employees`.
