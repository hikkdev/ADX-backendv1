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
| GET | `/me` | `authenticate` — E11-1: carries `emailUnsubscribedAt` (`string \| null`, which now backfills people too and answers ): stamped by the public `GET /comms/unsubscribe/:token` link in `notifications`, cleared by `POST /me/email-resubscribe`; null while ADX's email still goes. M-B: `roleConfig { id, name, isSystem } \| null` and `isSuperAdmin` (`access-control.consoleStandingFor`: a member of the system role, or an ADMIN with no role config under the launch rule — the predicate the grant guard applies), so the console stops making a second read to decide it; a non-admin reads null / false |
| POST | `/me/consent` | `authenticate` — **QR-6 (17 Sep 2026):** the terms of use and privacy policy click, the first screen after the OTP (the owner: "asked before we gather any details, and not part of the progress bar"). Stamps `consentAcceptedAt` and the versions of the live `TERMS_OF_SERVICE` / `PRIVACY_POLICY` documents (`legal.currentLegalDocument`, read server-side — the body is ignored; an unpublished document records as null). Idempotent — a later click re-stamps with what is live then. `GET /users/me` carries `consentAcceptedAt` (null until then), `consentTermsVersion`, `consentPrivacyVersion`; the app gates on the first. Logged as `CONSENT_RECORDED`. |
| PATCH | `/me` | `authenticate` — name / email / language / avatarUrl (QR-7: the profile picture — the URL an `AVATAR` upload answered; `null` removes it; `/publishers/me` and every browse card carry it); K-B1 (verifier, which now backfills people too and answers ): the email is lower-cased and, when it actually moves, runs the one-value-one-account rule — **409 `CONTACT_TAKEN`** with `details.which` when it is another account's primary or any contact row (the same `assertIdentityFree` the desk's editor runs) | **QR-4 (17 Sep 2026):** also `firstName` / `lastName` (1–60 each); the display name is composed from what is on file unless `name` is given outright. `GET /users/me` carries `displayId` (the person's own `ADX-DDMM-YYNN`, the USER series, minted the moment the number is registered — before a party, before a name — and backfilled for older rows by `POST /identifiers/backfill/publishers`, which now backfills people too and answers `{ assigned, remaining, users: { assigned, remaining } }`), `firstName` and `lastName`. The app asks for the two names right after the first OTP, before "Join ADX as". **QR-5 (17 Sep 2026):** also `dateOfBirth` (`YYYY-MM-DD`, 18–120 years ago; stored as a date) and `gender` (`MALE \| FEMALE \| OTHER \| PREFER_NOT_TO_SAY`, any casing) — the same two User columns `PATCH /publishers/me` writes; `GET /users/me` carries both (`dateOfBirth` as `YYYY-MM-DD \| null`).
| POST | `/me/party` | `authenticate` (**201** when the party was opened, 200 when it already existed, which now backfills people too and answers ) | **QR-2 (16 Sep 2026):** the answer also carries `accessToken` — the caller's own session re-signed (`auth`'s `reissueAccessToken`) with the role this call granted, because the roles ride inside the token and the one the app held was signed before the side existed; without it the publisher's home answered 403 `Insufficient permissions` until the token expired. The refresh token is untouched. The app adopts the token at once; against an older backend it renews the session instead.
| GET | `/me/onboarding-manifest` | `authenticate` — the DR 08 ladder for the caller's side; 409 before Step 1. Lot D: composed in `onboarding-manifest.service.ts` — `mode: full|partial` (partial while the KYC record is NEEDS_INFO: only the flagged capture steps, each tile marked `flagged` with the reviewer's `note`, plus the review step; a rejected liveness video brings its step back, which now backfills people too and answers ), `verification` (`digio.available` and why not — the Q129 switch; `liveness.status` — Q131; `kycStatus`, `reviewNote`), and a "Record a short video" capture step (`liveness`, field `selfVideoUrl`, sent to `POST /user-kyc/me { fileId }`) after the selfie on the manual branch, so a business now climbs twelve and an individual ten. Q83: composed from `flows.onboarding` on the AppConfig `main` row (a library of steps and a ladder per party × account type, edited by the console through `PATCH /config/flows/onboarding`) when the row holds one that passes `app-config`'s validator, and from `CODE_ONBOARDING_TEMPLATE` — the same ladder as code — when it does not; the manifest carries `manifestVersion`; Lot F moved the pin **server-side** — the KYC row (`PublisherKyc.manifestVersion` / `AdvertiserKyc.manifestVersion`) records the version at the first submission, and this read answers it whenever the row has one and no `?version=` is given (`flows.onboarding:v<N>`, the last five kept; today's when that snapshot is gone), so a console edit does not move the rungs under someone mid-climb; an explicit `?version=` still wins. `Cache-Control: no-store` |
| GET | `/me/preferences` | `authenticate` — DR 07 wave 5: every preference key, saved or defaulted (`preferences.ts`, which now backfills people too and answers ); E11-1: `emailUnsubscribedAt` (`string \| null`) beside them — an account fact, not a key, so the `.strict()` save does not take it |
| PUT | `/me/preferences` | `authenticate` — a patch of the known keys; answers the same shape as the read, `emailUnsubscribedAt` included |
| POST | `/me/email-resubscribe` | `authenticate` — E11-1: the person's own undo of the public unsubscribe link; clears `User.emailUnsubscribedAt`, audited `USER_EMAIL_RESUBSCRIBED` against the caller, answers `{ emailUnsubscribedAt: null }`; **409 `NOT_UNSUBSCRIBED`** when there was no stamp to clear |
| GET | `/me/sessions` | `authenticate` |
| DELETE | `/me/sessions` | `authenticate` — E6: ends every other session and keeps this one; `{ revoked: number }`, the count of sessions ended (E11-1: pinned by test, zero when this was the only device, which now backfills people too and answers ). Only the refresh tokens go (the per-user revocation marker would take the caller's own access token), so the other devices' access tokens lapse within one lifetime, as a single revoke already behaves; 409 for a token that names no session |
| DELETE | `/me/sessions/:id` | `authenticate` |
| GET | `/me/activity` | `authenticate` |
| GET | `/me/contacts` | `authenticate` — K-B1: `{ primary: { mobile, mobileVerifiedAt, email, emailVerified }, contacts: [{ id, kind, value, label, verifiedAt, addedBy: { id, name }, createdAt }] }`. `emailVerified` is derived from the codes the address has answered (`auth.hasProvenEmail`, which now backfills people too and answers ) — `User` carries no `emailVerifiedAt` |
| POST | `/me/contacts` | `authenticate` (**201**, which now backfills people too and answers ) — `{ kind: EMAIL\|PHONE, value, label? }`; normalised (lower-cased email, E.164 number); starts unverified; **409 `CONTACT_TAKEN`** (`details.which`: PRIMARY \| CONTACT, `userId`, `contactId?`) when the value is any account's primary or any contact row |
| PATCH | `/me/contacts/:contactId` | `authenticate` — `{ label }` |
| DELETE | `/me/contacts/:contactId` | `authenticate` |
| POST | `/me/contacts/:contactId/send-code` | `authenticate` — a code to the contact itself: a PHONE through auth's `sendOtpToNumberForUser`, an EMAIL through `sendEmailCodeToAddressForUser`, both under `CONTACT_VERIFY_PURPOSE`; 409 `ALREADY_VERIFIED` |
| POST | `/me/contacts/:contactId/verify` | `authenticate` — `{ code }`; stamps `verifiedAt`; the OTP refusals (`OTP_INVALID`, `OTP_EXPIRED`, `OTP_LOCKED`, which now backfills people too and answers ) pass through; a code issued for another account is 401 |
| POST | `/me/contacts/:contactId/make-primary` | `authenticate` — a **verified** contact only (409 `CONTACT_NOT_VERIFIED`, which now backfills people too and answers ): its value becomes `User.email` or `User.mobile` (with `mobileVerifiedAt` from the contact) and the old primary drops down to a verified contact row, in one transaction; a PHONE swap runs `auth.completeMobileChange` — every session revoked, every live code expired, `PRIMARY_CONTACT_CHANGED` audited with the pair, the old number told; answers `{ kind, before, after, wasVerified, primary, sessionsRevoked }` |
| GET | `/` | ADMIN — `?closed=true|false` filters on `User.closedAt`; omitted means everybody. E6: `?q=` (name, email or mobile contains, which now backfills people too and answers ), `?role=`; rows carry `roleConfig { id, name } \| null` and `lastLoginAt`. Lot K2: every row carries `twoFactor { required, method: AUTHENTICATOR \| SMS \| null, enrolledAt, recoveryCodesLeft }` (added fields only; one count query for the enrolled rows, through `auth.recoveryCodesLeftFor`). K-B1: `q` reaches the contact rows too; `?state=ACTIVE\|INACTIVE\|CLOSED` (CLOSED is `closedAt` set, INACTIVE `isActive: false` on an open account), `?sort=newest\|oldest\|name\|lastLogin`; `data` stays the array the console reads and `counts { ACTIVE, INACTIVE, CLOSED }` (with the state facet removed) and `total` travel beside it |
| POST | `/` | ADMIN (**201**, which now backfills people too and answers ) — `createUserSchema`: mobile + name? + email? + roles + K-B1 `roleConfigId?` (the console role, through `assignRoleConfig` with its own rules and audit row); **409 `CONTACT_TAKEN`** on a taken identity, primary or contact; audited `USER_CREATED_BY_ADMIN` against the new account |
| POST | `/roles` | ADMIN |
| POST | `/invites` | ADMIN (**201**, which now backfills people too and answers ) — invite an address to the console |
| GET | `/invites` | ADMIN |
| POST | `/invites/:id/resend` | ADMIN — re-rolls the token, a new week |
| DELETE | `/invites/:id` | ADMIN — revoke |
| GET | `/impersonations` | ADMIN — the caller's own open sessions; E7-3: each row carries `target: { id, name, role } \| null` (the person being read, their primary role, which now backfills people too and answers ) |
| POST | `/impersonations/:id/end` | ADMIN |
| GET | `/:id` | ADMIN — one account, with its `roleConfig`; E6: `isActive`, `createdAt`, `lastLoginAt` on the profile payload (so on `/me` too, which now backfills people too and answers ). K-B1: `roles` (the seeded roles) beside `roleConfig`, `contactsCount`, `sessionsCount`, `twoFactorRequiredAt`, `closedAt`, and `parties { publisher, advertiser, agent, printPartner }` — each `{ id, displayId } \| null` — so the page can link across. Lot K2: `twoFactor { required, method: AUTHENTICATOR \| SMS \| null, enrolledAt, recoveryCodesLeft }` — the factor the next sign-in asks for |
| GET | `/:id/sessions` | ADMIN — E6: the `/me/sessions` shape, `current` always false |
| GET | `/:id/activity` | ADMIN — E6: the `/me/activity` shape |
| POST | `/:id/reset-password` | ADMIN — E6: sends the ordinary password-reset link (`auth.sendPasswordResetLink`, which now backfills people too and answers ) to the account's email; 409 `NO_EMAIL` without one; audited `PASSWORD_RESET_SENT_BY_ADMIN` against the account |
| PATCH | `/:id` | ADMIN — name / email / mobile / isActive (Lot K2: `isActive: false` on the last active member of the super-admin role is 409 `LAST_SUPER_ADMIN` — `access-control.assertNotLastSuperAdmin`, which now backfills people too and answers ), K-B1: `language` and `avatarUrl` too; M-B: `roles` — the **whole** list the account holds afterwards (`ASSIGNABLE_ROLES`, at least one, deduplicated): dropping ADMIN from the last active super admin is 409 `LAST_SUPER_ADMIN` (`assertNotLastSuperAdmin(id, 'DEMOTE')`, before anything is written); otherwise dropping ADMIN clears the console role first (`assignRoleConfig(…, null)`, its own audit and revoke), the rows become the list in one transaction (`replaceRoles`), a new ADMIN is stamped `twoFactorRequiredAt`, a new agent role gets its profile, the sessions end (`ROLES_CHANGED`), and `roles` rides in the diff; `reason` **required when the mobile or the email actually changes** (the service compares against the row, so an unchanged form never asks); a value that collides with another account's primary or any contact row is **409 `CONTACT_TAKEN`** with `details.which`; one audit row per edit, `USER_UPDATED_BY_ADMIN`, with the `auditDiff` of every field that changed, the actor, the fields, `outcome` (the older ACCOUNT_DEACTIVATED / ACCOUNT_ACTIVATED / PROFILE_UPDATED_BY_ADMIN vocabulary) and, when an identity moved, `movedIdentity` and the reason; a mobile move still writes `MOBILE_CHANGED_BY_ADMIN` and ends the sessions as Lot A did, and (K-B1 verifier) expires every live OTP the account holds — login signs in by the code's `userId`, so a LOGIN code already sent to the old number would otherwise still open the account |
| DELETE | `/:id` | ADMIN — Lot K2: "the last Super Admin" is system-role membership (`access-control.assertNotLastSuperAdmin`, 409 `LAST_SUPER_ADMIN`, which now backfills people too and answers ), not a count of ADMIN rows |
| PUT | `/:id/role-config` | ADMIN — `{ roleConfigId \| null }`. K-B1 (pinned in `access-control`, which now backfills people too and answers ): the system super-admin role is granted only by a super admin — a member of it, or an admin with no role config under the launch rule (403 `SUPER_ADMIN_ONLY` otherwise) — and its last member is never moved off it (409 `LAST_SUPER_ADMIN`) |
| POST | `/:id/2fa/reset` | ADMIN — hands back the email backup; Lot K2: clears the authenticator enrolment and every recovery code too (the desk's answer to a lost phone, which now backfills people too and answers ), audited `TWO_FACTOR_FALLBACK_RESET` with the diff and `cleared { emailFallback, authenticator, recoveryCodes }`; answers the same `cleared` |
| POST | `/:id/impersonate` | ADMIN + `requirePermission('system.impersonate', which now backfills people too and answers )` (**201**) |
| GET | `/:id/contacts` | ADMIN — K-B1: the `/me/contacts` shape for somebody else |
| POST | `/:id/contacts` | ADMIN (**201**, which now backfills people too and answers ) — `{ kind, value, label?, reason }` (400 without the reason); audited `USER_CONTACT_ADDED` against the account with the admin and the reason in the metadata |
| PATCH | `/:id/contacts/:contactId` | ADMIN — `{ label }`; audited `USER_CONTACT_UPDATED` |
| DELETE | `/:id/contacts/:contactId` | ADMIN — `{ reason }`; audited `USER_CONTACT_REMOVED` with what the row was |
| POST | `/:id/contacts/:contactId/send-code` | ADMIN — the same code, sent on the person's behalf; audited `USER_CONTACT_CODE_SENT`; the desk never sees the code |
| POST | `/:id/contacts/:contactId/verify` | ADMIN — `{ code }` the person read back; audited `USER_CONTACT_VERIFIED` (`how: CODE`, which now backfills people too and answers ) |
| POST | `/:id/contacts/:contactId/mark-verified` | ADMIN — `{ reason }`: the desk's word, no code typed; audited `USER_CONTACT_MARKED_VERIFIED` (`how: READ_BACK`, which now backfills people too and answers ) |
| POST | `/:id/contacts/:contactId/make-primary` | ADMIN — `{ reason }`; the same swap as the person's, and the desk **may promote an unverified contact** — the audit row (`USER_PRIMARY_CHANGED`, with the before/after pair, the reason and the admin, which now backfills people too and answers ) says `verified: UNVERIFIED` and the new primary carries no `mobileVerifiedAt`; 409 `CONTACT_TAKEN` when the value has since become another account's. Lot K2: **403 `USE_YOUR_OWN_SETTINGS` when `:id` is the acting admin's own account** — an admin proves their own contact like everyone else, from `/me/contacts` |

`/invites` and `/impersonations` are registered **before** `/:id`, or the id
parameter reads them as user ids.

## The routes under `/users` that are NOT here

Closure and erasure (Lot A, Q21/Q60, which now backfills people too and answers ) hang off `/users` but are owned by
`account-lifecycle` and mounted **ahead of** this router: `/closure-cases`,
`/erasure`, `/me/closure-request`, `/me/erasure`, `/:id/closure-review`,
`/:id/closure-cases`, `/:id/erasure`. Registering them there is load-bearing,
because `GET /:id` below would otherwise read "closure-cases" as a user id. A
closure review asks eleven questions of nine other modules and this module is
imported by six, so owning it here would close a cycle. See
`modules/account-lifecycle/README.md`.

G6 adds two more of the same shape, each mounted ahead of this router by
bootstrap: `/me/devices` (PUT / GET / DELETE `:token` — the phone's push
registration, owned by `notifications`, see `modules/notifications/README.md`, which now backfills people too and answers )
and `/me/data-export` (POST / GET — the person's data export, owned by
`account-lifecycle`, see its README, which now backfills people too and answers ).

`bootstrap-admin` is registered **before** the `authenticate` layer, on purpose:
it is the first-run escape hatch and there is no admin yet to authenticate as.
It refuses once any admin exists. Do not move it below `userRouter.use(..., which now backfills people too and answers )`.

## Console access (Lot A, which now backfills people too and answers )

Three of the five console-access concerns are routed here because the console
asks them of a *person*, while the rules and tables live elsewhere:

| Route | Where the work is |
| --- | --- |
| `PUT /:id/role-config`, `GET /:id`'s `roleConfig` | `access-control` |
| `/invites*` | `auth` (the anonymous half is `/auth/accept-invite`, which now backfills people too and answers ) |
| `POST /:id/2fa/reset` | `auth`'s two-factor service |
| `/:id/impersonate`, `/impersonations/*` | `impersonation/`, here |

### Read-only impersonation (Q27, which now backfills people too and answers )

`POST /users/:id/impersonate { reason }` opens an `ImpersonationSession` and
mints a **fifteen-minute** token for the target carrying
`act: { sub: adminId, sessionId }` and `scope: 'read'`. `authenticate(, which now backfills people too and answers )` in
`shared/auth` copies `act` onto `req.user` and **refuses every non-GET request
that carries it** (403 `IMPERSONATION_READ_ONLY`, which now backfills people too and answers ) — centrally, so no route can
forget. `tests/contract/impersonation.test.ts` drives every authenticated write
route on the live app to prove it.

Never another **admin** (403, which now backfills people too and answers ): reading another admin's console would expose the
audit trail and the finance queues without either second factor. Never an
inactive account, never yourself. The reason is required and is the field
nobody can reconstruct later; both ends are audited as
`IMPERSONATION_STARTED` / `IMPERSONATION_ENDED` against the target user.
Revoking the acting admin's sessions ends the impersonation too.

## Contacts (K-B1, which now backfills people too and answers )

`User.mobile` (the sign-in identity, unique, which now backfills people too and answers ) and `User.email` (unique) stay
the primary pair. A `UserContact` row (`kind` EMAIL | PHONE, `value`
normalised, `label`, `verifiedAt`, `addedById`, which now backfills people too and answers ) is every other number or
address the account answers to. Three rules, in `users-identity.ts` and
`users-contacts.service.ts`:

- **One value, one account.** A mobile or email is free only when no account
  signs in with it AND no contact row anywhere carries it. Every identity
  write — adding a contact, the editor's mobile/email, `POST /users`,
  make-primary — runs through `assertIdentityFree`, answering 409
  `CONTACT_TAKEN` with `which` and whose. Lot K2: the email compare is
  **case-insensitive** (`lower(, which now backfills people too and answers ) = lower()` in the repository, not Prisma's
  `mode: 'insensitive'`, whose ILIKE would read `_` and `%` in the value as
  wildcards, which now backfills people too and answers ) because the unique index is not and rows written before K-B1
  may carry capitals — `src/scripts/lowercaseEmails.ts` folds those once
  (`npx tsx src/scripts/lowercaseEmails.ts` reports, `--write` folds; two
  rows differing only by case are reported and left for a person, which now backfills people too and answers ). And a
  same-instant add that slips past the check is caught by the
  `@@unique(kind, value, which now backfills people too and answers )` index and answered as the same 409 `CONTACT_TAKEN`.
- **A contact starts unverified.** It is proved with a code (auth's senders,
  under `CONTACT_VERIFY_PURPOSE` — Lot K2: the enum's own `CONTACT_VERIFY`
  value now that the migration has landed, which now backfills people too and answers ), or marked verified by an admin
  with a reason. The email code goes out as the `login-otp-email` template —
  no template of its own.
- **Make-primary is one transaction** (`repository.swapPrimary`, which now backfills people too and answers ): the
  promoted row goes, the old primary is written down as a contact of the
  same kind carrying the proof it actually had (Lot K2: the phone's
  `mobileVerifiedAt`; an email verified now only when `hasProvenEmail`
  vouches for it, else **unverified** — moving an address is not proving
  it, which now backfills people too and answers ), the primary column moves. A PHONE promotion then runs
  `auth.completeMobileChange` — the very post-swap work the self-service
  two-code change runs — so the sessions, the live codes, the audit row and
  the old number's notice are never forgotten here. The person may only
  promote a verified contact; the desk may promote an unverified one with a
  reason, and the audit row says so.

`primary.emailVerified` on the contacts read is derived from the codes the
address has answered (`auth.hasProvenEmail`, which now backfills people too and answers ): `User` carries no
`emailVerifiedAt` column, which is the honest gap.

## Owned Prisma entities

`User` (profile columns, which now backfills people too and answers ), `UserRole`, `ImpersonationSession`, K-B1:
`UserContact`. `findAdminDetail` makes one narrow read of `PrintPartner` by
`userId` (no back-relation on `User`, and `print-partners` sits above this
module through `orders`, which now backfills people too and answers ) — the same deliberate cross-domain read the deletion
cascade already makes. Creates
`AgentProfile` rows as a side effect of granting an agent role — `agents` owns
them thereafter.

## Public exports (`index.ts`, which now backfills people too and answers )

- `userRouter`.
- `CODE_ONBOARDING_TEMPLATE` — Q83: the DR 08 ladder in `app-config`'s template vocabulary; `scripts/seedConfig` writes it to `flows.onboarding`, and the manifest falls back to it.
- `getUserDisplayName(userId, which now backfills people too and answers )` — used by `support` to label reply authors.
- `userExists(userId, which now backfills people too and answers )` — used by `employees` before creating an HR record.
- `findUserLabels(ids, which now backfills people too and answers )` — E6: `Map<id, { id, name }>` in one query, for the
  reads that join an actor (`suspension` events directly; `feature-flags` and
  `payouts` through the ports bootstrap fills, since both sit underneath this
  module, which now backfills people too and answers ). A name is the user's name, else their mobile, else null.
- `findUserSummaries(ids, which now backfills people too and answers )`, `primaryRoleOf(roles)` — E7-3: `Map<id, { id,
  name, mobile, email, isActive, createdAt, roles, role }>` in one query, for
  the desks that name a requester or a target (`support`'s queue rows and the
  requester rail; the impersonation list here, which now backfills people too and answers ). `role` is the primary role
  the console prints — party roles first, ADMIN last, null for none. An id
  nobody matches is absent from the map.
- `ensureSystemUser(, which now backfills people too and answers )`, `systemUserId()`, `SYSTEM_USER_MOBILE`,
  `SYSTEM_USER_NAME` — E6: the system account (`+910000000000`, `ADX
  system`, `isActive: false`, no roles, which now backfills people too and answers ) the jobs write their audit rows under
  instead of the first admin. Ensured at boot beside `ensureSystemRoles`;
  `systemUserId` finds or creates it on first use when boot did not run here
  and answers null only when the database cannot be reached.

Those two exist so no other module queries `User` directly.

## Dependencies

- `auth` — `listActiveSessions`, `revokeSessionById`, `normalizeMobile`,
  `revokeSessions`, `requireTwoFactorFor`, `resetEmailOtpFallback`, and the
  four invitation calls. K-B1: `sendOtpToNumberForUser`,
  `sendEmailCodeToAddressForUser`, `verifyOtp`, `verifyEmailCodeFor`,
  `hasProvenEmail`, `CONTACT_VERIFY_PURPOSE`, `completeMobileChange`. Lot K2:
  `clearAuthenticator`, `authenticatorStatus`, `recoveryCodesLeftFor`.
- `access-control` — `assignRoleConfig`, `getRoleConfigForUser`, Lot K2:
  `assertNotLastSuperAdmin`.
- `app-config` — `getFlow`, `onboardingTemplateSchema` (Q83: the ladder as data, which now backfills people too and answers ).
- `shared/audit`, `shared/http`, `shared/auth`, `shared/errors`,
  `shared/validation`, `shared/database` (repository only, which now backfills people too and answers ).

## Invariants

- **An account with history is closed, never deleted.** `DELETE /users/:id`
  refuses 409 `USER_HAS_HISTORY` when the user or any of their publisher,
  advertiser or agent profiles has wallet entries, ledger legs, orders,
  listings, accepted agreements or a KYC record, and `details.has` names each
  with its count. `deleteUserCascade` would take the orders and the listings
  with it and leave the ledger legs describing a party that no longer exists;
  the closure case is the path, and the refusal says so. It is built:
  `POST /users/:id/closure-cases`, in `account-lifecycle`. Delete remains
  available for an account that is a mistake rather than a record.

- **`GET /users/me` carries the second-factor state** — `twoFactorRequiredAt`,
  `emailOtpFallbackCount`, `emailOtpFallbackResetAt` (E6, which now backfills people too and answers ) — on `/me` only, so
  the app can say why a challenge is coming; the admin reads do not.
- **Every read that draws a person says whether the account is closed.** `/me`
  and `GET /:id` carry `closedAt` and `closeReason`, the admin list carries
  `closedAt`, and the list takes `?closed=true|false`. A closed account is kept
  rather than removed, so without the facet the table slowly fills with rows
  nobody can act on. Omitting the parameter keeps the old behaviour —
  everybody — because that is what the existing callers expect.

- Three different response shapes, one per endpoint group, in `users.mapper.ts`:
  `/me` reports `hasPassword` and `avatarUrl`; the admin list omits both and
  adds `isActive`, `lastLoginAt`, timestamps, placed orders and onboarding
  submissions; the admin update echoes a narrower object still. They are not
  interchangeable.
- `/me` reports `hasPassword` spelled correctly. The mobile-OTP **login**
  payload in `auth` returns `hashPassword`. Both are part of the API.
- An admin cannot deactivate or delete their **own** account.
- **An admin's mobile number is never changed from the desk** — 409
  `USE_SELF_SERVICE_FLOW`. It moves through `/auth/change-mobile`, from their
  own device, with an OTP at each end. Otherwise one compromised console
  account is enough to take over every other one: change the number, then sign
  in as them.
- **Anybody else's number needs a `reason`** (400 without one, which now backfills people too and answers ), ends every
  session and every live OTP the account holds (a LOGIN code already sent to
  the old number would otherwise still sign in, since login signs in by the
  code's `userId`, which now backfills people too and answers ), and is logged as `MOBILE_CHANGED_BY_ADMIN` with a diff. The reason
  is audit metadata and never reaches the row.
- **Deactivating an account ends its sessions.** An access token outlives the
  `isActive` flag by up to its whole lifetime otherwise, which is exactly the
  window the admin pressing the button believes they just closed. Granting a
  role does the same, because the roles are in the token.
- **Granting or creating ADMIN stamps `twoFactorRequiredAt`**, so the second
  factor is on from the moment the account can sign in.
- **Only an ADMIN may hold a console role**, and the last member of the system
  role cannot be moved off it — both enforced in `access-control`.
- The **last active super admin** cannot be deleted, deactivated or closed
  (Lot K2: `access-control.assertNotLastSuperAdmin`, 409 `LAST_SUPER_ADMIN`
  on every door, counted on the members who can still sign in, which now backfills people too and answers ).
- Uniqueness on mobile and email is re-checked only when the value actually
  changes, so saving an unchanged form never conflicts with the user's own row.
- Mobile numbers are normalised (`normalizeMobile`, which now backfills people too and answers ) before both the uniqueness
  check and the write.
- The admin-edit activity action varies with the change:
  `ACCOUNT_DEACTIVATED`, `ACCOUNT_ACTIVATED` or `PROFILE_UPDATED_BY_ADMIN`. It
  is logged against the **edited** user with the acting admin in the metadata —
  except `USER_DELETED`, which is logged against the **admin**, because the
  deleted user's own log is cascade-deleted with them.
- Granting `AGENT_PUBLISHER` or `AGENT_ADVERTISER` upserts an `AgentProfile`;
  a role without one would have nothing to hang assignments off.
- Creating a user is one transaction: user, roles and (for agent roles, which now backfills people too and answers ) the
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
