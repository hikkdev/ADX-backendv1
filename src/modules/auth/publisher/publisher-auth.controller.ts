import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import type { Role } from '../../../shared/database';
import { publisherRegisterSchema, publisherVerifyOtpSchema } from '../auth.schema';
import { publisherLoginUser } from '../auth.mapper';
import { prismaAuthRepository as repository } from '../prisma-auth.repository';
import { issueRefreshToken } from '../tokens/tokens.service';
import { OtpError } from '../otp/otp-security';
import { normalizeMobile, sendOtp, verifyOtp } from '../otp/otp.service';
import { logActivity } from '../../../shared/audit';
import { adminSignInRequired } from '../two-factor/two-factor.service';

/**
 * POST /auth/publisher/send-otp
 *
 * For new publishers: REGISTER creates the user + publisher record and sends
 * the OTP. For returning publishers: LOGIN, which requires the account to
 * already hold the PUBLISHER role.
 */
export async function publisherSendOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = publisherRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const normalized = normalizeMobile(parsed.data.mobile);
  const existing = await repository.findByMobileWithRoles(normalized);

  if (existing) {
    // An existing non-publisher account is rejected outright rather than
    // silently granted the role.
    if (!existing.roles.some((r) => r.role === 'PUBLISHER')) {
      throw new ApiError(403, 'FORBIDDEN', 'This number is not registered as a publisher.');
    }
    const otpResult = await sendOtp(normalized, 'LOGIN');
    res.json({ success: true, data: { message: 'OTP sent', ...otpResult } });
    return;
  }

  const otpResult = await sendOtp(normalized, 'REGISTER');
  res.json({ success: true, data: { message: 'OTP sent', ...otpResult } });
}

export async function publisherVerifyOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = publisherVerifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { mobile, otp, name } = parsed.data;

  // The client does not say whether this is a registration or a login, so
  // REGISTER is tried first and LOGIN second. Only "no REGISTER code exists"
  // falls through: a wrong guess against a live REGISTER code, or a locked
  // number, is that answer and must not be retried as a LOGIN.
  let userId: string;
  try {
    userId = await verifyOtp(mobile, otp, 'REGISTER');
  } catch (err) {
    if (err instanceof OtpError && err.reason !== 'OTP_EXPIRED') throw err;
    userId = await verifyOtp(mobile, otp, 'LOGIN');
  }

  const user = await repository.findPublisherLoginUserById(userId);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  // Only fills a blank name — a submitted name never overwrites a stored one.
  if (name && !user.name) {
    await repository.setName(userId, name);
  }

  const roles = user.roles.map((r) => r.role) as Role[];
  // M-B: this door falls back to the LOGIN code the ordinary send issues,
  // so it is the mobile OTP door under another name — and the publisher app
  // cannot draw a challenge. An ADMIN is sent to the console login.
  if (roles.includes('ADMIN')) {
    await logActivity(userId, 'LOGIN_FAILED', req, { method: 'publisher_otp', reason: 'ADMIN_SIGN_IN_REQUIRED' });
    throw adminSignInRequired();
  }
  // No session metadata is captured here, and lastLoginAt is still stamped —
  // matching the original handler, which called createRefreshToken() bare.
  const { raw: refreshToken, sessionId } = await issueRefreshToken(userId);
  const accessToken = signAccessToken(userId, roles, sessionId);
  await repository.recordLogin(userId);

  res.json({
    success: true,
    data: { accessToken, refreshToken, user: publisherLoginUser(user, roles, name) },
  });
}
