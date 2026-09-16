import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { env } from '../../../config/env';
import { logActivity } from '../../../shared/audit';
import { passwordResetEmail, sendEmail } from '../../../shared/email';
import type { Role } from '../../../shared/database';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginPasswordSchema,
  resetPasswordSchema,
} from '../auth.schema';
import { passwordLoginUser } from '../auth.mapper';
import { prismaAuthRepository as repository } from '../prisma-auth.repository';
import { sessionMeta, startSession } from '../auth.session';
import { revokeSessions } from '../tokens/tokens.service';
import {
  consumePasswordResetToken,
  createPasswordResetToken,
  hashPassword,
  verifyPassword,
} from './password.service';
import { isAdmin, issueChallenge } from '../two-factor/two-factor.service';
import {
  assertAccountNotLocked,
  clearFailedLogins,
  registerFailedLogin,
} from './login-security.service';

export async function loginPasswordHandler(req: Request, res: Response): Promise<void> {
  const parsed = loginPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { email, password } = parsed.data;

  await assertAccountNotLocked(email);

  const user = await repository.findLoginUserByEmail(email);

  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    // One message for unknown account, no password set and wrong password, so
    // the endpoint cannot be used to enumerate registered emails.
    await registerFailedLogin(email);
    if (user) await logActivity(user.id, 'LOGIN_FAILED', req, { reason: 'invalid_password' });
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }

  if (!user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  await clearFailedLogins(email);
  const roles = user.roles.map((r) => r.role) as Role[];

  // Lot A (Q25): an admin's password is only the first factor. No tokens are
  // issued here — the challenge names the account for five minutes and the
  // second factor finishes the sign-in at /auth/2fa/verify. Everyone else is
  // unaffected: a publisher's OTP already was a second factor.
  if (isAdmin(roles)) {
    const challenge = await issueChallenge(user);
    await logActivity(user.id, 'LOGIN_2FA_CHALLENGED', req, { method: 'password' });
    res.json({ success: true, data: { challenge } });
    return;
  }

  // Independent writes: the audit row does not feed the session, and the
  // session does not read the audit row. Awaiting both together keeps the
  // audit durability guarantee (a silently dropped login record would matter)
  // while spending one round trip instead of two.
  const [{ accessToken, refreshToken }] = await Promise.all([
    startSession(user.id, roles, sessionMeta(req)),
    logActivity(user.id, 'LOGIN_PASSWORD', req),
  ]);

  res.json({
    success: true,
    data: { accessToken, refreshToken, user: passwordLoginUser(user, roles) },
  });
}

/**
 * Always responds with the same generic message, whether or not the email is
 * registered, so this endpoint cannot be used to enumerate accounts.
 */
export async function forgotPasswordHandler(req: Request, res: Response): Promise<void> {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const user = await repository.findByEmail(parsed.data.email);

  if (user) {
    const rawToken = await createPasswordResetToken(user.id);
    const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${rawToken}`;
    const { subject, html } = passwordResetEmail(resetUrl);
    // AE-B: by the one door — SMTP, Resend or the Ethereal inbox, as the row says.
    await sendEmail(parsed.data.email, subject, html);
    await logActivity(user.id, 'PASSWORD_RESET_REQUESTED', req);
  }

  res.json({
    success: true,
    data: { message: 'If that email is registered, a reset link has been sent.' },
  });
}

export async function resetPasswordHandler(req: Request, res: Response): Promise<void> {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  let userId: string;
  try {
    userId = await consumePasswordResetToken(parsed.data.token);
  } catch (err: any) {
    // 400, not 401: the token is malformed or spent, not a failed credential.
    throw new ApiError(400, 'BAD_REQUEST', err.message);
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await repository.setPasswordHash(userId, passwordHash);

  // A password reset ends every session — the refresh tokens AND the access
  // tokens still in flight, through the revocation marker authenticate()
  // reads. Refresh tokens alone left an attacker's access token good for its
  // whole lifetime after the victim reset their password (Lot A verifier).
  await revokeSessions(userId, 'PASSWORD_RESET');
  await logActivity(userId, 'PASSWORD_RESET', req);

  res.json({
    success: true,
    data: { message: 'Password has been reset. Please log in again.' },
  });
}

/**
 * Authenticated password change. When the account has no password yet,
 * `currentPassword` is not required — this doubles as the "set my initial
 * password" flow for accounts created via OTP.
 *
 * Unlike reset, this deliberately does NOT revoke other sessions.
 */
export async function changePasswordHandler(req: Request, res: Response): Promise<void> {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const userId = req.user!.sub;
  const user = await repository.findById(userId);
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  if (user.passwordHash) {
    if (
      !parsed.data.currentPassword ||
      !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))
    ) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Current password is incorrect');
    }
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await repository.setPasswordHash(userId, passwordHash);
  await logActivity(userId, 'PASSWORD_CHANGED', req);

  res.json({ success: true, data: { message: 'Password updated' } });
}
