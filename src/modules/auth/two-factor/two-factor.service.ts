import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../../../config/env';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { logActivity } from '../../../shared/audit';
import { notify } from '../../notifications';
import type { Role } from '../../../shared/database';
import { normalizeMobile, sendOtp, verifyOtp } from '../otp/otp.service';
import { OtpError, reserveOtpSend } from '../otp/otp-security';
import { prismaTwoFactorRepository as repository, type TwoFactorUser } from './prisma-two-factor.repository';
import { CODE_ALPHABET, TWO_FACTOR_METHODS, type TwoFactorMethod } from './two-factor.schema';
import {
  adminTwoFactorPolicy,
  appCodeExpiresInSeconds,
  isEnrolled,
  looksLikeAppCode,
  looksLikeRecoveryCode,
  spendRecoveryCode,
  verifyAppCode,
} from './authenticator.service';

/**
 * The admin second factor — Lot A, Q25.
 *
 * An account holding ADMIN does not get tokens from a password or a Google
 * sign-in. It gets a **challenge**: a five-minute token that names the account
 * and nothing else, and which `authenticate()` refuses outright (it carries
 * `purpose`, and verifyAccessToken rejects any token that does). Tokens come
 * only from `POST /auth/2fa/verify`, after a code sent to the phone — or, as a
 * backup, to the email.
 *
 * The backup is the hijack risk: an attacker who has the password and the
 * mailbox but not the phone would otherwise be through. So email is counted.
 * `ADMIN_EMAIL_OTP_FALLBACK_LIMIT` uses in a rolling 30 days and the channel
 * is refused with `MOBILE_VERIFICATION_REQUIRED` until somebody either passes
 * an SMS challenge (which resets the count) or an admin resets it from the
 * desk. The count is per account, not per session, on purpose.
 *
 * The email code is ten characters from an alphabet with no 0/O and no 1/I,
 * because it is read off a screen and typed by hand; the SMS code is the
 * ordinary six digits, sent through the OTP service so it inherits the same
 * per-number resend budget and lockout as every other code ADX sends.
 *
 * Lot K2: an authenticator app (`authenticator.service.ts`) is the third
 * channel. Enrolled, it is listed first; the policy in platform settings
 * (`auth.adminTwoFactor`) can make it the only one and can require every
 * admin to enrol.
 */

export const CHALLENGE_PURPOSE = '2fa';
export const CHALLENGE_TTL_SECONDS = 5 * 60;
/** No 0/O, no 1/I — a code somebody reads off a screen and types. */
export const EMAIL_CODE_ALPHABET = CODE_ALPHABET;
export const EMAIL_CODE_LENGTH = 10;
export const EMAIL_CODE_TTL_MINUTES = 10;
/** Wrong guesses one email code will take. */
const MAX_ATTEMPTS = 5;
export const FALLBACK_WINDOW_DAYS = 30;

type ChallengeClaims = {
  sub: string;
  purpose: typeof CHALLENGE_PURPOSE;
  /**
   * M-B: the channels this challenge may be answered on, when the door that
   * issued it has already spent one. Absent on a password or Google
   * challenge — those are bounded by the policy alone. `/2fa/send` and
   * `/2fa/verify` refuse a channel outside the list; a recovery code is
   * not a channel and works regardless.
   */
  methods?: TwoFactorMethod[];
};

export type ChallengeReading = { userId: string; methods: TwoFactorMethod[] | null };

export type TwoFactorChallenge = {
  challengeToken: string;
  methods: TwoFactorMethod[];
  maskedMobile: string | null;
  maskedEmail: string | null;
};

/** `+919845012210` → `+91 ***** 2210`. Enough to recognise, not enough to dial. */
export function maskMobile(mobile: string | null | undefined): string | null {
  if (!mobile) return null;
  const tail = mobile.slice(-4);
  const head = mobile.startsWith('+') ? mobile.slice(0, 3) : '';
  return `${head} ***** ${tail}`.trim();
}

/** `asha.rao@adx.co` → `a******o@adx.co`. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 2) return `${local[0]}***${domain}`;
  return `${local[0]}${'*'.repeat(Math.max(1, local.length - 2))}${local[local.length - 1]}${domain}`;
}

export function isAdmin(roles: { role: Role }[] | Role[]): boolean {
  return (roles as Array<{ role: Role } | Role>).some((entry) =>
    typeof entry === 'string' ? entry === 'ADMIN' : entry.role === 'ADMIN',
  );
}

function signChallenge(userId: string, methods?: TwoFactorMethod[]): string {
  const claims: ChallengeClaims = { sub: userId, purpose: CHALLENGE_PURPOSE, ...(methods ? { methods } : {}) };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: CHALLENGE_TTL_SECONDS });
}

/** The account a live challenge names, and (M-B) the channels it is bounded to, if any. */
export function readChallengeClaims(token: string): ChallengeReading {
  let claims: ChallengeClaims;
  try {
    claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as ChallengeClaims;
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'This sign-in has expired. Start again.');
  }
  if (claims?.purpose !== CHALLENGE_PURPOSE || typeof claims.sub !== 'string') {
    throw new ApiError(401, 'UNAUTHORIZED', 'This sign-in has expired. Start again.');
  }
  const methods = Array.isArray(claims.methods)
    ? claims.methods.filter((m): m is TwoFactorMethod => (TWO_FACTOR_METHODS as readonly string[]).includes(m))
    : null;
  return { userId: claims.sub, methods };
}

export function readChallenge(token: string): string {
  return readChallengeClaims(token).userId;
}

/**
 * The challenge a login handler returns instead of tokens.
 *
 * Also the moment `twoFactorRequiredAt` is stamped: an admin who has been
 * challenged once is an admin for whom the second factor is on, and the
 * column is what the console reads to say so.
 */
export async function issueChallenge(
  user: { id: string; mobile: string; email: string | null },
  options: { methods?: TwoFactorMethod[] } = {},
): Promise<TwoFactorChallenge> {
  await repository.stampTwoFactorRequired(user.id);
  const methods = options.methods ?? (await availableMethods(user.id, user.email));
  return {
    challengeToken: signChallenge(user.id, options.methods),
    methods,
    maskedMobile: maskMobile(user.mobile),
    maskedEmail: maskEmail(user.email),
  };
}

/**
 * M-B: the challenge `POST /auth/verify-otp` answers an ADMIN instead of
 * tokens. The code just entered proved the phone — it is the SMS factor,
 * and only that, and only when the policy lets this account use SMS at all
 * (`authenticatorRequired` off, and either no enrolment or
 * `smsAllowedWhenEnrolled`). Then the challenge lists what is left: the app
 * when enrolled, the email backup while it lasts — never SMS again, which
 * would make one phone both factors. Under a policy that does not allow
 * SMS the code bought nothing and the challenge is AUTHENTICATOR alone.
 * When nothing can answer — no enrolment under a required policy, or no
 * email left beside an un-enrolled account — the door is closed with 403
 * ADMIN_SIGN_IN_REQUIRED naming the console login, and no challenge is
 * issued.
 */
export async function issueChallengeAfterMobileOtp(user: {
  id: string;
  mobile: string;
  email: string | null;
}): Promise<TwoFactorChallenge> {
  const row = await repository.findUser(user.id);
  if (!row) throw adminSignInRequired();
  const policy = await adminTwoFactorPolicy();
  const enrolled = isEnrolled(row);
  const smsAllowed = !policy.authenticatorRequired && (!enrolled || policy.smsAllowedWhenEnrolled);
  let methods: TwoFactorMethod[];
  if (smsAllowed) {
    methods = (await availableMethods(user.id, user.email)).filter((m) => m !== 'SMS');
  } else {
    methods = enrolled ? ['AUTHENTICATOR'] : [];
  }
  if (methods.length === 0) throw adminSignInRequired();
  return issueChallenge(user, { methods });
}

/** The refusal every one-factor door gives an ADMIN: the console login is the way in. */
export function adminSignInRequired(): ApiError {
  return new ApiError(
    403,
    'ADMIN_SIGN_IN_REQUIRED',
    'Admin accounts sign in at the console with their email and password (or Google), then the second factor.',
    { loginAt: '/api/v1/auth/login-password', methods: ['PASSWORD', 'GOOGLE'] },
  );
}

function outsideChallenge(methods: TwoFactorMethod[]): ApiError {
  return new ApiError(403, 'FORBIDDEN', 'This sign-in cannot be finished on that channel.', { methods });
}

/**
 * Which channels this account may still use. Email drops off the list once
 * the fallback budget is spent, so the screen never offers a button that
 * answers 403. Lot K2: an enrolled authenticator app comes first, and when
 * the policy's `smsAllowedWhenEnrolled` is off it is the only entry — a
 * recovery code works regardless, it is not a channel.
 */
export async function availableMethods(userId: string, email: string | null): Promise<TwoFactorMethod[]> {
  const user = await repository.findUser(userId);
  const sent: TwoFactorMethod[] = !email || (user && fallbackSpent(user)) ? ['SMS'] : ['SMS', 'EMAIL'];
  if (!user || !isEnrolled(user)) return sent;
  const policy = await adminTwoFactorPolicy();
  return policy.smsAllowedWhenEnrolled ? ['AUTHENTICATOR', ...sent] : ['AUTHENTICATOR'];
}

function windowStart(now = new Date()): Date {
  return new Date(now.getTime() - FALLBACK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** True when the counter is at the limit and its 30-day window has not lapsed. */
function fallbackSpent(user: TwoFactorUser, now = new Date()): boolean {
  const resetAt = user.emailOtpFallbackResetAt;
  if (!resetAt || resetAt < windowStart(now)) return false;
  return user.emailOtpFallbackCount >= env.ADMIN_EMAIL_OTP_FALLBACK_LIMIT;
}

async function requireAdmin(userId: string): Promise<TwoFactorUser> {
  const user = await repository.findUser(userId);
  if (!user || !user.isActive) throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  if (!isAdmin(user.roles)) throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  return user;
}

export type SendResult = {
  method: TwoFactorMethod;
  expiresInSeconds: number;
  resendAfterSeconds?: number;
  sendsRemaining?: number;
  /** Outside production only, like the OTP endpoints. */
  devCode?: string;
};

/** POST /auth/2fa/send. */
export async function sendTwoFactorCode(challengeToken: string, method: TwoFactorMethod): Promise<SendResult> {
  const { userId, methods: allowed } = readChallengeClaims(challengeToken);
  const user = await requireAdmin(userId);
  // M-B: a challenge bounded by the door that issued it (the mobile OTP door
  // has spent SMS) refuses a channel outside its list before anything is sent.
  if (allowed && !allowed.includes(method)) throw outsideChallenge(allowed);

  if (method === 'AUTHENTICATOR') {
    // Nothing to send: the app computes the code. The answer says how long
    // the one on the screen lasts, so the form can draw the same countdown.
    if (!isEnrolled(user)) throw new ApiError(409, 'TOTP_NOT_ENROLLED', 'No authenticator app is set up on this account.');
    return { method, expiresInSeconds: appCodeExpiresInSeconds() };
  }
  if (isEnrolled(user) && !(await adminTwoFactorPolicy()).smsAllowedWhenEnrolled) {
    // Lot K2: the policy lists AUTHENTICATOR alone for an enrolled admin.
    throw new ApiError(403, 'FORBIDDEN', 'Sign in with the code from your authenticator app, or a recovery code.', { methods: ['AUTHENTICATOR'] });
  }

  if (method === 'SMS') {
    // Through the ordinary OTP path, so the per-number resend budget, the
    // five-guess cap and the fifteen-minute lock all apply unchanged.
    const result = await sendOtp(user.mobile, 'TWO_FACTOR');
    await logActivity(user.id, 'LOGIN_2FA_SENT', { module: 'auth', targetType: 'User', targetId: user.id, metadata: { method } });
    return {
      method,
      expiresInSeconds: result.expiresInSeconds,
      resendAfterSeconds: result.resendAfterSeconds,
      sendsRemaining: result.sendsRemaining,
      ...(result.devOtp ? { devCode: result.devOtp } : {}),
    };
  }

  if (!user.email) throw new ApiError(409, 'CONFLICT', 'This account has no email address on file.');
  if (fallbackSpent(user)) throw mobileVerificationRequired();

  // The same per-recipient budget the email OTP login uses: three in ten
  // minutes, one a minute. Reserved before the counter moves, so a refused
  // send does not spend a fallback.
  const budget = await reserveOtpSend(user.email);

  const used = await repository.countEmailFallback(user.id, windowStart());
  if (used > env.ADMIN_EMAIL_OTP_FALLBACK_LIMIT) {
    await logActivity(user.id, 'LOGIN_2FA_FAILED', {
      module: 'auth',
      targetType: 'User',
      targetId: user.id,
      metadata: { method, reason: 'EMAIL_FALLBACK_EXHAUSTED' },
    });
    throw mobileVerificationRequired();
  }

  const code = generateEmailCode();
  await repository.expireOutstandingTwoFactorEmail(user.id);
  await repository.createEmailCode({
    userId: user.id,
    email: user.email,
    codeHash: await bcrypt.hash(code, 10),
    expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MINUTES * 60 * 1000),
  });

  // Lot E (Q87/Q147): through the dispatcher — the `two-factor-email`
  // template, sent in the request and logged masked with the code purged in a week.
  await notify(
    'TWO_FACTOR_EMAIL',
    user.id,
    { code, minutes: EMAIL_CODE_TTL_MINUTES, used, limit: env.ADMIN_EMAIL_OTP_FALLBACK_LIMIT, days: FALLBACK_WINDOW_DAYS },
    { type: 'SYSTEM', recipient: { email: user.email }, immediate: true },
  );
  if (env.NODE_ENV !== 'production') logger.info('2FA email code', { userId: user.id, code });

  await logActivity(user.id, 'LOGIN_2FA_SENT', {
    module: 'auth',
    targetType: 'User',
    targetId: user.id,
    metadata: { method, fallbackUsed: used, fallbackLimit: env.ADMIN_EMAIL_OTP_FALLBACK_LIMIT },
  });

  const result: SendResult = {
    method,
    expiresInSeconds: EMAIL_CODE_TTL_MINUTES * 60,
    resendAfterSeconds: budget.resendAfterSeconds,
    sendsRemaining: budget.sendsRemaining,
  };
  return env.NODE_ENV === 'production' ? result : { ...result, devCode: code };
}

function mobileVerificationRequired(): ApiError {
  return new ApiError(
    403,
    'MOBILE_VERIFICATION_REQUIRED',
    'The email backup for this account is used up. Sign in with the code sent to your phone.',
    { methods: ['SMS'] },
  );
}

export function generateEmailCode(): string {
  const bytes = crypto.randomBytes(EMAIL_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < EMAIL_CODE_LENGTH; i += 1) {
    // Modulo bias is negligible at 32 symbols out of 256 — 256 is a multiple
    // of 32, so there is none at all.
    code += EMAIL_CODE_ALPHABET[bytes[i]! % EMAIL_CODE_ALPHABET.length];
  }
  return code;
}

export type VerifiedChallenge = {
  userId: string;
  roles: Role[];
  method: TwoFactorMethod | 'RECOVERY_CODE';
  /** Lot K2: after a recovery code — how many are left, and a warning at two or fewer. */
  recoveryCodesLeft?: number;
  warning?: string | null;
};

/**
 * POST /auth/2fa/verify — consumes the code and says who just proved
 * themselves. The caller starts the session, because that is where the
 * response payload and the request metadata are.
 *
 * The body does not say which channel was used; the newest live code does.
 */
export async function verifyTwoFactorCode(challengeToken: string, rawCode: string): Promise<VerifiedChallenge> {
  const { userId, methods: allowed } = readChallengeClaims(challengeToken);
  const user = await requireAdmin(userId);
  const roles = user.roles.map((r) => r.role) as Role[];
  const allows = (method: TwoFactorMethod) => allowed === null || allowed.includes(method);

  // Lot K2: an enrolled admin may answer with a recovery code (XXXX-XXXX,
  // spent on use) or, when no code was sent to the phone or the mailbox,
  // with the six digits the app shows. A live sent code means the person
  // chose that channel, and the newest live code decides as it always did.
  if (isEnrolled(user) && looksLikeRecoveryCode(rawCode)) {
    try {
      const outcome = await spendRecoveryCode(user, rawCode);
      await logActivity(user.id, 'LOGIN_2FA_PASSED', {
        module: 'auth',
        targetType: 'User',
        targetId: user.id,
        metadata: { method: 'RECOVERY_CODE', recoveryCodesLeft: outcome.recoveryCodesLeft },
      });
      return { userId: user.id, roles, method: 'RECOVERY_CODE', ...outcome };
    } catch (err) {
      await failed(user.id, err instanceof OtpError ? `RECOVERY_${err.reason}` : 'RECOVERY_CODE_INVALID');
      throw err;
    }
  }

  // M-B: the policy is read now, not when the code was sent. A live SMS or
  // email code for an enrolled admin whose policy has since turned
  // `smsAllowedWhenEnrolled` off is a dead row — ignored here, so the app's
  // code is what the six digits are checked against and the sent code
  // opens nothing. Nothing has to expire rows when the setting flips.
  const sentChannelsAllowed = !isEnrolled(user) || (await adminTwoFactorPolicy()).smsAllowedWhenEnrolled;
  const outstanding = sentChannelsAllowed ? await repository.findLatestTwoFactorOtp(user.id) : null;
  if (!outstanding && isEnrolled(user) && looksLikeAppCode(rawCode)) {
    if (!allows('AUTHENTICATOR')) {
      await failed(user.id, 'AUTHENTICATOR_NOT_IN_CHALLENGE');
      throw outsideChallenge(allowed!);
    }
    try {
      await verifyAppCode(user, rawCode);
    } catch (err) {
      await failed(user.id, err instanceof OtpError ? `AUTHENTICATOR_${err.reason}` : 'AUTHENTICATOR_INVALID');
      throw err;
    }
    // The app answered — the phone is in hand, so the email backup is earned back too.
    await repository.resetEmailFallback(user.id);
    await logActivity(user.id, 'LOGIN_2FA_PASSED', { module: 'auth', targetType: 'User', targetId: user.id, metadata: { method: 'AUTHENTICATOR' } });
    return { userId: user.id, roles, method: 'AUTHENTICATOR' };
  }
  if (!outstanding) {
    await failed(user.id, sentChannelsAllowed ? 'NO_CODE' : 'SENT_CHANNEL_NOT_ALLOWED');
    throw new ApiError(401, 'UNAUTHORIZED', 'This code has expired. Request a new one.');
  }

  // M-B: a sent code on a channel this challenge does not list (the mobile
  // OTP door has spent SMS) is refused unread — it may be live from another
  // sign-in, and it is not this one's answer.
  const channel: TwoFactorMethod = outstanding.purpose === 'TWO_FACTOR' ? 'SMS' : 'EMAIL';
  if (!allows(channel)) {
    await failed(user.id, `${channel}_NOT_IN_CHALLENGE`);
    throw outsideChallenge(allowed!);
  }

  if (outstanding.purpose === 'TWO_FACTOR') {
    try {
      await verifyOtp(normalizeMobile(user.mobile), rawCode, 'TWO_FACTOR');
    } catch (err) {
      await failed(user.id, err instanceof OtpError ? err.reason : 'SMS_INVALID');
      throw err;
    }
    // The phone answered, so the email backup is earned back in full.
    await repository.resetEmailFallback(user.id);
    await logActivity(user.id, 'LOGIN_2FA_PASSED', { module: 'auth', targetType: 'User', targetId: user.id, metadata: { method: 'SMS' } });
    return { userId: user.id, roles, method: 'SMS' };
  }

  if (outstanding.attempts >= MAX_ATTEMPTS) {
    await failed(user.id, 'EMAIL_ATTEMPTS_EXCEEDED');
    throw new ApiError(401, 'UNAUTHORIZED', 'Too many incorrect attempts on this code. Request a new one.');
  }

  // Case-insensitive: the alphabet has no lower-case member, so folding the
  // input up is lossless, and somebody typing into a phone keyboard should
  // not be punished for it.
  const code = rawCode.trim().toUpperCase();
  if (!(await bcrypt.compare(code, outstanding.codeHash))) {
    await repository.incrementAttempts(outstanding.id);
    await failed(user.id, 'EMAIL_INVALID');
    throw new ApiError(401, 'UNAUTHORIZED', 'Incorrect code. Try again.');
  }

  await repository.markVerified(outstanding.id);
  await logActivity(user.id, 'LOGIN_2FA_PASSED', { module: 'auth', targetType: 'User', targetId: user.id, metadata: { method: 'EMAIL' } });
  return { userId: user.id, roles, method: 'EMAIL' };
}

async function failed(userId: string, reason: string): Promise<void> {
  await logActivity(userId, 'LOGIN_2FA_FAILED', {
    module: 'auth',
    targetType: 'User',
    targetId: userId,
    metadata: { reason },
  });
}

/* ── what other modules need ─────────────────────────────────────── */

/** POST /users/:id/2fa/reset — an admin hands somebody their email backup back. */
export async function resetEmailOtpFallback(userId: string): Promise<void> {
  await repository.resetEmailFallback(userId);
}

/** POST /users with ADMIN in the roles: the second factor is on from the start. */
export async function requireTwoFactorFor(userId: string): Promise<void> {
  await repository.stampTwoFactorRequired(userId);
}
