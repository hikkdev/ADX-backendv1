import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { env } from '../../../config/env';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';
import { sendSms } from '../../../shared/sms';
import { notify } from '../../notifications';
import type { OtpPurpose, Role } from '../../../shared/database';
import { logActivity } from '../../../shared/audit';
import { mobileWasErased } from '../auth.ports';
import { prismaOtpRepository as repository } from './prisma-otp.repository';
import {
  OtpError,
  assertOtpNotLocked,
  clearOtpFailures,
  registerOtpFailure,
  reserveOtpSend,
  type OtpSendBudget,
} from './otp-security';

const OTP_TTL_MINUTES = 10;
/** Wrong guesses one code will take. The per-number lock in otp-security is the real ceiling. */
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

/** The seeded roles a `DEV_LOGIN_MOBILES` entry may name. */
const DEV_LOGIN_ROLES: readonly Role[] = ['AGENT_PUBLISHER', 'AGENT_ADVERTISER', 'PUBLISHER', 'ADVERTISER', 'PARTNER', 'ADMIN'];
/** What a bare `<mobile>` entry has always meant. */
const DEV_LOGIN_DEFAULT_ROLE: Role = 'AGENT_PUBLISHER';

/**
 * `DEV_LOGIN_MOBILES` as a map of normalised number → role. An entry is
 * `<mobile>` (the agent default) or `<mobile>:<ROLE>`; a role that is not
 * seeded drops the entry with a warning rather than guessing. Exported for
 * its test; production never consults it (see `resolveDevLoginRole`).
 */
export function parseDevLoginAllowlist(): Map<string, Role> {
  const allowlist = new Map<string, Role>();
  for (const raw of env.DEV_LOGIN_MOBILES.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [mobilePart, rolePart] = entry.split(':', 2) as [string, string | undefined];
    const mobile = normalizeMobile(mobilePart.trim());
    if (!mobile) continue;
    const role = rolePart === undefined ? DEV_LOGIN_DEFAULT_ROLE : (rolePart.trim().toUpperCase() as Role);
    if (!DEV_LOGIN_ROLES.includes(role)) {
      logger.warn('DEV_LOGIN_MOBILES entry names a role that is not seeded; entry dropped', { mobile, role });
      continue;
    }
    allowlist.set(mobile, role);
  }
  return allowlist;
}

/**
 * Q-B (owner's item 11): the role this number may self-provision as, or
 * null when the allowlist has nothing for it. The whole allowlist is dead in
 * production. An ADMIN entry has a second guard — `DEV_ADMIN_LOGIN=true` —
 * and is refused with a logged reason when either is missing: the number
 * then takes the ordinary register-or-login path and gets nothing, not even
 * the agent default, because the entry asked for something else.
 */
function resolveDevLoginRole(mobile: string): Role | null {
  const role = parseDevLoginAllowlist().get(mobile);
  if (!role) return null;
  if (env.NODE_ENV === 'production') {
    // The allowlist is dead here for every role; an ADMIN entry gets its own
    // line so a misconfigured deployment is visible rather than silent.
    if (role === 'ADMIN') logger.warn('DEV_LOGIN_MOBILES admin entry refused: NODE_ENV is production', { mobile, reason: 'NODE_ENV_PRODUCTION' });
    return null;
  }
  if (role === 'ADMIN' && !env.DEV_ADMIN_LOGIN) {
    logger.warn('DEV_LOGIN_MOBILES admin entry refused: DEV_ADMIN_LOGIN is not true', { mobile, reason: 'DEV_ADMIN_LOGIN_OFF' });
    return null;
  }
  return role;
}

function printDevOtp(recipient: string, code: string, purpose: string): void {
  if (env.NODE_ENV === 'production') return;
  console.warn('\n+--------------------------------------+');
  console.warn(`| OTP for ${recipient.padEnd(27)} |`);
  console.warn(`| Code: ${code} (${purpose.padEnd(8)})          |`);
  console.warn(`| Expires in ${String(OTP_TTL_MINUTES).padEnd(2)} minutes              |`);
  console.warn('+--------------------------------------+\n');
}

export type SendOtpResult = OtpSendBudget & {
  /** How long the code just sent stays valid. */
  expiresInSeconds: number;
  /** Outside production only. */
  devOtp?: string;
};

/**
 * Register-or-login.
 *
 * One flow serves publishers and advertisers alike: any number may ask for a
 * code. A number nobody has seen gets a roleless User row *now*, at send time,
 * because `Otp.userId` is NOT NULL and the code has to reference something.
 * The row is inert — no role, no party, and no token is issued until a code is
 * verified — and `User.mobileVerifiedAt` records the moment it stops being a
 * ghost. The party (PUB-/ADV-) is chosen afterwards, through
 * POST /users/me/party.
 *
 * Because every number now gets a real send, the response no longer has to be
 * faked for unknown numbers to avoid enumeration: known and unknown numbers
 * take the same path and answer identically.
 *
 * `REGISTER` is the legacy publisher-app path and keeps its behaviour: it
 * refuses a number that already has an account (409) and creates a PUBLISHER
 * user outright.
 *
 * Order matters. The lock is checked before anything else; the send budget is
 * reserved before any row is created, so a number that has exhausted its
 * three sends cannot mint ghost users either.
 */
export async function sendOtp(mobile: string, purpose: OtpPurpose = 'LOGIN'): Promise<SendOtpResult> {
  mobile = normalizeMobile(mobile);
  await assertOtpNotLocked(mobile);

  let user = await repository.findUserByMobile(mobile);
  const wasKnown = user !== null;

  if (purpose === 'REGISTER' && user) {
    throw new ApiError(409, 'CONFLICT', 'An account with this number already exists. Please log in instead.');
  }

  const budget = await reserveOtpSend(mobile);

  if (purpose === 'REGISTER') {
    user = await repository.createPublisherUser(mobile);
  } else if (!user && purpose === 'LOGIN') {
    const devRole = resolveDevLoginRole(mobile);
    if (devRole) {
      logger.info('Creating dev login user from allowlist', { mobile, role: devRole });
      user = await repository.createDevLoginUser(mobile, devRole);
      // Q-B: an admin minted by the allowlist is written to the account's
      // own audit trail — the only place the door leaves a mark.
      if (devRole === 'ADMIN') {
        await logActivity(user.id, 'DEV_ADMIN_LOGIN_USED', {
          module: 'auth',
          targetType: 'User',
          targetId: user.id,
          metadata: { mobile, note: 'ADMIN minted by DEV_LOGIN_MOBILES under DEV_ADMIN_LOGIN=true; second factor still required.' },
        });
      }
    } else {
      logger.info('Registering unknown mobile as a roleless user', { mobile });
      user = await repository.createUnregisteredUser(mobile);
    }
  }

  if (!user) {
    // Only PUBLISHER_VERIFY can land here: it verifies an existing account
    // and has no registration path, so an unknown number is answered as
    // though a send happened rather than confirming there is nothing to send to.
    logger.info('OTP requested for unregistered mobile', { mobile, purpose });
    return { ...budget, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  }

  if (!wasKnown) await noteReregistrationAfterErasure(user.id, mobile);

  return sendOtpForUser(user.id, mobile, purpose, budget);
}

/**
 * Lot A (Q60): a number that was erased may register again.
 *
 * The tombstone is a hash, so ADX can tell a re-registration from a new person
 * without keeping the number it deleted. Registration is never refused on it —
 * the erasure was granted and the person is entitled to come back — but the
 * new account carries an activity row saying so, which is what support needs
 * when the same person rings about history they can no longer see.
 *
 * Never throws: an unreadable tombstone is not a reason to refuse a sign-up.
 */
async function noteReregistrationAfterErasure(userId: string, mobile: string): Promise<void> {
  try {
    if (!(await mobileWasErased(mobile))) return;
    await logActivity(userId, 'REREGISTERED_AFTER_ERASURE', {
      module: 'auth',
      targetType: 'User',
      targetId: userId,
      metadata: {
        note: 'This number was erased on a DPO-approved request before this account was opened.',
      },
    });
  } catch (error) {
    logger.warn('Could not check the erasure tombstone', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Lot F (Q18): a code for a KNOWN account to a number that need not be its
 * own — the two halves of the mobile change. The old number consents first
 * (CHANGE_MOBILE_OLD, to `User.mobile`), then the new one is proved
 * (CHANGE_MOBILE, to a number no account holds yet). `sendOtp` cannot serve
 * the second: it resolves the user from the number, and a fresh number
 * resolves to nobody. Same lock, same send budget, same rail as a login code.
 */
export async function sendOtpToNumberForUser(userId: string, mobile: string, purpose: OtpPurpose): Promise<SendOtpResult> {
  mobile = normalizeMobile(mobile);
  await assertOtpNotLocked(mobile);
  const budget = await reserveOtpSend(mobile);
  return sendOtpForUser(userId, mobile, purpose, budget);
}

async function sendOtpForUser(
  userId: string,
  mobile: string,
  purpose: OtpPurpose,
  budget: OtpSendBudget,
): Promise<SendOtpResult> {
  logger.info('OTP generation started', { userId, mobile, purpose });

  await repository.expireOutstandingByMobile(mobile, purpose);

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await repository.createForMobile({ userId, mobile, purpose, codeHash, expiresAt });

  printDevOtp(mobile, code, purpose);

  // Lot E (Q128/Q147): a kind, never a body — the rail renders the DLT
  // template from its own registration. The admin second factor goes through
  // the dispatcher so it sits in the delivery log beside every other message
  // (Q147); the ordinary login OTP is a direct send by kind.
  if (purpose === 'TWO_FACTOR') {
    await notify('TWO_FACTOR_SMS', userId, { code, minutes: OTP_TTL_MINUTES }, { type: 'SYSTEM', recipient: { mobile }, immediate: true });
  } else {
    await sendSms({
      to: mobile,
      kind: 'LOGIN_OTP',
      vars: { code, minutes: OTP_TTL_MINUTES },
      body: `Your ADX OTP is ${code}. Valid for ${OTP_TTL_MINUTES} minutes. Do not share this with anyone.`,
    });
  }
  logger.info('OTP dispatch completed', { userId, mobile, purpose, expiresAt });

  const result: SendOtpResult = { ...budget, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  return env.NODE_ENV === 'production' ? result : { ...result, devOtp: code };
}

// Email-delivered OTP login — an alternative channel to the mobile/SMS flow
// above, for accounts that already have an email on file. LOGIN only: unlike
// mobile OTP there's no self-registration path via email.
export async function sendEmailOtp(email: string): Promise<SendOtpResult> {
  const user = await repository.findUserByEmail(email);

  if (!user) {
    // Email has no registration path, so an unknown address is answered like
    // a successful send rather than revealing there is no account behind it.
    logger.info('OTP requested for unregistered email', { email });
    return {
      resendAfterSeconds: 0,
      sendsRemaining: 0,
      expiresInSeconds: OTP_TTL_MINUTES * 60,
    };
  }

  const budget = await reserveOtpSend(email);
  logger.info('Email OTP generation started', { userId: user.id, email });

  await repository.expireOutstandingByEmail(email);

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

  await repository.createForEmail({ userId: user.id, email, codeHash, expiresAt });

  printDevOtp(email, code, 'LOGIN');

  // Lot E (Q87): through the dispatcher — the `login-otp-email` template,
  // rendered and sent in the request, logged masked with the code purged in a week.
  await notify('LOGIN_OTP_EMAIL', user.id, { code, minutes: OTP_TTL_MINUTES }, { type: 'SYSTEM', recipient: { email }, immediate: true });
  logger.info('Email OTP dispatch completed', { userId: user.id, email, expiresAt });

  const result: SendOtpResult = { ...budget, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  return env.NODE_ENV === 'production' ? result : { ...result, devOtp: code };
}

/**
 * K-B1: the purpose a contact verification's code is filed under. Lot K2's
 * migration added `CONTACT_VERIFY` to the `OtpPurpose` enum; until then the
 * code rode on the retired `PUBLISHER_VERIFY` value.
 */
export const CONTACT_VERIFY_PURPOSE: OtpPurpose = 'CONTACT_VERIFY';

/**
 * K-B1: a six-digit code to an email address the account does NOT sign in
 * with — a contact being verified. `sendEmailOtp` cannot serve it: it
 * resolves the user from `User.email`, and a contact address resolves to
 * nobody. Same per-recipient send budget, and the `login-otp-email`
 * template (a "your ADX code" mail; no template of its own — see the README).
 */
export async function sendEmailCodeToAddressForUser(userId: string, email: string, purpose: OtpPurpose): Promise<SendOtpResult> {
  email = email.trim().toLowerCase();
  await assertOtpNotLocked(email);
  const budget = await reserveOtpSend(email);
  logger.info('Email code generation started', { userId, email, purpose });

  await repository.expireOutstandingByEmail(email, purpose);

  const code = generateOtp();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  await repository.createForEmail({ userId, email, codeHash, expiresAt, purpose });

  printDevOtp(email, code, purpose);
  await notify('LOGIN_OTP_EMAIL', userId, { code, minutes: OTP_TTL_MINUTES }, { type: 'SYSTEM', recipient: { email }, immediate: true });
  logger.info('Email code dispatch completed', { userId, email, purpose, expiresAt });

  const result: SendOtpResult = { ...budget, expiresInSeconds: OTP_TTL_MINUTES * 60 };
  return env.NODE_ENV === 'production' ? result : { ...result, devOtp: code };
}

/**
 * K-B1: the email twin of `verifyOtp` — the same vocabulary of refusals
 * (`OtpError` with a `reason`), the same five-guess cap and fifteen-minute
 * lock, keyed on the address instead of the number. Answers the user id the
 * code was issued for; the caller checks it is the account it expects.
 */
export async function verifyEmailCodeFor(email: string, code: string, purpose: OtpPurpose): Promise<string> {
  email = email.trim().toLowerCase();
  await assertOtpNotLocked(email);

  const otp = await repository.findLatestUnverifiedByEmail(email, purpose);
  if (!otp) {
    throw new OtpError(401, 'This code has expired. Request a new one.', { reason: 'OTP_EXPIRED' });
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    throw new OtpError(401, 'Too many incorrect attempts on this code. Request a new one.', {
      reason: 'OTP_ATTEMPTS_EXCEEDED',
    });
  }
  if (!(await bcrypt.compare(code, otp.codeHash))) {
    await repository.incrementAttempts(otp.id);
    const outcome = await registerOtpFailure(email);
    if (outcome.locked) {
      throw new OtpError(429, 'Too many incorrect attempts. Verification is temporarily paused.', {
        reason: 'OTP_LOCKED',
        lockedUntil: outcome.lockedUntil,
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    }
    throw new OtpError(401, 'Incorrect code. Try again.', { reason: 'OTP_INVALID', attemptsRemaining: outcome.attemptsRemaining });
  }

  await repository.markVerified(otp.id);
  await clearOtpFailures(email);
  return otp.userId;
}

/**
 * K-B1: whether the account has ever proved this address with a code —
 * `User` carries no `emailVerifiedAt` (see users' README, schema needs), so
 * the primary email's verified flag is derived from the codes it answered.
 */
export async function hasProvenEmail(userId: string, email: string): Promise<boolean> {
  return repository.hasVerifiedEmail(userId, email.trim().toLowerCase());
}

/** K-B1: every live code the account holds — run after its sign-in number moves. */
export async function expireOutstandingOtpsForUser(userId: string): Promise<void> {
  await repository.expireOutstandingForUser(userId);
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

/**
 * Every refusal here is an `OtpError` carrying a machine-readable
 * `details.reason` — see otp-security.ts for the vocabulary. A wrong code
 * counts against the number, not just the code, so requesting a fresh code no
 * longer buys five more guesses; the fifth wrong guess in fifteen minutes locks
 * the number for fifteen minutes.
 *
 * A missing code (`OTP_EXPIRED`) is not a guess and is not counted.
 */
export async function verifyOtp(
  mobile: string,
  code: string,
  purpose: OtpPurpose = 'LOGIN',
): Promise<string> {
  mobile = normalizeMobile(mobile);
  logger.info('OTP verification started', { mobile, purpose });
  await assertOtpNotLocked(mobile);

  const otp = await repository.findLatestUnverifiedByMobile(mobile, purpose);

  if (!otp) {
    logger.warn('OTP verification failed: not found or expired', { mobile, purpose });
    throw new OtpError(401, 'This code has expired. Request a new one.', { reason: 'OTP_EXPIRED' });
  }

  if (otp.attempts >= MAX_ATTEMPTS) {
    logger.warn('OTP verification failed: too many attempts', { mobile, purpose });
    throw new OtpError(401, 'Too many incorrect attempts on this code. Request a new one.', {
      reason: 'OTP_ATTEMPTS_EXCEEDED',
    });
  }

  if (!(await bcrypt.compare(code, otp.codeHash))) {
    await repository.incrementAttempts(otp.id);
    const outcome = await registerOtpFailure(mobile);
    logger.warn('OTP verification failed: invalid code', { mobile, purpose, locked: outcome.locked });

    if (outcome.locked) {
      throw new OtpError(429, 'Too many incorrect OTP attempts. Sign-in is temporarily paused.', {
        reason: 'OTP_LOCKED',
        lockedUntil: outcome.lockedUntil,
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    }
    throw new OtpError(401, 'Incorrect code. Try again.', {
      reason: 'OTP_INVALID',
      attemptsRemaining: outcome.attemptsRemaining,
    });
  }

  await repository.markVerified(otp.id);
  // A correct code clears the number's slate and, the first time, records
  // that this row is a real person rather than a number that only asked.
  await Promise.all([clearOtpFailures(mobile), repository.markMobileVerified(otp.userId)]);

  logger.info('OTP verification completed', { mobile, purpose, userId: otp.userId });
  return otp.userId;
}
