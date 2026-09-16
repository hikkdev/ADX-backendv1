# auth

Establishing and ending sessions: mobile OTP, email OTP, email + password,
Google Workspace sign-in, refresh-token rotation, password reset, and publisher
self-registration.

```
auth/
  auth.routes.ts     one router, seven subfeatures
  auth.schema.ts     every request schema
  auth.mapper.ts     the login response payloads
  auth.session.ts    startSession — token pair (with `perms`) + lastLoginAt
  auth.ports.ts      PermissionResolver — filled by access-control at bootstrap
  otp/               mobile and email OTP
  password/          password login, reset, change, account lockout
  google/            Google Workspace sign-in (ID token verification)
  two-factor/        the admin second factor (Q25); Lot K2: totp.ts (RFC 6238 by hand) and
                     authenticator.service.ts (enrolment, recovery codes, the policy)
  invites/           invitations to the console (Q26)
  mobile-change/     moving the sign-in number — two codes, the old number first (Lot F, Q18)
  tokens/            refresh-token lifecycle, session listing and revocation
  publisher/         publisher self-registration and login
```

## What is deliberately NOT here

**Access-token signing and verification** live in `shared/auth/jwt`. The
`authenticate()` middleware has to verify a token on every request, and shared
infrastructure may not import a business module. This module owns the *stateful*
half — refresh tokens, OTPs, password hashes and reset tokens.

## Owned routes

All at `/api/v1/auth`. Only `change-password`, the three `change-mobile`
steps and (Lot K2) the five authenticator routes are authenticated.

| Method | Path | Middleware |
| --- | --- | --- |
| POST | `/send-otp` | `otpRequestLimiter`, `verifyCaptcha` |
| POST | `/verify-otp` | `otpVerifyLimiter` — M-B: an account holding ADMIN gets **no tokens**; it gets `{ challenge }` (the password login's shape) bounded to what the phone did not prove — `AUTHENTICATOR` when enrolled and `EMAIL` while the backup lasts, never SMS again — or, when the policy does not allow SMS for the account, `AUTHENTICATOR` alone; 403 `ADMIN_SIGN_IN_REQUIRED` (`details.loginAt`) when nothing can answer. Audited `LOGIN_2FA_CHALLENGED { method: 'otp' }` |
| POST | `/send-otp-email` | `otpRequestLimiter`, `verifyCaptcha` |
| POST | `/verify-otp-email` | `otpVerifyLimiter` — M-B: an ADMIN is refused 403 `ADMIN_SIGN_IN_REQUIRED` naming the console login (the code is spent; `LOGIN_FAILED { method: 'otp_email' }`) |
| POST | `/refresh` | `refreshLimiter` |
| POST | `/logout` | `refreshLimiter` |
| POST | `/login-password` | `passwordAuthLimiter`, `verifyCaptcha` |
| POST | `/forgot-password` | `passwordAuthLimiter`, `verifyCaptcha` — AE-B: the reset link leaves by the ONE email door (`shared/email`'s `sendEmail`: SMTP, Resend or the Ethereal test inbox, as the integrations row says), no longer by `sendMail` directly; the desk's `POST /users/:id/reset-password` (`sendPasswordResetLink`) goes the same way |
| POST | `/reset-password` | `passwordAuthLimiter` |
| POST | `/change-password` | `authenticate` |
| POST | `/change-mobile/start` | `authenticate`, `otpRequestLimiter` — `{ newMobile }`; codes the **current** number |
| POST | `/change-mobile/confirm-old` | `authenticate`, `otpVerifyLimiter`, `otpRequestLimiter` — `{ newMobile, code }`; checks it, codes the **new** number |
| POST | `/change-mobile/verify` | `authenticate`, `otpVerifyLimiter` — `{ newMobile, code }`; swaps the number. E9: then `MOBILE_CHANGED` through the dispatcher — the in-app row on the account and the `mobile-changed` SMS (kind `CHANGE_MOBILE`, "Your ADX number changed to +91 XXXXX ***NN on <date>. Not you? Call ADX.") to the **old** number; a failed send is logged and never blocks the swap |
| POST | `/google` | `googleAuthLimiter` |
| POST | `/2fa/send` | `otpRequestLimiter` — Lot K2: `method: AUTHENTICATOR` sends nothing and answers `{ method, expiresInSeconds: 30 }` (409 `TOTP_NOT_ENROLLED` without an enrolment); SMS / EMAIL answer 403 with `details.methods: ['AUTHENTICATOR']` when the policy's `smsAllowedWhenEnrolled` is off for an enrolled admin. M-B: a channel outside the challenge's own list (a `/verify-otp` challenge has spent SMS) is 403 `FORBIDDEN` with `details.methods`, before anything is sent |
| POST | `/2fa/verify` | `otpVerifyLimiter` — Lot K2: an enrolled admin's six digits are the app's code when no sent code is live (the newest live code still decides otherwise), and `XXXX-XXXX` is a recovery code, spent on use; the answer then carries `recoveryCodesLeft` and a `warning` at two or fewer; `mustEnrolAuthenticator: true` when the policy holds the session to enrolment. M-B: the policy is read **now** — a live SMS / email code for an enrolled admin under `smsAllowedWhenEnrolled: false` is ignored (the six digits go to the app; `LOGIN_2FA_FAILED { reason: 'SENT_CHANNEL_NOT_ALLOWED' }`); a sent code or the app's code on a channel the challenge does not list is 403 `FORBIDDEN` with `details.methods` (`*_NOT_IN_CHALLENGE`); a recovery code works on any challenge |
| POST | `/2fa/totp/enrol` | `authenticate`, `requireRole(ADMIN)`, `otpRequestLimiter` — Lot K2: `{ secret, otpauthUri, qrSvg, expiresInSeconds: 600 }`; the secret is shown **once**, lives in Redis ten minutes and never in the row until confirmed; a second call replaces the pending one; 409 `TOTP_ALREADY_ENROLLED` while one stands |
| POST | `/2fa/totp/confirm` | `authenticate`, `requireRole(ADMIN)`, `otpVerifyLimiter` — `{ code }`: seals the secret (`totpSecretEnc`), stamps `totpEnrolledAt`, answers ten recovery codes **once** (`recoveryCodes`) and, for a must-enrol session, a fresh `accessToken` without the claim; audited `TOTP_ENROLLED`; 401 on a wrong code, 409 `TOTP_NOT_ENROLLED` when nothing is pending |
| POST | `/2fa/totp/disable` | `authenticate`, `requireRole(ADMIN)`, `otpVerifyLimiter` — `{ code }` or `{ recoveryCode }`; clears the columns and every recovery code; audited `TOTP_DISABLED` with what proved it |
| POST | `/2fa/recovery-codes/regenerate` | `authenticate`, `requireRole(ADMIN)`, `otpVerifyLimiter` — `{ code }`: a fresh ten, the old ones gone; audited `RECOVERY_CODES_REGENERATED` |
| GET | `/2fa/status` | `authenticate` — `{ methods, authenticator: { enrolled, enrolledAt, recoveryCodesLeft }, policy, mustEnrolAuthenticator }`; a non-admin reads an empty method list. M-B: `roleConfig { id, name, isSystem } \| null` and `isSuperAdmin` (a member of the system role, or an ADMIN with no role config under the launch rule — access-control's own predicate, through `auth.ports.resolveConsoleStanding`), so the console stops reading the roles a second time; a non-admin reads null / false |
| GET | `/invites/:token` | **none** |
| POST | `/accept-invite` | `otpRequestLimiter` |
| POST | `/publisher/send-otp` | `otpRequestLimiter`, `verifyCaptcha` |
| POST | `/publisher/verify-otp` | `otpVerifyLimiter` — M-B: it falls back to the ordinary `LOGIN` code, so it is the mobile OTP door under another name; an ADMIN is refused 403 `ADMIN_SIGN_IN_REQUIRED` (`LOGIN_FAILED { method: 'publisher_otp' }`) — the publisher app cannot draw a challenge |

Captcha guards the *request* endpoints, where scripted abuse pays off — not
verify, reset-consume or refresh, which either need a secret already in hand or
gain nothing from a per-request bot check. `/google` is exempt for a different
reason: the caller has already cleared Google's own account challenge, so a
Turnstile check on top only adds a way for the flow to fail.

## Google Workspace sign-in

`POST /auth/google` takes the ID token that Google Identity Services hands the
browser and exchanges it for the same token pair every other login returns.

The split inside `google/` mirrors the one in `shared/auth/jwt`:

- **`google.service.ts` is stateless.** It fetches Google's JWKS, verifies the
  RS256 signature, and checks `iss`, `aud`, `exp`, `email_verified` and the `hd`
  domain allowlist. It proves *who the caller is* and touches no database.
- **`google.controller.ts` decides whether that identity may hold a session.**
  The account must already exist in ADX and be active.

Verification is done with `jsonwebtoken` and node's `crypto`, not
`google-auth-library` — one JWKS fetch and one RS256 verify is the whole job,
the same call made for Turnstile and Digio.

### Configuration

| Variable | Effect |
| --- | --- |
| `GOOGLE_CLIENT_ID` | The OAuth 2.0 Web client ID. **Unset ⇒ 503**, not a no-op. |
| `GOOGLE_ALLOWED_DOMAINS` | Comma-separated Workspace domains. Blank ⇒ no domain restriction. |

The UI's `NEXT_PUBLIC_GOOGLE_CLIENT_ID` must hold the *same* client ID: it is
the `aud` claim this backend pins, so a mismatch rejects every token.

### Invariants

- **Google sign-in never provisions an account.** An unknown email is **403**,
  never a new `User`. It is an authentication method, not a registration path —
  the right posture for an admin panel, and it keeps the required, unique
  `User.mobile` column out of a flow that has no phone number to put in it.
- The 403 for an unknown email **names the reason**, unlike `login-password`'s
  deliberately vague message. It is not an enumeration oracle: the caller has
  already proved to Google that they own that mailbox, so they learn only about
  their own address.
- **Every verification failure is one opaque 401** — wrong `aud`, expired, bad
  signature, unverified email. The real reason is logged, never returned.
- **Domain rejection is the exception: 403 with an actionable message.** Someone
  who picked their personal Gmail account in the popup has to be told to pick
  the other one.
- The domain check reads the signed **`hd` claim, never the email suffix**. An
  attacker at another Workspace can hold an alias that ends in `@adx.co`; they
  cannot forge `hd`.
- `algorithms: ['RS256']` is **pinned**, not read from the token header, so an
  `alg: none` or HS256 forgery cannot talk the verifier out of checking the
  signature.
- The account lookup is **case-insensitive**, and refuses with **409** if two
  ADX accounts differ only by email case. Nothing here normalises email on
  write and the unique index is case-sensitive, so both rows can exist; Google's
  address is canonically lower-case. Picking one arbitrarily would be an
  account-confusion bug. `login-password` keeps its exact-match lookup — changing
  it would alter an existing endpoint's behaviour.
- The JWKS is cached for as long as Google's `Cache-Control` says, clamped to
  5 minutes–24 hours, and refetched **once** on a `kid` miss (the normal way to
  observe a key rotation).
- Sign-in writes a `LOGIN_GOOGLE` activity entry carrying the Google `sub` and
  hosted domain; a rejected attempt on a deactivated account writes
  `LOGIN_FAILED` with `method: 'google'`.
- **The password lockout does not apply here.** An account locked by five failed
  password attempts can still sign in with Google. That is deliberate — the
  lockout exists to stop password guessing, and an ID token Google signed is not
  a guess — but it means the lockout invariant further up this file is about
  `login-password` specifically, not about sessions in general.
- Identity is matched on **email**, not on Google's `sub`. A Workspace admin who
  reassigns an address hands over the ADX account that address is linked to.
  Persisting `sub` on first sign-in and comparing it afterwards would close that;
  it was left out because it needs a schema change and the invite-only rule
  already bounds who can be affected.

## The admin second factor (Q25)

An account holding ADMIN gets **no tokens** from `POST /login-password` or
`POST /google`. It gets a challenge:

```json
{ "challenge": { "challengeToken": "…", "methods": ["SMS","EMAIL"],
                 "maskedMobile": "+91 ***** 2210", "maskedEmail": "a******o@adx.co" } }
```

`challengeToken` is a five-minute JWT carrying `sub` and `purpose: '2fa'` and
nothing else. `verifyAccessToken` refuses **any** token carrying `purpose`, so
it cannot open an authenticated route — pinned by
`src/shared/auth/__tests__/authenticate.test.ts` and by the 2FA suite.

- `POST /2fa/send { challengeToken, method }` — **SMS** goes through the
  ordinary `sendOtp` path under purpose `TWO_FACTOR`, so it inherits the
  per-number resend budget, the five-guess cap and the fifteen-minute lock.
  **EMAIL** sends a **ten-character** code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  — no 0/O, no 1/I, because it is read off a screen and typed — under purpose
  `TWO_FACTOR_EMAIL`, through Resend, reusing the same per-recipient OTP
  budget. Entry is case-insensitive.
- `POST /2fa/verify { challengeToken, code }` consumes the newest live code of
  either purpose (so the body does not have to say which channel it was) and
  returns the ordinary token pair through `startSession`.

**The one-factor doors (M-B).** The mobile OTP, the email OTP and the
publisher app's OTP each sign a person in on one proof, and the account
lookup is by the code's `userId` — so a SIM swap or a mailbox alone was an
admin session. Now:

- `POST /verify-otp` answers an ADMIN with a **challenge**, never tokens.
  The code proved the phone — it is the SMS factor and only that, and only
  when the policy lets this account use SMS at all (`authenticatorRequired`
  off, and either no enrolment or `smsAllowedWhenEnrolled`). The challenge
  then lists what is left — `AUTHENTICATOR` when enrolled, `EMAIL` while the
  backup lasts — and **never SMS again**, which would make one phone both
  factors. Under a policy that does not allow SMS the code bought nothing
  and the challenge is `AUTHENTICATOR` alone. When nothing can answer (no
  enrolment under a required policy; no email or a spent backup beside an
  un-enrolled account) the door is 403 `ADMIN_SIGN_IN_REQUIRED` naming the
  console login, and no challenge is minted.
- The challenge token carries the list (`methods` claim) and **`/2fa/send`
  and `/2fa/verify` enforce it**: a channel outside it is 403 with
  `details.methods`, so the challenge cannot be finished with a second SMS
  through the ordinary send. A password or Google challenge carries no list
  and is bounded by the policy alone, as before. A recovery code is not a
  channel and works on any challenge.
- `POST /verify-otp-email` and `POST /publisher/verify-otp` refuse an ADMIN
  outright with the same 403 — the mailbox is the counted *backup* of the
  second factor, not a first factor, and the publisher app cannot draw a
  challenge. The phones' own sign-in (`mobile/shared`'s `verifyOtp`) hands
  the answer to `setSession` unread; an admin on a phone therefore gets no
  session, which is the intent — admins are not meant to use the phones.

**The hijack guard.** Somebody with the password and the mailbox but not the
phone would otherwise be through, so email is counted:
`ADMIN_EMAIL_OTP_FALLBACK_LIMIT` (default 3) uses in a rolling 30 days, after
which EMAIL answers **403 MOBILE_VERIFICATION_REQUIRED** and the challenge
stops offering it. A successful **SMS** verify resets the counter to 0; so does
`POST /users/:id/2fa/reset` from the desk. `twoFactorRequiredAt` is stamped on
every ADMIN at its first challenge, at account creation and when the ADMIN role
is granted. Activity: `LOGIN_2FA_CHALLENGED`, `LOGIN_2FA_SENT`,
`LOGIN_2FA_PASSED`, `LOGIN_2FA_FAILED`, `LOGIN_2FA`.

## The authenticator app (Lot K2)

An admin may make an authenticator app — anything that speaks RFC 6238 —
their second factor. `two-factor/totp.ts` is the algorithm by hand
(HMAC-SHA1, 30-second steps, six digits, a 20-byte base32 secret, a ±1 step
window, constant-time compare), pinned by the RFC's own test vectors; no
otplib. `two-factor/authenticator.service.ts` is the enrolment and the codes.

```
 console                                   server                          Redis / User
  │ POST /2fa/totp/enrol ───────────────────►│ secret = 20 random bytes       │
  │◄── { secret, otpauthUri, qrSvg, 600 s } ─│ auth:totp:pending:<uid> 10 min ►│  (row untouched)
  │ scans; POST /2fa/totp/confirm { code } ─►│ matches ±1 step?               │
  │                                          │ User.totpSecretEnc ← AES-GCM   ►│
  │                                          │ User.totpEnrolledAt ← now      ►│
  │                                          │ 10 RecoveryCode rows (bcrypt)  ►│
  │◄── { enrolledAt, recoveryCodes[10] } ────│ TOTP_ENROLLED; in-app notice   │
  │  (sign-in) POST /2fa/verify { code } ───►│ open secret, match, claim step │
  │                                          │ SET NX auth:totp:used:<uid>:<step> 90 s ►│
```

- **A half-finished enrolment is not a factor.** The secret is in Redis
  until the first code confirms it; `totpEnrolledAt` null means not enrolled
  whatever `totpSecretEnc` holds. The secret is answered once, at enrol, and
  never logged or returned again — the sealed form is opened only to compare.
- **At rest** the secret is `iv:tag:ciphertext` (base64) under AES-256-GCM
  with `TOTP_ENCRYPTION_KEY` (32 bytes, hex or base64), else a key derived
  from `JWT_ACCESS_SECRET`. Production sets its own: rotating the JWT secret
  would otherwise unseal nobody's app.
- **The replay guard.** The step a code is accepted at is **claimed
  atomically** — one `SET NX` on `auth:totp:used:<uid>:<step>`, held 90
  seconds (M-B; the earlier get-then-set on a single last-step key let two
  requests carrying the same code interleave and both pass). The loser of
  a race, or a second use inside the window, is refused and counted as a
  wrong guess. The step that confirmed an enrolment is claimed too. The
  desk's reset and a disable drop the claims in the current window.
- **One limiter.** A wrong app code or recovery code counts against the very
  lock the SMS path keys on the mobile (`otp-security`: five wrong guesses,
  fifteen minutes), so switching channel buys no extra guesses.
- **Recovery codes** are ten `XXXX-XXXX` from the email-code alphabet,
  bcrypt-hashed like an OTP, spent on use (`usedAt`; the update is narrowed
  to the unspent row, so a race gets one session). A verify with one answers
  `recoveryCodesLeft` and warns at two or fewer. They work whatever the
  policy says — they are the answer to a lost phone, not a channel.
- **The policy** is `auth.adminTwoFactor` in platform settings.
  `authenticatorRequired` (default false): an admin without an enrolment still
  signs in with SMS / EMAIL, but the tokens carry `mustEnrolAuthenticator`
  and `authenticate()` (shared/auth, `ENROLMENT_ONLY_PATHS`) answers 403
  `TOTP_ENROLMENT_REQUIRED` on every route but `POST …/2fa/totp/enrol`,
  `POST …/2fa/totp/confirm`, `GET …/2fa/status`, `POST …/auth/logout` and
  `GET …/users/me` — the list names the **method** with the path (M-B:
  `PATCH /users/me` is an edit and is not on it) — one claim read and one
  test per request. Refresh re-decides the claim; confirm hands back a
  token without it.
  `smsAllowedWhenEnrolled` (default true): off, an enrolled admin's challenge
  lists `AUTHENTICATOR` alone and `/2fa/send` refuses the sent channels.
  M-B: **the policy is read at verify time**, so flipping it off does not
  have to expire anything — a live SMS or email code for an enrolled admin
  is simply not consulted any more (`/2fa/verify` reads the six digits as
  the app's code); an un-enrolled admin is untouched by the switch.
- **The person is told** on enrol, disable and regenerate — the in-app
  `SYSTEM` row only. No template of the security family fits (the
  `mobile-changed` template is an SMS to the *old number* about the number),
  so there is no email or push for these until a `security-notice` template
  exists; the notice is best effort and never undoes the change.
- **The desk's reset** (`POST /users/:id/2fa/reset`) clears the enrolment
  and the codes beside the email backup — see `users`.
- Activity: `TOTP_ENROLMENT_STARTED`, `TOTP_ENROLLED`, `TOTP_DISABLED`,
  `RECOVERY_CODES_REGENERATED`; `LOGIN_2FA_PASSED` / `LOGIN_2FA_FAILED` carry
  `method: AUTHENTICATOR | RECOVERY_CODE` and the reason.

## Invitations to the console (Q26)

Nobody signs themselves up for an admin account. An admin invites an address
(`POST /users/invites`, in the `users` module — the console's end of this
flow); the link carries a one-time token stored **hashed**, SHA-256, like a
password reset; and the account is created at acceptance, not before.

- `GET /auth/invites/:token` — what the accept screen draws. A spent, revoked,
  expired or invented token all answer `{ valid: false, email: '' }`: the token
  is the only thing proving the caller was invited, so a bad one never names
  an address.
- `POST /auth/accept-invite { token, name, mobile, otpCode?, password? }` —
  two calls. Without `otpCode` it sends one to the number (purpose `REGISTER`);
  with it, it creates the admin. The number is proved **before** the account
  exists because the second factor will send to it.

Acceptance **promotes** the inert row the OTP send created rather than making a
second one — deleting it would take the very OTP row that just proved the
number — dropping the PUBLISHER role that self-registration gives it, granting
ADMIN, stamping `twoFactorRequiredAt`, attaching the invited `UserRoleConfig`
and closing the invite, all in one transaction.

**SEAM, not built:** a later platform switch turns password sign-in off for
admins and leaves only Google. Nothing here changes when it lands — the invite
already records its method, and the switch will refuse `method: PASSWORD` at
creation.

## Changing the sign-in number (Lot F, Q18 — the old number confirms first)

The number **is** the identity (`User.mobile` is unique and OTP sign-in
resolves it), so a signed-in session alone must not be able to move it: a
stolen phone with an open app would otherwise walk the account away. The
owner's answer is two codes, in order.

```
 phone                                 server                               SMS
  │  POST /change-mobile/start           │                                    │
  │  { newMobile } ─────────────────────►│ new number free? no money in flight?│
  │                                      │ OTP CHANGE_MOBILE_OLD ────────────►│ → CURRENT number
  │◄──── { sentTo: 'CURRENT' } ──────────│                                    │
  │  POST /change-mobile/confirm-old     │                                    │
  │  { newMobile, code } ───────────────►│ verify CHANGE_MOBILE_OLD           │
  │                                      │ consent  auth:mobile-change:<uid>  │
  │                                      │          = newMobile, 15 min       │
  │                                      │ OTP CHANGE_MOBILE ────────────────►│ → NEW number
  │◄──── { sentTo: 'NEW',                │                                    │
  │        confirmWithinSeconds: 900 } ──│                                    │
  │  POST /change-mobile/verify          │                                    │
  │  { newMobile, code } ───────────────►│ consent stands for THIS number?    │
  │                                      │   no → 409 OLD_NUMBER_NOT_CONFIRMED│
  │                                      │ verify CHANGE_MOBILE               │
  │                                      │ User.mobile ← newMobile            │
  │                                      │ revokeSessions(uid, MOBILE_CHANGED)│
  │                                      │ USER_MOBILE_CHANGED (auditDiff)    │
  │                                      │ SYSTEM notification                │
  │◄──── { mobile, previousMobile,       │                                    │
  │        sessionsRevoked: true } ──────│                                    │
  │  (signs in again on the new number)  │                                    │
```

- Both codes go through the ordinary OTP path (`sendOtpToNumberForUser`:
  the same per-number lock, the same three-sends-per-ten-minutes budget,
  the `LOGIN_OTP` SMS kind). The second is addressed to a number **no
  account holds yet**, which is why it cannot go through `sendOtp` — that
  resolves the user from the number.
- The consent lives in Redis, keyed by the user and holding the new number,
  so a confirm-old for one number cannot be spent on another; a fresh
  `start` withdraws it; `verify` **fails closed** when Redis cannot answer.
- The three guards — not the number already on the account, not a number
  somebody else holds, no withdrawal in REQUESTED / APPROVED / PROCESSING —
  are re-checked at **every** step: minutes pass between the calls.
- `verify` ends every session through `revokeSessions` (refresh tokens *and*
  the access tokens still in flight), including the one making the call.
- Activity: `MOBILE_CHANGE_STARTED`, `MOBILE_CHANGE_OLD_CONFIRMED`,
  `USER_MOBILE_CHANGED` (with the `mobile` diff), `SESSIONS_REVOKED`.
- A UPI VPA that contains the old number is text the person typed into a
  payout method; ADX does not rewrite it, and the screen says so.

## Session revocation

`revokeSessions(userId, reason)` ends **both** halves of a session: every
refresh-token row, and every access token still in flight, through a Redis
marker `auth:revoked:<userId>` = the moment of revocation, TTL one access-token
lifetime. `authenticate()` in `shared/auth` refuses a token whose `iat` is
older than the marker.

The read is memoised in-process for ten seconds, so a page that fans out into a
dozen calls pays one round trip, and it **fails open** if Redis is unreachable:
the refresh token is already revoked by then, so the exposure is one access
token's lifetime, and a Redis outage must not turn every route into a 401.

Called by `users` (deactivation, a desk mobile change, a role grant) and by
`access-control` (a role's permissions changed).

## Permissions in the token

`startSession` and `POST /refresh` both resolve `perms: string[]` through
`auth.ports.ts`, whose resolver is `access-control.permissionsFor`, registered
in `bootstrap/register-modules.ts`. Unregistered, the launch rule answers: an
ADMIN holds every permission, everyone else none. A role change therefore takes
effect by **revoking the session**, never by editing a token.

## Owned Prisma entities

`Otp`, `RefreshToken`, `PasswordResetToken`, `AdminInvite`, Lot K2:
`RecoveryCode`, and the credential columns of `User` (`passwordHash`,
`isActive`, `lastLoginAt`, role list, `twoFactorRequiredAt`,
`emailOtpFallbackCount`, `emailOtpFallbackResetAt`, `totpSecretEnc`,
`totpEnrolledAt`).

## The User overlap with `users`

This is the one table two modules share, deliberately. Auth needs the credential
columns to log someone in; `users` owns profile and administration. Inverting it
would create a cycle, because `users` needs auth's session listing for
`GET /users/me/sessions`. Split by concern, not by table.

## Public exports (`index.ts`)

| Export | Consumer |
| --- | --- |
| `authRouter` | bootstrap |
| `listActiveSessions`, `revokeSessionById` | `users` — `/users/me/sessions` |
| `revokeAllRefreshTokens` | `users` — admin deactivating an account |
| `createRefreshToken`, `SessionMeta` | `users` |
| `hashPassword`, `verifyPassword` | `users`, `scripts/create-user` |
| `sendOtp`, `verifyOtp`, `normalizeMobile` | `onboarding` |
| `sendOtpToNumberForUser` | internal — `mobile-change/` (a code for a known account to a number that is not yet its own) |
| `revokeSessions` | `users`, `access-control` |
| `resetEmailOtpFallback`, `requireTwoFactorFor` | `users` |
| `clearAuthenticator`, `authenticatorStatus`, `recoveryCodesLeftFor` | `users` — Lot K2: the desk's reset and the admin reads' `twoFactor` summary |
| `createInvite`, `listInvites`, `resendInvite`, `revokeInvite`, `inviteSchema` | `users`, `employees` |
| `registerPermissionResolver`, `launchPermissions` | bootstrap |
| `registerConsoleStandingResolver`, `ConsoleStanding` | M-B: `access-control` registers `consoleStandingFor` at load — what `GET /auth/2fa/status` says under `roleConfig` / `isSuperAdmin`; unregistered, the launch rule answers |
| `registerMobileTombstonePort`, `MobileTombstonePort` | bootstrap, filled from `account-lifecycle` |

## Invariants — read before touching a login response

- **An ADMIN never receives tokens from a login endpoint.** Only
  `/auth/2fa/verify` issues them for an admin. A change that returns tokens
  from `login-password`, `/google`, `/verify-otp`, `/verify-otp-email` or
  `/publisher/verify-otp` for an admin is a security regression (M-B closed
  the last three). The challenge `/verify-otp` mints is bounded
  (`methods` claim) and `/2fa/send` + `/2fa/verify` honour the bound.
- **A challenge token is not an access token.** `verifyAccessToken` refuses
  anything carrying `purpose`, or lacking `sub`/`roles`.
- **Lot K2: an authenticator secret is answered once**, at enrol, and is
  never in a log line or a response afterwards; the row holds only the sealed
  form. A must-enrol session can open nothing but the enrolment routes.
- **`POST /verify-otp` returns `hashPassword`, not `hasPassword`.** A
  long-standing typo that clients read. Email OTP and password login return
  `hasPassword`. `auth.mapper.ts` writes all four payloads out separately so
  this stays visible; renaming the key is an API change, out of scope here.
- Publisher login returns neither field, omits `avatarUrl` and `agentProfile`,
  and prefers a just-submitted `name` over the stored one. It also captures no
  session metadata (`createRefreshToken()` is called bare).
- Every OTP verification failure — wrong code, expired, unknown number, too
  many attempts — is reported as **401** with the service's own message.
- **An erased number may register again** (Lot A, Q60). `sendOtp` consults the
  `MobileTombstonePort` only when it has just created the user row, and only to
  write a `REREGISTERED_AFTER_ERASURE` activity row beside the new account. It
  never refuses the send, and an unreadable tombstone is logged and ignored:
  the erasure was granted, and the person is entitled to come back.
- `sendOtp` for an unregistered number responds exactly like a successful send,
  so it cannot be used to enumerate accounts. `forgot-password` does the same.
  `login-password` returns one message for unknown account, no password set and
  wrong password.
- `reset-password` failure is **400 BAD_REQUEST**, not 401: a spent or malformed
  token is not a failed credential.
- Resetting a password revokes **all** refresh tokens. Changing one deliberately
  does not.
- `change-password` does not require `currentPassword` when the account has no
  password yet — it doubles as "set my initial password" for OTP-created users.
- Refresh-token rotation is single-use. Presenting an already-revoked token
  means the raw value leaked, so the **whole session family is revoked** and a
  `REFRESH_TOKEN_REUSE_DETECTED` activity entry is written.
- Refresh renews a session: it re-signs the access token but leaves
  `lastLoginAt` untouched. Only the four login handlers stamp it.
- `publisher/verify-otp` tries purpose `REGISTER` first and falls back to
  `LOGIN`, because the client does not say which it is.
- `publisher/send-otp` against an existing non-publisher account is **403** —
  it never silently grants the role.
- Two throttles stack, on purpose: the per-IP limiters in `shared/security`, and
  per-account limits here that survive IP rotation — 3 OTP sends per recipient
  per 10 minutes, 5 wrong guesses per code, and a 15-minute account lockout
  after 5 failed password attempts.
- `DEV_LOGIN_MOBILES` self-provisions an account on first login. Each entry
  is `<mobile>` (an `AGENT_PUBLISHER`, as before) or `<mobile>:<ROLE>` with
  ROLE one of the seeded roles; an unknown role drops the entry with a
  warning. Hard-disabled when `NODE_ENV === 'production'`.
- Q-B (owner's item 11), the dev-only admin door: a `<mobile>:ADMIN` entry
  mints an `ADMIN` only when `NODE_ENV !== 'production'` AND
  `DEV_ADMIN_LOGIN=true` (default false) — both, or the entry is refused
  with a logged reason (`NODE_ENV_PRODUCTION` / `DEV_ADMIN_LOGIN_OFF`) and
  the number becomes an ordinary roleless user. The mint is audited
  `DEV_ADMIN_LOGIN_USED` on the new account and happens once: a known
  number never re-mints. The minted admin carries a placeholder email
  (`dev-admin-<last4>@adx.local`) so the console's second factor has the
  EMAIL channel after the mobile door has spent SMS; the 2FA code comes
  back as `devCode` outside production, as it always has. Nothing bypasses
  2FA and the seed gains nothing — the allowlist is the door.
- `devOtp` is returned in the response body outside production only.

## Tests

```bash
npx vitest run src/modules/auth
```

`google/__tests__/google.service.test.ts` runs the verifier against a locally
generated RSA keypair with the JWKS endpoint stubbed, so it needs no network,
no Postgres and no Redis. It covers the cases that matter: a token minted for
a different Google app, an `alg: none` forgery, an HS256 token signed with the
client id as the shared secret, and an `hd` that does not match the email.

The global suites in `tests/` cover the auth surface: every route appears in
the route inventory, and `change-password` and the three `change-mobile` steps
are asserted to reject a missing and a malformed token.

`two-factor/__tests__/totp.test.ts` pins the RFC 6238 vectors, the window
and the seal; `two-factor/__tests__/authenticator.test.ts` runs enrol →
confirm → sign-in with the app against a fake Redis, the replay guard (M-B:
two concurrent verifies with one code give one sign-in), the shared
limiter, the recovery codes, disable / regenerate, the two policy switches
(M-B: read at verify time), the status read, and the bounded challenge
`/verify-otp` mints with what `/2fa/send` and `/2fa/verify` do with it.
`otp/__tests__/admin-door.test.ts` pins the three doors at the handler:
challenge or 403 for an admin, tokens for everybody else.
`two-factor/__tests__/status-standing.test.ts` pins the console standing on
`/2fa/status` and the port behind it. None needs Postgres or Redis.

`mobile-change/__tests__/mobile-change.test.ts` pins the two-code order: no
verify without a standing consent for that exact number, the consent spent
on success and kept on a wrong code, every guard re-checked at every step.

## Suggested ownership

Senior owner. Every change here is a security change.

## E6 exports

- `revokeOtherSessions(userId, keepSessionId)` — for `users`' `DELETE
  /users/me/sessions`: every open refresh token but the one named.
- `sendPasswordResetLink(userId, email)` — for `users`' `POST
  /users/:id/reset-password`: the same token and email `POST /auth/forgot-password`
  sends, minted here so the raw value never crosses a module boundary.
