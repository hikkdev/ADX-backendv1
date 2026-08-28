import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import type { Role } from '../../../shared/database';
import { publisherRegisterSchema, publisherVerifyOtpSchema } from '../auth.schema';
import { publisherLoginUser } from '../auth.mapper';
import { prismaAuthRepository as repository } from '../prisma-auth.repository';
import { createRefreshToken } from '../tokens/tokens.service';
import { normalizeMobile, sendOtp, verifyOtp } from '../otp/otp.service';

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
  // REGISTER is tried first and LOGIN second.
  let userId: string;
  try {
    userId = await verifyOtp(mobile, otp, 'REGISTER');
  } catch {
    try {
      userId = await verifyOtp(mobile, otp, 'LOGIN');
    } catch (err: any) {
      throw new ApiError(401, 'UNAUTHORIZED', err.message);
    }
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
  const accessToken = signAccessToken(userId, roles);
  // No session metadata is captured here, and lastLoginAt is still stamped —
  // matching the original handler, which called createRefreshToken() bare.
  const refreshToken = await createRefreshToken(userId);
  await repository.recordLogin(userId);

  res.json({
    success: true,
    data: { accessToken, refreshToken, user: publisherLoginUser(user, roles, name) },
  });
}
