# auth

Establishing and ending sessions: mobile OTP, email OTP, email + password,
refresh-token rotation, password reset, and publisher self-registration.

```
auth/
  auth.routes.ts     one router, four subfeatures
  auth.schema.ts     every request schema
  auth.mapper.ts     the four login response payloads
  auth.session.ts    startSession — token pair + lastLoginAt
  otp/               mobile and email OTP
  password/          password login, reset, change, account lockout
  tokens/            refresh-token lifecycle and session listing
  publisher/         publisher self-registration and login
```

## What is deliberately NOT here

**Access-token signing and verification** live in `shared/auth/jwt`. The
`authenticate()` middleware has to verify a token on every request, and shared
infrastructure may not import a business module. This module owns the *stateful*
half — refresh tokens, OTPs, password hashes and reset tokens.

## Owned routes

All at `/api/v1/auth`. Only `change-password` is authenticated.

| Method | Path | Middleware |
| --- | --- | --- |
| POST | `/send-otp` | `otpRequestLimiter`, `verifyCaptcha` |
| POST | `/verify-otp` | `otpVerifyLimiter` |
| POST | `/send-otp-email` | `otpRequestLimiter`, `verifyCaptcha` |
| POST | `/verify-otp-email` | `otpVerifyLimiter` |
| POST | `/refresh` | `refreshLimiter` |
| POST | `/logout` | `refreshLimiter` |
| POST | `/login-password` | `passwordAuthLimiter`, `verifyCaptcha` |
| POST | `/forgot-password` | `passwordAuthLimiter`, `verifyCaptcha` |
| POST | `/reset-password` | `passwordAuthLimiter` |
| POST | `/change-password` | `authenticate` |
| POST | `/publisher/send-otp` | `otpRequestLimiter`, `verifyCaptcha` |
| POST | `/publisher/verify-otp` | `otpVerifyLimiter` |

Captcha guards the *request* endpoints, where scripted abuse pays off — not
verify, reset-consume or refresh, which either need a secret already in hand or
gain nothing from a per-request bot check.

## Owned Prisma entities

`Otp`, `RefreshToken`, `PasswordResetToken`, and the credential columns of
`User` (`passwordHash`, `isActive`, `lastLoginAt`, role list).

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

## Invariants — read before touching a login response

- **`POST /verify-otp` returns `hashPassword`, not `hasPassword`.** A
  long-standing typo that clients read. Email OTP and password login return
  `hasPassword`. `auth.mapper.ts` writes all four payloads out separately so
  this stays visible; renaming the key is an API change, out of scope here.
- Publisher login returns neither field, omits `avatarUrl` and `agentProfile`,
  and prefers a just-submitted `name` over the stored one. It also captures no
  session metadata (`createRefreshToken()` is called bare).
- Every OTP verification failure — wrong code, expired, unknown number, too
  many attempts — is reported as **401** with the service's own message.
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
- `DEV_LOGIN_MOBILES` self-provisions an `AGENT_PUBLISHER` account on first
  login. Hard-disabled when `NODE_ENV === 'production'`.
- `devOtp` is returned in the response body outside production only.

## Tests

```bash
npx vitest run src/modules/auth
```

The global suites in `tests/` cover the auth surface: all 12 routes appear in
the route inventory, and `change-password` is asserted to reject a missing and
a malformed token.

## Suggested ownership

Senior owner. Every change here is a security change.
