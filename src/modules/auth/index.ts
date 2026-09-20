/**
 * Auth — establishing and ending sessions.
 *
 * Stateless access-token signing and verification are NOT here: they live in
 * `shared/auth/jwt`, because the authenticate() middleware must verify a token
 * on every request and shared infrastructure may not import a business module.
 * This module owns the stateful half — refresh tokens, OTPs, password hashes
 * and reset tokens.
 *
 * The exports below are the narrow surface other modules may use:
 *
 *   users        session listing and revocation for GET/DELETE /users/me/sessions,
 *                revokeAllRefreshTokens when an admin deactivates an account,
 *                and password hashing when an admin sets one.
 *   onboarding   OTP send/verify while provisioning an account.
 *   access-control  revokeSessions, when a role's permissions change.
 */
export { authRouter } from './auth.routes';

export {
  createRefreshToken,
  revokeAllRefreshTokens,
  revokeSessions,
  listActiveSessions,
  revokeSessionById,
  revokeOtherSessions,
} from './tokens/tokens.service';
export type { SessionMeta } from './tokens/tokens.service';
/** QR-2: a running session's access token re-signed with the roles the account holds now. */
export { reissueAccessToken } from './auth.session';

export { hashPassword, verifyPassword } from './password/password.service';
/** E6: the desk's `POST /users/:id/reset-password` sends the ordinary reset link. */
export { sendPasswordResetLink } from './password/password.service';

export { sendOtp, verifyOtp, normalizeMobile } from './otp/otp.service';

/**
 * K-B1 — `users`' contacts desk. A code to a phone or an email the account
 * does not sign in with (`sendOtpToNumberForUser` / `sendEmailCodeToAddressForUser`,
 * both under `CONTACT_VERIFY_PURPOSE`), the verifiers, and the post-swap work
 * the self-service mobile change does — shared so make-primary revokes the
 * sessions, expires the codes, audits and tells the old number the same way.
 */
export {
  sendOtpToNumberForUser,
  sendEmailCodeToAddressForUser,
  verifyEmailCodeFor,
  hasProvenEmail,
  expireOutstandingOtpsForUser,
  CONTACT_VERIFY_PURPOSE,
} from './otp/otp.service';
export { completeMobileChange } from './mobile-change/mobile-change.service';

/**
 * bootstrap — the resolver that fills an access token's `perms`. Registered
 * from register-modules with access-control's `permissionsFor`, because
 * access-control needs `revokeSessions` from here and a cycle would be the
 * alternative.
 */
export { registerPermissionResolver, launchPermissions } from './auth.ports';
export type { PermissionResolver } from './auth.ports';
/**
 * M-B — access-control registers `consoleStandingFor` here at load, so
 * `GET /auth/2fa/status` can say `roleConfig { id, name, isSystem }` and
 * `isSuperAdmin` with the same predicate `users` and access-control apply.
 */
export { registerConsoleStandingResolver } from './auth.ports';
export type { ConsoleStanding, ConsoleStandingResolver } from './auth.ports';

/**
 * bootstrap — the erasure tombstone (Lot A, Q60). `account-lifecycle` owns
 * `MobileTombstone` and imports `revokeSessions` from here, so the question is
 * declared here and answered there. Unregistered it answers "no".
 */
export { registerMobileTombstonePort } from './auth.ports';
export type { MobileTombstonePort } from './auth.ports';

/** users — the 2FA reset on the desk, and stamping an admin at creation. */
export { resetEmailOtpFallback, requireTwoFactorFor } from './two-factor/two-factor.service';
/**
 * Lot K2 — users: the desk's reset clears the authenticator too
 * (`clearAuthenticator`), and the admin reads carry the enrolment
 * (`authenticatorStatus`, `recoveryCodesLeftFor`).
 */
export { authenticatorStatus, clearAuthenticator, recoveryCodesLeftFor } from './two-factor/authenticator.service';
export type { AuthenticatorStatus } from './two-factor/authenticator.service';

/** users — invitations to the console. */
export {
  createInvite,
  listInvites,
  resendInvite,
  revokeInvite,
  inviteSchema,
} from './invites/invites.service';
export type { InviteInput, InviteView } from './invites/invites.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
