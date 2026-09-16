import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { verifyCaptcha } from '../../shared/security';
import {
  passwordAuthLimiter,
  googleAuthLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  refreshLimiter,
} from '../../shared/security';
import {
  sendOtpHandler,
  verifyOtpHandler,
  sendOtpEmailHandler,
  verifyOtpEmailHandler,
} from './otp/otp.controller';
import { refreshTokenHandler, logoutHandler } from './tokens/tokens.controller';
import {
  loginPasswordHandler,
  forgotPasswordHandler,
  resetPasswordHandler,
  changePasswordHandler,
} from './password/password.controller';
import {
  publisherSendOtpHandler,
  publisherVerifyOtpHandler,
} from './publisher/publisher-auth.controller';
import { googleLoginHandler } from './google/google.controller';
import {
  confirmTotpHandler,
  disableTotpHandler,
  enrolTotpHandler,
  regenerateRecoveryCodesHandler,
  sendTwoFactorHandler,
  twoFactorStatusHandler,
  verifyTwoFactorHandler,
} from './two-factor/two-factor.controller';
import { acceptInviteHandler, describeInviteHandler } from './invites/invites.controller';
import {
  startHandler as startMobileChangeHandler,
  confirmOldHandler as confirmOldMobileHandler,
  verifyHandler as verifyMobileChangeHandler,
} from './mobile-change/mobile-change.controller';

export const authRouter = Router();

// Captcha guards the "request" endpoints (where scripted abuse pays off) —
// not verify/reset-consume/refresh, which either require a secret already in
// hand or gain nothing from a per-request bot check.
authRouter.post('/send-otp', otpRequestLimiter, verifyCaptcha, asyncHandler(sendOtpHandler));
authRouter.post('/verify-otp', otpVerifyLimiter, asyncHandler(verifyOtpHandler));
authRouter.post('/send-otp-email', otpRequestLimiter, verifyCaptcha, asyncHandler(sendOtpEmailHandler));
authRouter.post('/verify-otp-email', otpVerifyLimiter, asyncHandler(verifyOtpEmailHandler));
authRouter.post('/refresh', refreshLimiter, asyncHandler(refreshTokenHandler));
authRouter.post('/logout', refreshLimiter, asyncHandler(logoutHandler));

// Email + password login
authRouter.post('/login-password', passwordAuthLimiter, verifyCaptcha, asyncHandler(loginPasswordHandler));
authRouter.post('/forgot-password', passwordAuthLimiter, verifyCaptcha, asyncHandler(forgotPasswordHandler));
authRouter.post('/reset-password', passwordAuthLimiter, asyncHandler(resetPasswordHandler));
authRouter.post('/change-password', authenticate, asyncHandler(changePasswordHandler));

/* Changing the number the account signs in with. Signed in throughout — this
 * is not a recovery path for a number somebody has lost — and rate-limited
 * like the OTP endpoints it wraps, because each step sends or checks one.
 * Lot F (Q18): two codes, in order — start codes the CURRENT number,
 * confirm-old checks it and codes the NEW one, verify checks that. */
authRouter.post('/change-mobile/start', authenticate, otpRequestLimiter, asyncHandler(startMobileChangeHandler));
authRouter.post('/change-mobile/confirm-old', authenticate, otpVerifyLimiter, otpRequestLimiter, asyncHandler(confirmOldMobileHandler));
authRouter.post('/change-mobile/verify', authenticate, otpVerifyLimiter, asyncHandler(verifyMobileChangeHandler));

// Google Workspace sign-in. No verifyCaptcha: the caller has already completed
// Google's own account challenge, so a Turnstile check on top only adds a way
// for the flow to fail. Authentication happens against Google's JWKS; this
// endpoint never provisions an account.
authRouter.post('/google', googleAuthLimiter, asyncHandler(googleLoginHandler));

/* Lot A (Q25): the admin second factor. An ADMIN's password or Google sign-in
 * answers with a challenge instead of tokens; these two finish it. Anonymous —
 * the challenge token IS the credential — and rate-limited like the OTP
 * endpoints they wrap, because one of them sends a code. */
authRouter.post('/2fa/send', otpRequestLimiter, asyncHandler(sendTwoFactorHandler));
authRouter.post('/2fa/verify', otpVerifyLimiter, asyncHandler(verifyTwoFactorHandler));

/* Lot K2: the authenticator app. Signed in — these are the admin's own
 * settings — and the code-taking ones rate-limited like a verify, because a
 * confirm, a disable and a regenerate each check one. `/2fa/status` is open
 * to any signed-in account (a non-admin reads an empty method list). */
authRouter.post('/2fa/totp/enrol', authenticate, requireRole('ADMIN'), otpRequestLimiter, asyncHandler(enrolTotpHandler));
authRouter.post('/2fa/totp/confirm', authenticate, requireRole('ADMIN'), otpVerifyLimiter, asyncHandler(confirmTotpHandler));
authRouter.post('/2fa/totp/disable', authenticate, requireRole('ADMIN'), otpVerifyLimiter, asyncHandler(disableTotpHandler));
authRouter.post('/2fa/recovery-codes/regenerate', authenticate, requireRole('ADMIN'), otpVerifyLimiter, asyncHandler(regenerateRecoveryCodesHandler));
authRouter.get('/2fa/status', authenticate, asyncHandler(twoFactorStatusHandler));

/* Lot A (Q26): accepting an invitation to the console. Anonymous by
 * necessity — there is no account yet — and the token in the link is the only
 * thing that proves the caller was invited. The accept endpoint sends an OTP
 * on its first call, so it carries the OTP request limiter. */
authRouter.get('/invites/:token', asyncHandler(describeInviteHandler));
authRouter.post('/accept-invite', otpRequestLimiter, asyncHandler(acceptInviteHandler));

// Publisher self-registration / login
authRouter.post('/publisher/send-otp', otpRequestLimiter, verifyCaptcha, asyncHandler(publisherSendOtpHandler));
authRouter.post('/publisher/verify-otp', otpVerifyLimiter, asyncHandler(publisherVerifyOtpHandler));
