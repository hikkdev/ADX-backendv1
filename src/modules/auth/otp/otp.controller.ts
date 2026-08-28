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
import { sendEmailOtp, sendOtp, verifyEmailOtp, verifyOtp } from './otp.service';

export async function sendOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = sendOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const otpResult = await sendOtp(parsed.data.mobile);

  res.json({ success: true, data: { message: 'OTP sent', ...otpResult } });
}

export async function verifyOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = verifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  let userId: string;
  try {
    userId = await verifyOtp(parsed.data.mobile, parsed.data.otp);
  } catch (err: any) {
    // The service throws plain Errors; every failure mode is reported as 401
    // so a wrong code is indistinguishable from an unknown number.
    throw new ApiError(401, 'UNAUTHORIZED', err.message);
  }

  const user = await repository.findLoginUserById(userId);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role) as Role[];
  const { accessToken, refreshToken } = await startSession(userId, roles, sessionMeta(req));
  await logActivity(userId, 'LOGIN_OTP', req);

  res.json({
    success: true,
    data: { accessToken, refreshToken, user: mobileOtpLoginUser(user, roles) },
  });
}

// Email-delivered OTP login (via Resend) — an alternative to the phone/SMS
// OTP flow above, for accounts that already have an email on file.
export async function sendOtpEmailHandler(req: Request, res: Response): Promise<void> {
  const parsed = sendOtpEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const otpResult = await sendEmailOtp(parsed.data.email);

  res.json({ success: true, data: { message: 'OTP sent', ...otpResult } });
}

export async function verifyOtpEmailHandler(req: Request, res: Response): Promise<void> {
  const parsed = verifyOtpEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  let userId: string;
  try {
    userId = await verifyEmailOtp(parsed.data.email, parsed.data.otp);
  } catch (err: any) {
    throw new ApiError(401, 'UNAUTHORIZED', err.message);
  }

  const user = await repository.findLoginUserById(userId);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role) as Role[];
  const { accessToken, refreshToken } = await startSession(userId, roles, sessionMeta(req));
  await logActivity(userId, 'LOGIN_OTP_EMAIL', req);

  res.json({
    success: true,
    data: { accessToken, refreshToken, user: emailOtpLoginUser(user, roles) },
  });
}
