import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { ApiError } from '../lib/errors';
import { logger } from '../lib/logger';
import { sendSms } from './sms.service';
import { sendViaResend } from './resend.service';
import type { OtpPurpose } from '../generated/prisma';

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

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

async function createDevLoginUser(mobile: string) {
  logger.info('Creating dev login user from allowlist', { mobile });

  return prisma.user.create({
    data: {
      mobile,
      name: `Dev Login ${mobile.slice(-4)}`,
      roles: { create: { role: 'AGENT_PUBLISHER' } },
      agentProfile: { create: {} },
    },
  });
}

type SendOtpResult = {
  devOtp?: string;
};

export async function sendOtp(mobile: string, purpose: OtpPurpose = 'LOGIN'): Promise<SendOtpResult> {
  mobile = normalizeMobile(mobile);
  let user = await prisma.user.findUnique({ where: { mobile } });

  if (purpose === 'REGISTER') {
    if (user) {
      throw new ApiError(409, 'CONFLICT', 'An account with this number already exists. Please log in instead.');
    }
    // Create the user record now so the OTP can reference it.
    const newUser = await prisma.user.create({
      data: {
        mobile,
        roles: { create: { role: 'PUBLISHER' } },
      },
    });
    return _sendOtpForUser(newUser.id, mobile, purpose);
  }

  if (!user) {
    if (purpose === 'LOGIN' && isDevLoginMobileAllowed(mobile)) {
      user = await createDevLoginUser(mobile);
    } else {
      throw new ApiError(403, 'FORBIDDEN', 'No account found for this number. Contact your administrator.');
    }
  }

  if (!user) {
    throw new ApiError(403, 'FORBIDDEN', 'No account found for this number. Contact your administrator.');
  }

  return _sendOtpForUser(user.id, mobile, purpose);
}

async function _sendOtpForUser(userId: string, mobile: string, purpose: OtpPurpose): Promise<SendOtpResult> {
  logger.info('OTP generation started', { userId, mobile, purpose });

  await prisma.otp.updateMany({
    where: { mobile, purpose, verifiedAt: null },
    data: { expiresAt: new Date() },
  });

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await prisma.otp.create({
    data: { userId, mobile, purpose, codeHash, expiresAt },
  });

  if (env.NODE_ENV !== 'production') {
    console.warn('\n+--------------------------------------+');
    console.warn(`| OTP for ${mobile.padEnd(27)} |`);
    console.warn(`| Code: ${code} (${purpose.padEnd(8)})          |`);
    console.warn(`| Expires in ${String(OTP_TTL_MINUTES).padEnd(2)} minutes              |`);
    console.warn('+--------------------------------------+\n');
  }

  await sendSms(mobile, `Your ADX OTP is ${code}. Valid for ${OTP_TTL_MINUTES} minutes. Do not share this with anyone.`);
  logger.info('OTP dispatch completed', { userId, mobile, purpose, expiresAt });

  return env.NODE_ENV === 'production' ? {} : { devOtp: code };
}

// Email-delivered OTP login — an alternative channel to the mobile/SMS flow
// above, for accounts that already have an email on file. LOGIN only: unlike
// mobile OTP there's no self-registration path via email.
export async function sendEmailOtp(email: string): Promise<SendOtpResult> {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    throw new ApiError(403, 'FORBIDDEN', 'No account found for this email. Contact your administrator.');
  }

  logger.info('Email OTP generation started', { userId: user.id, email });

  await prisma.otp.updateMany({
    where: { email, purpose: 'LOGIN', verifiedAt: null },
    data: { expiresAt: new Date() },
  });

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await prisma.otp.create({
    data: { userId: user.id, email, purpose: 'LOGIN', codeHash, expiresAt },
  });

  if (env.NODE_ENV !== 'production') {
    console.warn('\n+--------------------------------------+');
    console.warn(`| OTP for ${email.padEnd(27)} |`);
    console.warn(`| Code: ${code} (LOGIN)          |`);
    console.warn(`| Expires in ${String(OTP_TTL_MINUTES).padEnd(2)} minutes              |`);
    console.warn('+--------------------------------------+\n');
  }

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

  const otp = await prisma.otp.findFirst({
    where: {
      email,
      purpose: 'LOGIN',
      verifiedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) {
    logger.warn('Email OTP verification failed: not found or expired', { email });
    throw new Error('OTP expired or not found');
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    logger.warn('Email OTP verification failed: too many attempts', { email });
    throw new Error('Too many incorrect attempts');
  }

  const isValid = await bcrypt.compare(code, otp.codeHash);

  if (!isValid) {
    await prisma.otp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    logger.warn('Email OTP verification failed: invalid code', { email });
    throw new Error('Invalid OTP');
  }

  await prisma.otp.update({
    where: { id: otp.id },
    data: { verifiedAt: new Date() },
  });

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

  const otp = await prisma.otp.findFirst({
    where: {
      mobile,
      purpose,
      verifiedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) {
    logger.warn('OTP verification failed: not found or expired', { mobile, purpose });
    throw new Error('OTP expired or not found');
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    logger.warn('OTP verification failed: too many attempts', { mobile, purpose });
    throw new Error('Too many incorrect attempts');
  }

  const isValid = await bcrypt.compare(code, otp.codeHash);

  if (!isValid) {
    await prisma.otp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    logger.warn('OTP verification failed: invalid code', { mobile, purpose });
    throw new Error('Invalid OTP');
  }

  await prisma.otp.update({
    where: { id: otp.id },
    data: { verifiedAt: new Date() },
  });

  logger.info('OTP verification completed', { mobile, purpose, userId: otp.userId });
  return otp.userId;
}
