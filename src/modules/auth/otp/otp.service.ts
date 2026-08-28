import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { redis } from '../../../shared/cache';
import { env } from '../../../config/env';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { sendSms } from '../../../shared/sms';
import { sendViaResend } from '../../../shared/email';
import type { OtpPurpose } from '../../../shared/database';
import { prismaOtpRepository as repository } from './prisma-otp.repository';

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

// Per-recipient send throttle, independent of the per-IP limiter in
// shared/security — without this, an attacker rotating IPs could still
// SMS/email-bomb one specific number/address, since each OTP's 5-guess cap
// (below) resets every time a fresh code is requested.
const OTP_SEND_LIMIT = 3;
const OTP_SEND_WINDOW_SECONDS = 10 * 60;

async function enforceOtpSendLimit(recipient: string): Promise<void> {
  const key = `otp-send:${recipient}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, OTP_SEND_WINDOW_SECONDS);
  if (count > OTP_SEND_LIMIT) {
    throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Too many OTP requests for this number. Please try again later.');
  }
}

// Canonicalize to +91XXXXXXXXXX regardless of what the client sends.
export function normalizeMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return mobile; // Already normalized or unknown format.
}

function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function isDevLoginMobileAllowed(mobile: string): boolean {
  if (env.NODE_ENV === 'production') return false;

  const allowedMobiles = env.DEV_LOGIN_MOBILES
    .split(',')
    .map((value) => normalizeMobile(value.trim()))
    .filter(Boolean);

  return allowedMobiles.includes(mobile);
}

function printDevOtp(recipient: string, code: string, purpose: string): void {
  if (env.NODE_ENV === 'production') return;
  console.warn('\n+--------------------------------------+');
  console.warn(`| OTP for ${recipient.padEnd(27)} |`);
  console.warn(`| Code: ${code} (${purpose.padEnd(8)})          |`);
  console.warn(`| Expires in ${String(OTP_TTL_MINUTES).padEnd(2)} minutes              |`);
  console.warn('+--------------------------------------+\n');
}

type SendOtpResult = {
  devOtp?: string;
};

export async function sendOtp(mobile: string, purpose: OtpPurpose = 'LOGIN'): Promise<SendOtpResult> {
  mobile = normalizeMobile(mobile);
  let user = await repository.findUserByMobile(mobile);

  if (purpose === 'REGISTER') {
    if (user) {
      throw new ApiError(409, 'CONFLICT', 'An account with this number already exists. Please log in instead.');
    }
    // Create the user record now so the OTP can reference it.
    const newUser = await repository.createPublisherUser(mobile);
    return sendOtpForUser(newUser.id, mobile, purpose);
  }

  if (!user && purpose === 'LOGIN' && isDevLoginMobileAllowed(mobile)) {
    logger.info('Creating dev login user from allowlist', { mobile });
    user = await repository.createDevLoginUser(mobile);
  }

  if (!user) {
    // Don't reveal whether this number has an account — respond the same
    // way a real send would. verifyOtp fails identically either way, so this
    // can't be used to enumerate registered numbers (same trade-off already
    // used by the forgot-password handler).
    logger.info('OTP requested for unregistered mobile', { mobile, purpose });
    return {};
  }

  return sendOtpForUser(user.id, mobile, purpose);
}

async function sendOtpForUser(userId: string, mobile: string, purpose: OtpPurpose): Promise<SendOtpResult> {
  await enforceOtpSendLimit(mobile);
  logger.info('OTP generation started', { userId, mobile, purpose });

  await repository.expireOutstandingByMobile(mobile, purpose);

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await repository.createForMobile({ userId, mobile, purpose, codeHash, expiresAt });

  printDevOtp(mobile, code, purpose);

  await sendSms(mobile, `Your ADX OTP is ${code}. Valid for ${OTP_TTL_MINUTES} minutes. Do not share this with anyone.`);
  logger.info('OTP dispatch completed', { userId, mobile, purpose, expiresAt });

  return env.NODE_ENV === 'production' ? {} : { devOtp: code };
}

// Email-delivered OTP login — an alternative channel to the mobile/SMS flow
// above, for accounts that already have an email on file. LOGIN only: unlike
// mobile OTP there's no self-registration path via email.
export async function sendEmailOtp(email: string): Promise<SendOtpResult> {
  const user = await repository.findUserByEmail(email);

  if (!user) {
    // Same enumeration trade-off as sendOtp above.
    logger.info('OTP requested for unregistered email', { email });
    return {};
  }

  await enforceOtpSendLimit(email);
  logger.info('Email OTP generation started', { userId: user.id, email });

  await repository.expireOutstandingByEmail(email);

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await repository.createForEmail({ userId: user.id, email, codeHash, expiresAt });

  printDevOtp(email, code, 'LOGIN');

  await sendViaResend(
    email,
    'Your ADX Admin login code',
    `<p>Your ADX login code is <strong>${code}</strong>. Valid for ${OTP_TTL_MINUTES} minutes. Do not share this with anyone.</p>`,
  );
  logger.info('Email OTP dispatch completed', { userId: user.id, email, expiresAt });

  return env.NODE_ENV === 'production' ? {} : { devOtp: code };
}

export async function verifyEmailOtp(email: string, code: string): Promise<string> {
  logger.info('Email OTP verification started', { email });

  const otp = await repository.findLatestUnverifiedByEmail(email);

  if (!otp) {
    logger.warn('Email OTP verification failed: not found or expired', { email });
    throw new Error('OTP expired or not found');
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    logger.warn('Email OTP verification failed: too many attempts', { email });
    throw new Error('Too many incorrect attempts');
  }

  if (!(await bcrypt.compare(code, otp.codeHash))) {
    await repository.incrementAttempts(otp.id);
    logger.warn('Email OTP verification failed: invalid code', { email });
    throw new Error('Invalid OTP');
  }

  await repository.markVerified(otp.id);

  logger.info('Email OTP verification completed', { email, userId: otp.userId });
  return otp.userId;
}

export async function verifyOtp(
  mobile: string,
  code: string,
  purpose: OtpPurpose = 'LOGIN',
): Promise<string> {
  mobile = normalizeMobile(mobile);
  logger.info('OTP verification started', { mobile, purpose });

  const otp = await repository.findLatestUnverifiedByMobile(mobile, purpose);

  if (!otp) {
    logger.warn('OTP verification failed: not found or expired', { mobile, purpose });
    throw new Error('OTP expired or not found');
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    logger.warn('OTP verification failed: too many attempts', { mobile, purpose });
    throw new Error('Too many incorrect attempts');
  }

  if (!(await bcrypt.compare(code, otp.codeHash))) {
    await repository.incrementAttempts(otp.id);
    logger.warn('OTP verification failed: invalid code', { mobile, purpose });
    throw new Error('Invalid OTP');
  }

  await repository.markVerified(otp.id);

  logger.info('OTP verification completed', { mobile, purpose, userId: otp.userId });
  return otp.userId;
}
