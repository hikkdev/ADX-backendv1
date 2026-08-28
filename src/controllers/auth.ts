import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { sendOtp, verifyOtp, normalizeMobile, sendEmailOtp, verifyEmailOtp } from '../services/otp.service';
import {
  signAccessToken,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  type SessionMeta,
} from '../services/token.service';
import { hashPassword, verifyPassword, createPasswordResetToken, consumePasswordResetToken } from '../services/password.service';
import { sendMail, passwordResetEmail } from '../services/mail.service';
import { logActivity } from '../services/activityLog.service';
import { assertAccountNotLocked, registerFailedLogin, clearFailedLogins } from '../services/loginSecurity.service';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import type { Role } from '../generated/prisma';

function sessionMeta(req: Request): SessionMeta {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

// Stamps the moment a session was established. Called from the login handlers
// only — refreshTokenHandler renews an existing session rather than starting a
// new one, so it deliberately leaves lastLoginAt untouched.
async function recordLogin(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
}

const sendOtpSchema = z.object({
  mobile: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number'),
});

const verifyOtpSchema = z.object({
  mobile: z.string(),
  otp: z.string().length(6),
});

const sendOtpEmailSchema = z.object({
  email: z.string().email(),
});

const verifyOtpEmailSchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(1),
});

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
    throw new ApiError(401, 'UNAUTHORIZED', err.message);
  }

  // Fetch user with roles
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true, agentProfile: true, publisherProfile: { include: { kyc: true } } },
  });

  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role);
  const accessToken = signAccessToken(userId, roles);
  const refreshToken = await createRefreshToken(userId, sessionMeta(req));
  await logActivity(userId, 'LOGIN_OTP', req);
  await recordLogin(userId);

  res.json({
    success: true,
    data: {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        email: user.email,
        language: user.language,
        avatarUrl: user.avatarUrl,
        hashPassword: !!user.passwordHash,
        roles,
        agentProfile: user.agentProfile,
        publisherProfile: user.publisherProfile,
      },
    },
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

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true, agentProfile: true, publisherProfile: { include: { kyc: true } } },
  });

  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role);
  const accessToken = signAccessToken(userId, roles);
  const refreshToken = await createRefreshToken(userId, sessionMeta(req));
  await logActivity(userId, 'LOGIN_OTP_EMAIL', req);
  await recordLogin(userId);

  res.json({
    success: true,
    data: {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        email: user.email,
        language: user.language,
        avatarUrl: user.avatarUrl,
        hasPassword: !!user.passwordHash,
        roles,
        agentProfile: user.agentProfile,
        publisherProfile: user.publisherProfile,
      },
    },
  });
}

export async function refreshTokenHandler(req: Request, res: Response): Promise<void> {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  let userId: string;
  let newRaw: string;
  try {
    ({ userId, newRaw } = await rotateRefreshToken(parsed.data.refreshToken, sessionMeta(req)));
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true },
  });

  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role) as Role[];
  const accessToken = signAccessToken(userId, roles);

  res.json({
    success: true,
    data: { accessToken, refreshToken: newRaw },
  });
}

export async function logoutHandler(req: Request, res: Response): Promise<void> {
  const parsed = logoutSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  await revokeRefreshToken(parsed.data.refreshToken);

  res.json({ success: true, data: { message: 'Logged out' } });
}

// ─── Email + password auth ────────────────────────────────────────────────────

const loginPasswordSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// POST /auth/login-password
export async function loginPasswordHandler(req: Request, res: Response): Promise<void> {
  const parsed = loginPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { email, password } = parsed.data;

  await assertAccountNotLocked(email);

  const user = await prisma.user.findUnique({
    where: { email },
    include: { roles: true, agentProfile: true, publisherProfile: { include: { kyc: true } } },
  });

  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    await registerFailedLogin(email);
    if (user) await logActivity(user.id, 'LOGIN_FAILED', req, { reason: 'invalid_password' });
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }

  if (!user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  await clearFailedLogins(email);
  const roles = user.roles.map((r) => r.role);
  const accessToken = signAccessToken(user.id, roles);
  const refreshToken = await createRefreshToken(user.id, sessionMeta(req));
  await logActivity(user.id, 'LOGIN_PASSWORD', req);
  await recordLogin(user.id);

  res.json({
    success: true,
    data: {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        mobile: user.mobile,
        name: user.name,
        email: user.email,
        language: user.language,
        avatarUrl: user.avatarUrl,
        hasPassword: true,
        roles,
        agentProfile: user.agentProfile,
        publisherProfile: user.publisherProfile,
      },
    },
  });
}

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

// POST /auth/forgot-password
// Always responds with a generic success message, whether or not the email
// is registered, so this endpoint can't be used to enumerate accounts.
export async function forgotPasswordHandler(req: Request, res: Response): Promise<void> {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  if (user) {
    const rawToken = await createPasswordResetToken(user.id);
    const resetUrl = `${env.FRONTEND_URL}/reset-password?token=${rawToken}`;
    const { subject, html } = passwordResetEmail(resetUrl);
    await sendMail(parsed.data.email, subject, html);
    await logActivity(user.id, 'PASSWORD_RESET_REQUESTED', req);
  }

  res.json({ success: true, data: { message: 'If that email is registered, a reset link has been sent.' } });
}

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

// POST /auth/reset-password
export async function resetPasswordHandler(req: Request, res: Response): Promise<void> {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  let userId: string;
  try {
    userId = await consumePasswordResetToken(parsed.data.token);
  } catch (err: any) {
    throw new ApiError(400, 'BAD_REQUEST', err.message);
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // A password reset invalidates all existing sessions as a precaution.
  await revokeAllRefreshTokens(userId);
  await logActivity(userId, 'PASSWORD_RESET', req);

  res.json({ success: true, data: { message: 'Password has been reset. Please log in again.' } });
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

// POST /auth/change-password (authenticated)
// If the user has no password set yet, `currentPassword` is not required —
// this doubles as the "set my initial password" flow.
export async function changePasswordHandler(req: Request, res: Response): Promise<void> {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const userId = req.user!.sub;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ApiError(404, 'NOT_FOUND', 'User not found');

  if (user.passwordHash) {
    if (!parsed.data.currentPassword || !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Current password is incorrect');
    }
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await logActivity(userId, 'PASSWORD_CHANGED', req);

  res.json({ success: true, data: { message: 'Password updated' } });
}

// ─── Publisher-specific auth ──────────────────────────────────────────────────

const publisherRegisterSchema = z.object({
  mobile: z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid mobile number'),
});

// POST /auth/publisher/send-otp
// For new publishers: creates user+publisher record, sends REGISTER OTP
// For returning publishers: sends LOGIN OTP (account must already exist with PUBLISHER role)
export async function publisherSendOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = publisherRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const normalized = normalizeMobile(parsed.data.mobile);

  // Check if user already exists
  const existing = await prisma.user.findUnique({
    where: { mobile: normalized },
    include: { roles: true },
  });

  if (existing) {
    const isPublisher = existing.roles.some((r) => r.role === 'PUBLISHER');
    if (!isPublisher) {
      throw new ApiError(403, 'FORBIDDEN', 'This number is not registered as a publisher.');
    }
    // Returning user — send LOGIN otp
    const otpResult = await sendOtp(normalized, 'LOGIN');
    res.json({ success: true, data: { message: 'OTP sent', ...otpResult } });
    return;
  } else {
    // New publisher — REGISTER creates user + sends otp
    const otpResult = await sendOtp(normalized, 'REGISTER');
    res.json({ success: true, data: { message: 'OTP sent', ...otpResult } });
    return;
  }
}

const publisherVerifyOtpSchema = z.object({
  mobile: z.string(),
  otp: z.string().length(6),
  // Required only on first registration (after OTP verified, store name etc.)
  name: z.string().min(1).optional(),
});

// POST /auth/publisher/verify-otp
export async function publisherVerifyOtpHandler(req: Request, res: Response): Promise<void> {
  const parsed = publisherVerifyOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  const { mobile, otp, name } = parsed.data;

  // Try REGISTER purpose first, fall back to LOGIN
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

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: true, publisherProfile: true },
  });

  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  // Update name if provided (first-time registration)
  if (name && !user.name) {
    await prisma.user.update({ where: { id: userId }, data: { name } });
  }

  const roles = user.roles.map((r) => r.role) as Role[];
  const accessToken = signAccessToken(userId, roles);
  const refreshToken = await createRefreshToken(userId);
  await recordLogin(userId);

  res.json({
    success: true,
    data: {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        mobile: user.mobile,
        name: name ?? user.name,
        email: user.email,
        language: user.language,
        roles,
        publisherProfile: user.publisherProfile,
      },
    },
  });
}
