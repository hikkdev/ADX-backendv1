# users

Identity, profile, roles and account administration.

## What is NOT here

**Credentials.** Password hashes, OTPs, refresh tokens and reset tokens belong
to `auth`. Both modules touch the `User` table, split by concern rather than by
table: auth owns the credential columns and the login path, `users` owns
profile, roles and administration. Inverting that would create a cycle, because
`users` needs auth's session listing for `GET /users/me/sessions`.

## Owned routes

Mounted at `/api/v1/users`.

| Method | Path | Guard |
| --- | --- | --- |
| POST | `/bootstrap-admin` | **none** |
| GET | `/me` | `authenticate` |
| PATCH | `/me` | `authenticate` |
| GET | `/me/sessions` | `authenticate` |
| DELETE | `/me/sessions/:id` | `authenticate` |
| GET | `/me/activity` | `authenticate` |
| GET | `/` | ADMIN |
| POST | `/` | ADMIN (**201**) |
| POST | `/roles` | ADMIN |
| PATCH | `/:id` | ADMIN |
| DELETE | `/:id` | ADMIN |

`bootstrap-admin` is registered **before** the `authenticate` layer, on purpose:
it is the first-run escape hatch and there is no admin yet to authenticate as.
It refuses once any admin exists. Do not move it below `userRouter.use(...)`.

## Owned Prisma entities

`User` (profile columns), `UserRole`. Creates `AgentProfile` rows as a
side effect of granting an agent role — `agents` owns them thereafter.

## Public exports (`index.ts`)

- `userRouter`.
- `getUserDisplayName(userId)` — used by `support` to label reply authors.
- `userExists(userId)` — used by `employees` before creating an HR record.

Those two exist so no other module queries `User` directly.

## Dependencies

- `auth` — `listActiveSessions`, `revokeSessionById`, `normalizeMobile`.
- `shared/audit`, `shared/http`, `shared/auth`, `shared/errors`,
  `shared/validation`, `shared/database` (repository only).

## Invariants

- Three different response shapes, one per endpoint group, in `users.mapper.ts`:
  `/me` reports `hasPassword` and `avatarUrl`; the admin list omits both and
  adds `isActive`, `lastLoginAt`, timestamps, placed orders and onboarding
  submissions; the admin update echoes a narrower object still. They are not
  interchangeable.
- `/me` reports `hasPassword` spelled correctly. The mobile-OTP **login**
  payload in `auth` returns `hashPassword`. Both are part of the API.
- An admin cannot deactivate or delete their **own** account.
- The **last remaining admin** cannot be deleted.
- Uniqueness on mobile and email is re-checked only when the value actually
  changes, so saving an unchanged form never conflicts with the user's own row.
- Mobile numbers are normalised (`normalizeMobile`) before both the uniqueness
  check and the write.
- The admin-edit activity action varies with the change:
  `ACCOUNT_DEACTIVATED`, `ACCOUNT_ACTIVATED` or `PROFILE_UPDATED_BY_ADMIN`. It
  is logged against the **edited** user with the acting admin in the metadata —
  except `USER_DELETED`, which is logged against the **admin**, because the
  deleted user's own log is cascade-deleted with them.
- Granting `AGENT_PUBLISHER` or `AGENT_ADVERTISER` upserts an `AgentProfile`;
  a role without one would have nothing to hang assignments off.
- Creating a user is one transaction: user, roles and (for agent roles) the
  agent profile.

## The deletion cascade

`deleteUserCascade` in `prisma-users.repository.ts` is the one place a module
deliberately reaches across domains. It removes, in a single transaction:
milestone evidence, order milestones, agent assignments, check-ins, site
verifications and orders; listings and sites; the publisher profile; agent
transactions, agent milestones and the agent profile, nulling the references
that survive; then QR scans, ticket messages, support tickets and finally the
user.

It stays whole because a partial cascade would leave orders pointing at a user
that no longer exists. **Do not split it across repositories** — that is exactly
the refactor that would turn it into a data-integrity bug. If a new table gains
a `userId`, add it here.

## Tests

```bash
npx vitest run src/modules/users
```

## Suggested ownership

Senior owner, shared with `auth`.
