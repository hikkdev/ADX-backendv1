import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { ApiError } from '../../../shared/errors';
import { redis } from '../../../shared/cache';
import { logger } from '../../../shared/logging';
import { createNotification } from '../../notifications';
import { getPlatformSettings, type AdminTwoFactorPolicy } from '../../app-config';
import { assertOtpNotLocked, clearOtpFailures, registerOtpFailure, OtpError } from '../otp/otp-security';
import { normalizeMobile } from '../otp/otp.service';
import { prismaTwoFactorRepository as repository, type TwoFactorUser } from './prisma-two-factor.repository';
import { CODE_ALPHABET } from './two-factor.schema';
import { generateTotpSecret, matchTotp, openSecret, otpauthUri, sealSecret, totpStep, TOTP_STEP_SECONDS, TOTP_WINDOW } from './totp';

/**
 * The authenticator app as an admin's second factor — Lot K2.
 *
 * Enrolment is two calls. `enrol` mints a secret and keeps it in Redis for
 * ten minutes — never in the User row — and answers it once, with the
 * otpauth URI and a QR of it. `confirm` takes the first code the app shows;
 * only then is the secret sealed into `User.totpSecretEnc` and
 * `totpEnrolledAt` stamped, so a half-finished enrolment is not a factor
 * and a person who scanned the wrong screen is not locked out. Confirming
 * also issues ten recovery codes (`XXXX-XXXX`, the email-code alphabet,
 * bcrypt-hashed like an OTP), answered once and never again.
 *
 * Sign-in reads the sealed secret, compares the code within ±1 step, and
 * claims the step it accepted — one Redis SET NX keyed by the step, held
 * 90 seconds — so the same code cannot be replayed inside its window, not
 * even by two requests that arrive together (M-B). Wrong codes count against the very lock the
 * SMS path uses (keyed on the mobile), so an attacker cannot buy extra
 * guesses by switching channel. A recovery code is spent on use.
 *
 * Nothing here logs or returns the secret after `enrol`, and the sealed
 * form never leaves the repository layer unopened except to compare a code.
 */

export const TOTP_PENDING_TTL_SECONDS = 10 * 60;
export const TOTP_REPLAY_TTL_SECONDS = 90;
export const RECOVERY_CODE_COUNT = 10;
/** Warn once this few are left. */
export const RECOVERY_CODES_LOW = 2;

const pendingKey = (userId: string) => `auth:totp:pending:${userId}`;
/**
 * M-B: one key per accepted step, claimed with SET NX. A get-then-set on a
 * single "last step" key let two requests carrying the same code interleave
 * between the read and the write and both pass; the claim is one atomic
 * round trip, and the loser of a race is the replay.
 */
const usedStepKey = (userId: string, step: number) => `auth:totp:used:${userId}:${step}`;

/** Claims a step for this account; false when another request already has. */
async function claimStep(userId: string, step: number): Promise<boolean> {
  return (await redis.set(usedStepKey(userId, step), '1', 'EX', TOTP_REPLAY_TTL_SECONDS, 'NX')) === 'OK';
}

/** The keys a claim could sit under right now — the window `matchTotp` accepts. */
function usedStepKeysInWindow(userId: string, atMs = Date.now()): string[] {
  const current = totpStep(atMs);
  const keys: string[] = [];
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) keys.push(usedStepKey(userId, current + delta));
  return keys;
}

export type EnrolmentStart = {
  /** Shown once, for manual entry. */
  secret: string;
  otpauthUri: string;
  /** A data: URL of the QR, SVG. */
  qrSvg: string;
  expiresInSeconds: number;
};

export type AuthenticatorStatus = {
  enrolled: boolean;
  enrolledAt: Date | null;
  recoveryCodesLeft: number;
};

export function isEnrolled(user: Pick<TwoFactorUser, 'totpSecretEnc' | 'totpEnrolledAt'>): boolean {
  return Boolean(user.totpSecretEnc && user.totpEnrolledAt);
}

export async function adminTwoFactorPolicy(): Promise<AdminTwoFactorPolicy> {
  return (await getPlatformSettings()).auth.adminTwoFactor;
}

/**
 * Whether this admin's session has to carry the must-enrol claim: the policy
 * requires the app and the account has no enrolment. Never true for a
 * non-admin — the policy is about the console.
 */
export async function mustEnrolAuthenticator(user: Pick<TwoFactorUser, 'totpSecretEnc' | 'totpEnrolledAt'>, isAdminAccount: boolean): Promise<boolean> {
  if (!isAdminAccount || isEnrolled(user)) return false;
  return (await adminTwoFactorPolicy()).authenticatorRequired;
}

async function requireUser(userId: string): Promise<TwoFactorUser> {
  const user = await repository.findUser(userId);
  if (!user || !user.isActive) throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  return user;
}

/* ── enrolment ─────────────────────────────────────────────────── */

/** POST /auth/2fa/totp/enrol — a fresh pending secret; a second call replaces the first. */
export async function startEnrolment(userId: string): Promise<EnrolmentStart> {
  const user = await requireUser(userId);
  if (isEnrolled(user)) {
    throw new ApiError(409, 'TOTP_ALREADY_ENROLLED', 'An authenticator app is already set up on this account. Disable it first to set up another.');
  }
  const secret = generateTotpSecret();
  await redis.set(pendingKey(userId), secret, 'EX', TOTP_PENDING_TTL_SECONDS);
  const uri = otpauthUri(user.email ?? user.mobile, secret);
  // SVG rather than PNG: no canvas needed, and it scales on any screen.
  const svg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  const qrSvg = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
  return { secret, otpauthUri: uri, qrSvg, expiresInSeconds: TOTP_PENDING_TTL_SECONDS };
}

export type EnrolmentDone = { enrolledAt: Date; recoveryCodes: string[] };

/**
 * POST /auth/2fa/totp/confirm — the first code proves the app holds the
 * secret; the row is written and the recovery codes minted. The pending
 * secret is gone whichever way this ends: a wrong code means scanning again.
 */
export async function confirmEnrolment(userId: string, code: string): Promise<EnrolmentDone> {
  const user = await requireUser(userId);
  if (isEnrolled(user)) {
    throw new ApiError(409, 'TOTP_ALREADY_ENROLLED', 'An authenticator app is already set up on this account.');
  }
  const secret = await redis.get(pendingKey(userId));
  if (!secret) {
    throw new ApiError(409, 'TOTP_NOT_ENROLLED', 'No set-up in progress, or it has expired. Start again.');
  }
  const step = matchTotp(secret, code);
  if (step === null) {
    throw new ApiError(401, 'UNAUTHORIZED', 'That code did not match. Check the app and try again.');
  }
  await redis.del(pendingKey(userId));

  const enrolledAt = new Date();
  await repository.setAuthenticator(userId, { totpSecretEnc: sealSecret(secret), totpEnrolledAt: enrolledAt });
  // The step that enrolled cannot also sign in.
  await claimStep(userId, step);
  const recoveryCodes = await issueRecoveryCodes(userId);
  await securityNotice(userId, 'Authenticator app set up', 'An authenticator app is now your second factor. Keep the recovery codes somewhere safe. If this was not you, contact ADX now.');
  return { enrolledAt, recoveryCodes };
}

/**
 * POST /auth/2fa/totp/disable — needs the app's code, or a recovery code
 * (the phone may be the thing that was lost). Clears the columns and every
 * recovery code.
 */
export async function disableAuthenticator(userId: string, proof: { code?: string | undefined; recoveryCode?: string | undefined }): Promise<{ how: 'CODE' | 'RECOVERY_CODE' }> {
  const user = await requireUser(userId);
  if (!isEnrolled(user)) throw new ApiError(409, 'TOTP_NOT_ENROLLED', 'No authenticator app is set up on this account.');
  const how = await proveWithAppOrRecovery(user, proof);
  await clearAuthenticator(userId);
  await securityNotice(userId, 'Authenticator app removed', 'The authenticator app was removed from your account; sign-in codes go to your phone again. If this was not you, contact ADX now.');
  return { how };
}

/** POST /auth/2fa/recovery-codes/regenerate — a fresh ten; the old ones are gone. */
export async function regenerateRecoveryCodes(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const user = await requireUser(userId);
  if (!isEnrolled(user)) throw new ApiError(409, 'TOTP_NOT_ENROLLED', 'No authenticator app is set up on this account.');
  await verifyAppCode(user, code);
  const recoveryCodes = await issueRecoveryCodes(userId);
  await securityNotice(userId, 'New recovery codes', 'Your recovery codes were replaced. The old ones no longer work. If this was not you, contact ADX now.');
  return { recoveryCodes };
}

/** What `GET /auth/2fa/status`, `GET /users/:id` and the desk's reset read. */
export async function authenticatorStatus(user: Pick<TwoFactorUser, 'id' | 'totpSecretEnc' | 'totpEnrolledAt'>): Promise<AuthenticatorStatus> {
  const enrolled = isEnrolled(user);
  return {
    enrolled,
    enrolledAt: enrolled ? user.totpEnrolledAt : null,
    recoveryCodesLeft: enrolled ? await repository.countUnusedRecoveryCodes(user.id) : 0,
  };
}

/**
 * The desk's `POST /users/:id/2fa/reset` and the disable above: both
 * columns and every recovery code go. Answers what was there, for the audit row.
 */
export async function clearAuthenticator(userId: string): Promise<{ hadAuthenticator: boolean; recoveryCodesCleared: number }> {
  const user = await repository.findUser(userId);
  const hadAuthenticator = user ? isEnrolled(user) : false;
  const recoveryCodesCleared = await repository.countUnusedRecoveryCodes(userId);
  await repository.clearAuthenticator(userId);
  await repository.replaceRecoveryCodes(userId, []);
  await redis.del(pendingKey(userId), ...usedStepKeysInWindow(userId));
  return { hadAuthenticator, recoveryCodesCleared };
}

/** For the admin list: unspent recovery codes per user id. */
export function recoveryCodesLeftFor(userIds: readonly string[]): Promise<Map<string, number>> {
  return repository.countUnusedRecoveryCodesFor([...new Set(userIds)]);
}

/* ── sign-in ───────────────────────────────────────────────────── */

/**
 * The app's code at sign-in. The same lock the SMS path keys on the mobile
 * refuses, counts and clears here, so both channels share one budget of
 * five wrong guesses. The accepted step is claimed atomically and held for
 * 90 seconds; a second use of the same step's code — sequential or
 * concurrent — is the replay and is refused. One code, one sign-in.
 */
export async function verifyAppCode(user: TwoFactorUser, code: string): Promise<void> {
  if (!isEnrolled(user)) throw new ApiError(409, 'TOTP_NOT_ENROLLED', 'No authenticator app is set up on this account.');
  const mobile = normalizeMobile(user.mobile);
  await assertOtpNotLocked(mobile);

  const secret = openSecret(user.totpSecretEnc!);
  const step = matchTotp(secret, code);
  const replayed = step !== null && !(await claimStep(user.id, step));

  if (step === null || replayed) {
    const outcome = await registerOtpFailure(mobile);
    if (outcome.locked) {
      throw new OtpError(429, 'Too many incorrect attempts. Sign-in is temporarily paused.', {
        reason: 'OTP_LOCKED',
        lockedUntil: outcome.lockedUntil,
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    }
    throw new OtpError(
      401,
      replayed ? 'That code was already used. Wait for the app to show the next one.' : 'Incorrect code. Try again.',
      { reason: 'OTP_INVALID', attemptsRemaining: outcome.attemptsRemaining },
    );
  }

  await clearOtpFailures(mobile);
}

export type RecoveryOutcome = { recoveryCodesLeft: number; warning: string | null };

/** A recovery code at sign-in or on disable: spent on use, under the same lock. */
export async function spendRecoveryCode(user: TwoFactorUser, rawCode: string): Promise<RecoveryOutcome> {
  if (!isEnrolled(user)) throw new ApiError(409, 'TOTP_NOT_ENROLLED', 'No authenticator app is set up on this account.');
  const mobile = normalizeMobile(user.mobile);
  await assertOtpNotLocked(mobile);

  const code = normaliseRecoveryCode(rawCode);
  const candidates = await repository.findUnusedRecoveryCodes(user.id);
  let spent = false;
  for (const candidate of candidates) {
    if (await bcrypt.compare(code, candidate.codeHash)) {
      spent = await repository.spendRecoveryCode(candidate.id);
      if (spent) break;
    }
  }
  if (!spent) {
    const outcome = await registerOtpFailure(mobile);
    if (outcome.locked) {
      throw new OtpError(429, 'Too many incorrect attempts. Sign-in is temporarily paused.', {
        reason: 'OTP_LOCKED',
        lockedUntil: outcome.lockedUntil,
        retryAfterSeconds: outcome.retryAfterSeconds,
      });
    }
    throw new OtpError(401, 'That recovery code is not valid.', { reason: 'OTP_INVALID', attemptsRemaining: outcome.attemptsRemaining });
  }
  await clearOtpFailures(mobile);
  const recoveryCodesLeft = await repository.countUnusedRecoveryCodes(user.id);
  return {
    recoveryCodesLeft,
    warning:
      recoveryCodesLeft <= RECOVERY_CODES_LOW
        ? `${recoveryCodesLeft} recovery ${recoveryCodesLeft === 1 ? 'code' : 'codes'} left. Generate a new set from your security settings.`
        : null,
  };
}

/** `XXXX-XXXX`, or the eight characters however they were typed. */
export function normaliseRecoveryCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

export function looksLikeRecoveryCode(raw: string): boolean {
  return new RegExp(`^[${CODE_ALPHABET}]{8}$`).test(normaliseRecoveryCode(raw));
}

export function looksLikeAppCode(raw: string): boolean {
  return /^\d{6}$/.test(raw.replace(/\s/g, ''));
}

/** The seconds the current code stays valid — what `/2fa/send` answers for AUTHENTICATOR. */
export function appCodeExpiresInSeconds(): number {
  return TOTP_STEP_SECONDS;
}

/* ── internals ─────────────────────────────────────────────────── */

async function proveWithAppOrRecovery(user: TwoFactorUser, proof: { code?: string | undefined; recoveryCode?: string | undefined }): Promise<'CODE' | 'RECOVERY_CODE'> {
  if (proof.code !== undefined) {
    await verifyAppCode(user, proof.code);
    return 'CODE';
  }
  if (proof.recoveryCode !== undefined) {
    await spendRecoveryCode(user, proof.recoveryCode);
    return 'RECOVERY_CODE';
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Give the code from your app, or a recovery code');
}

/** Ten `XXXX-XXXX` codes, hashed like an OTP; the clear text is answered once. */
async function issueRecoveryCodes(userId: string): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i += 1) codes.push(generateRecoveryCode());
  const hashes = await Promise.all(codes.map((code) => bcrypt.hash(code.replace('-', ''), 10)));
  await repository.replaceRecoveryCodes(userId, hashes);
  return codes;
}

export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) {
    if (i === 4) out += '-';
    // 256 is a multiple of 32, so there is no modulo bias.
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * The person is told, in the app's inbox. No template of the security
 * family fits an authenticator change — `mobile-changed` is an SMS to the
 * OLD number about the number — so this is the in-app row only, and the
 * README says so. Best effort: a dead notifications table must not undo
 * the enrolment.
 */
async function securityNotice(userId: string, title: string, message: string): Promise<void> {
  try {
    await createNotification({ userId, type: 'SYSTEM', title, message, relatedId: userId });
  } catch (err) {
    logger.warn('Authenticator security notice was not written', { userId, reason: err instanceof Error ? err.message : String(err) });
  }
}
