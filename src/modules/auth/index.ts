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
 */
export { authRouter } from './auth.routes';

export {
  createRefreshToken,
  revokeAllRefreshTokens,
  listActiveSessions,
  revokeSessionById,
} from './tokens/tokens.service';
export type { SessionMeta } from './tokens/tokens.service';

export { hashPassword, verifyPassword } from './password/password.service';

export { sendOtp, verifyOtp, normalizeMobile } from './otp/otp.service';
