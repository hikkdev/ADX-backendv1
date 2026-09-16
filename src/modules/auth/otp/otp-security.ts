import { redis } from '../../../shared/cache';
import { ApiError } from '../../../shared/errors';

/**
 * Per-number OTP throttles and the lockout.
 *
 * All of it lives in Redis, keyed by the recipient, so the limits hold across
 * instances and survive IP rotation — the per-IP limiters in shared/security
 * cannot see one number being worked from many addresses, and without a
 * per-number lock "request a fresh code" resets the per-code guess cap.
 *
 * The numbers are a contract with the DR 08 screens, not tuning knobs:
 *
 *   AG-02 draws "Resend in 60s"                 OTP_RESEND_COOLDOWN_SECONDS
 *   AG-02 caps sends at 3 per number per 10 min  OTP_SEND_LIMIT / _WINDOW
 *   AG-76 "Incorrect code. Try again."           OTP_INVALID + attemptsRemaining
 *   AG-77 "UNLOCKS IN 14:32"                     a 15-minute lock, lockedUntil
 *
 * Every refusal is an `OtpError`, whose `details.reason` is the machine-
 * readable code the screens route on. The top-level `error.code` stays an
 * HTTP-class code (UNAUTHORIZED or TOO_MANY_REQUESTS): `ApiErrorCode` is a
 * closed union owned by shared/errors, and the reason vocabulary belongs to
 * this module. `retryAfterSeconds`, when present, is also sent as the
 * standard `Retry-After` header by the controller.
 */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;
export const OTP_SEND_LIMIT = 3;
export const OTP_SEND_WINDOW_SECONDS = 10 * 60;
/** Wrong guesses per number, across codes, before the number is locked. */
export const OTP_LOCK_THRESHOLD = 5;
export const OTP_LOCK_SECONDS = 15 * 60;

export type OtpFailureReason =
  /** Wrong code; `attemptsRemaining` says how many guesses are left. */
  | 'OTP_INVALID'
  /** No live code for this number — expired, spent, or never requested. */
  | 'OTP_EXPIRED'
  /** This particular code has taken its five guesses; request another. */
  | 'OTP_ATTEMPTS_EXCEEDED'
  /** The number is locked; `lockedUntil` and `retryAfterSeconds` say for how long. */
  | 'OTP_LOCKED'
  /** A code was sent less than a minute ago. */
  | 'OTP_RESEND_TOO_SOON'
  /** Three codes in ten minutes; `retryAfterSeconds` is the rest of the window. */
  | 'OTP_RESEND_LIMIT';

export type OtpFailureDetails = {
  reason: OtpFailureReason;
  attemptsRemaining?: number;
  retryAfterSeconds?: number;
  /** ISO timestamp, so the screen can draw a countdown that survives a reload. */
  lockedUntil?: string;
};

export class OtpError extends ApiError {
  readonly reason: OtpFailureReason;
  readonly retryAfterSeconds: number | undefined;

  constructor(statusCode: 401 | 429, message: string, details: OtpFailureDetails) {
    super(statusCode, statusCode === 429 ? 'TOO_MANY_REQUESTS' : 'UNAUTHORIZED', message, details);
    this.name = 'OtpError';
    this.reason = details.reason;
    this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

const sendKey = (recipient: string) => `otp-send:${recipient}`;
const cooldownKey = (recipient: string) => `otp-cooldown:${recipient}`;
const failKey = (mobile: string) => `otp-fail:${mobile}`;
const lockKey = (mobile: string) => `otp-lock:${mobile}`;

/** Redis answers -1/-2 for a key with no TTL or no key; never tell a client to wait 0. */
async function secondsLeft(key: string, fallback: number): Promise<number> {
  const ttl = await redis.ttl(key);
  return ttl > 0 ? ttl : fallback;
}

export type OtpSendBudget = {
  /** Seconds before the screen may offer "Resend". Always the cooldown. */
  resendAfterSeconds: number;
  /** Sends left in the current ten-minute window after this one. */
  sendsRemaining: number;
};

/**
 * Takes one send from the number's budget, or refuses.
 *
 * The cooldown is claimed first, atomically (SET NX), so two taps in the same
 * instant get one code and one refusal rather than two codes. A refusal never
 * consumes budget: the cap is checked after the cooldown, and a send refused
 * by the cap gives its cooldown back so the next answer is the same refusal
 * with an honest `retryAfterSeconds` rather than a spurious "too soon".
 */
export async function reserveOtpSend(recipient: string): Promise<OtpSendBudget> {
  const claimed = await redis.set(cooldownKey(recipient), '1', 'EX', OTP_RESEND_COOLDOWN_SECONDS, 'NX');
  if (claimed !== 'OK') {
    throw new OtpError(429, 'A code was sent a moment ago. Please wait before requesting another.', {
      reason: 'OTP_RESEND_TOO_SOON',
      retryAfterSeconds: await secondsLeft(cooldownKey(recipient), OTP_RESEND_COOLDOWN_SECONDS),
    });
  }

  const count = await redis.incr(sendKey(recipient));
  if (count === 1) await redis.expire(sendKey(recipient), OTP_SEND_WINDOW_SECONDS);

  if (count > OTP_SEND_LIMIT) {
    await redis.del(cooldownKey(recipient));
    throw new OtpError(429, 'Too many codes requested for this number. Please try again later.', {
      reason: 'OTP_RESEND_LIMIT',
      retryAfterSeconds: await secondsLeft(sendKey(recipient), OTP_SEND_WINDOW_SECONDS),
    });
  }

  return { resendAfterSeconds: OTP_RESEND_COOLDOWN_SECONDS, sendsRemaining: OTP_SEND_LIMIT - count };
}

/** Refuses both sending and verifying while the number is locked. */
export async function assertOtpNotLocked(mobile: string): Promise<void> {
  const lockedUntil = await redis.get(lockKey(mobile));
  if (!lockedUntil) return;

  throw new OtpError(429, 'Too many incorrect OTP attempts. Sign-in is temporarily paused.', {
    reason: 'OTP_LOCKED',
    lockedUntil,
    retryAfterSeconds: await secondsLeft(lockKey(mobile), OTP_LOCK_SECONDS),
  });
}

export type OtpFailureOutcome =
  | { locked: false; attemptsRemaining: number }
  | { locked: true; lockedUntil: string; retryAfterSeconds: number };

/**
 * Counts one wrong guess against the number. The fifth in fifteen minutes
 * locks it for fifteen minutes and resets the count, so the lock is exactly
 * what AG-77 draws: a pause with a known end, after which the slate is clean.
 */
export async function registerOtpFailure(mobile: string): Promise<OtpFailureOutcome> {
  const count = await redis.incr(failKey(mobile));
  if (count === 1) await redis.expire(failKey(mobile), OTP_LOCK_SECONDS);

  if (count < OTP_LOCK_THRESHOLD) {
    return { locked: false, attemptsRemaining: OTP_LOCK_THRESHOLD - count };
  }

  const lockedUntil = new Date(Date.now() + OTP_LOCK_SECONDS * 1000).toISOString();
  await redis.set(lockKey(mobile), lockedUntil, 'EX', OTP_LOCK_SECONDS);
  await redis.del(failKey(mobile));
  return { locked: true, lockedUntil, retryAfterSeconds: OTP_LOCK_SECONDS };
}

/** A correct code wipes the number's failure count. */
export async function clearOtpFailures(mobile: string): Promise<void> {
  await redis.del(failKey(mobile));
}
