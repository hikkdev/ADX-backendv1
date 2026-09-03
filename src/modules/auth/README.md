# auth

Establishing and ending sessions: mobile OTP, email OTP, email + password,
Google Workspace sign-in, refresh-token rotation, password reset, and publisher
self-registration.

```
auth/
  auth.routes.ts     one router, five subfeatures
  auth.schema.ts     every request schema
  auth.mapper.ts     the five login response payloads
  auth.session.ts    startSession — token pair + lastLoginAt
  otp/               mobile and email OTP
  password/          password login, reset, change, account lockout
  google/            Google Workspace sign-in (ID token verification)
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
| POST | `/google` | `googleAuthLimiter` |
| POST | `/publisher/send-otp` | `otpRequestLimiter`, `verifyCaptcha` |
| POST | `/publisher/verify-otp` | `otpVerifyLimiter` |

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

`google/__tests__/google.service.test.ts` runs the verifier against a locally
generated RSA keypair with the JWKS endpoint stubbed, so it needs no network,
no Postgres and no Redis. It covers the cases that matter: a token minted for
a different Google app, an `alg: none` forgery, an HS256 token signed with the
client id as the shared secret, and an `hd` that does not match the email.

The global suites in `tests/` cover the auth surface: all 13 routes appear in
the route inventory, and `change-password` is asserted to reject a missing and
a malformed token.

## Suggested ownership

Senior owner. Every change here is a security change.
