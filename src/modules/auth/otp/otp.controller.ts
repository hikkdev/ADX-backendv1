import { isWorkingUser } from '../../../shared/party-status';
import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { logActivity } from '../../../shared/audit';
import type { Role } from '../../../shared/database';
import {
  sendOtpSchema,
  verifyOtpSchema,
  sendOtpEmailSchema,
  verifyOtpEmailSchema,
} from '../auth.schema';
import { emailOtpLoginUser, mobileOtpLoginUser } from '../auth.mapper';
import { prismaAuthRepository as repository } from '../prisma-auth.repository';
import { sessionMeta, startSession } from '../auth.session';
import { OtpError } from './otp-security';
import { attachSignupEmail, sendEmailOtp, sendOtp, verifyEmailDoor, verifyOtp } from './otp.service';
import { adminSignInRequired, isAdmin, issueChallenge, issueChallengeAfterMobileOtp } from '../two-factor/two-factor.service';
import { isEnrolled } from '../two-factor/authenticator.service';

/**
 * Runs an OTP operation and, if it is refused with a wait, also says so in
 * the standard `Retry-After` header. The body already carries
 * `details.retryAfterSeconds`; the header is for clients that speak HTTP
 * before they speak ADX.
 */
async function withRetryAfter<T>(res: Response, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof OtpError && err.retryAfterSeconds !== undefined) {
      res.set('Retry-After', String(err.retryAfterSeconds));
    }
    throw err;
  }
}

export async function sendOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = sendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const otpResult = await withRetryAfter(res, () => sendOtp(parsed.data.mobile));

  res.json({ success: true, data: { message: 'OTP sent', ...otpResult } });
}

export async function verifyOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  // The service refuses with an OtpError — 401 with a machine-readable
  // `details.reason`, or 429 with `lockedUntil` when the number is locked.
  // Either passes through to the error handler as it is.
  const userId = await withRetryAfter(res, () => verifyOtp(parsed.data.mobile, parsed.data.otp));

  // ED-1: the phone step at the end of an email sign-up — the address the
  // token vouches for is written onto this account, before the account is
  // read for the answer, so the payload already carries it.
  const signup = parsed.data.signupToken ? await attachSignupEmail(userId, parsed.data.signupToken) : null;

  const user = await repository.findLoginUserById(userId);
  if (!user || !isWorkingUser(user)) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role) as Role[];

  // M-B: an ADMIN gets no tokens from a one-factor door. The code proved
  // the phone; the challenge asks for the rest (the app, or the email
  // backup — never SMS again), the same shape the password login answers,
  // or 403 ADMIN_SIGN_IN_REQUIRED when nothing can answer it.
  if (isAdmin(roles)) {
    const challenge = await issueChallengeAfterMobileOtp(user);
    await logActivity(userId, 'LOGIN_2FA_CHALLENGED', req, { method: 'otp' });
    res.json({ success: true, data: { challenge } });
    return;
  }
  // 2FA-A (the owner, 25 Sep 2026): any account that set up an authenticator
  // answers it after the phone — the app, or a recovery code; never SMS again.
  if (isEnrolled(user)) {
    const challenge = await issueChallenge(user, { methods: ['AUTHENTICATOR'] });
    await logActivity(userId, 'LOGIN_2FA_CHALLENGED', req, { method: 'otp', authenticator: true });
    res.json({ success: true, data: { challenge } });
    return;
  }

  const { accessToken, refreshToken } = await startSession(userId, roles, sessionMeta(req));
  await logActivity(userId, 'LOGIN_OTP', req);

  res.json({
    success: true,
    data: { accessToken, refreshToken, user: mobileOtpLoginUser(user, roles), ...(signup ? { signup } : {}) },
  });
}

// Email-delivered OTP (via Resend). ED-1: register-or-login like the mobile
// door — a known address signs its account in; an unknown one is a sign-up
// whose phone is proved next on /verify-otp with the signup token.
export async function sendOtpEmailHandler(req: Request, res: Response): Promise<void> {
  const parsed = sendOtpEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const otpResult = await withRetryAfter(res, () => sendEmailOtp(parsed.data.email));

  res.json({ success: true, data: { message: 'OTP sent', ...otpResult } });
}

export async function verifyOtpEmailHandler(req: Request, res: Response): Promise<void> {
  const parsed = verifyOtpEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const answer = await withRetryAfter(res, () => verifyEmailDoor(parsed.data.email, parsed.data.otp));
  if (answer.kind === 'signup') {
    const { signupToken, email, expiresInSeconds } = answer;
    res.json({ success: true, data: { signup: { signupToken, email, expiresInSeconds } } });
    return;
  }
  const { userId } = answer;

  const user = await repository.findLoginUserById(userId);
  if (!user || !isWorkingUser(user)) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role) as Role[];

  // M-B: the mailbox alone is the weakest thing an admin holds — it is the
  // counted backup of the second factor, not a first factor. The code is
  // already spent; the answer names the console login.
  if (isAdmin(roles)) {
    await logActivity(userId, 'LOGIN_FAILED', req, { method: 'otp_email', reason: 'ADMIN_SIGN_IN_REQUIRED' });
    throw adminSignInRequired();
  }
  // 2FA-A: the mailbox is one factor; an enrolled account answers the app before tokens.
  if (isEnrolled(user)) {
    const challenge = await issueChallenge(user, { methods: ['AUTHENTICATOR'] });
    await logActivity(userId, 'LOGIN_2FA_CHALLENGED', req, { method: 'otp_email', authenticator: true });
    res.json({ success: true, data: { challenge } });
    return;
  }

  const { accessToken, refreshToken } = await startSession(userId, roles, sessionMeta(req));
  await logActivity(userId, 'LOGIN_OTP_EMAIL', req);

  res.json({
    success: true,
    data: { accessToken, refreshToken, user: emailOtpLoginUser(user, roles) },
  });
}
