import { afterEach, describe, expect, it } from 'vitest';
import { redis } from '../../../../shared/cache';
import {
  OTP_LOCK_SECONDS,
  OTP_LOCK_THRESHOLD,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_SEND_LIMIT,
  OTP_SEND_WINDOW_SECONDS,
  OtpError,
  assertOtpNotLocked,
  clearOtpFailures,
  registerOtpFailure,
  reserveOtpSend,
} from '../otp-security';

/**
 * The per-number throttles and the lockout, against the real Redis.
 *
 * Not mocked, on purpose: the guarantees under test are Redis semantics —
 * SET NX for the cooldown, INCR + EXPIRE for the windows, TTL for the honest
 * `retryAfterSeconds` — and a fake that reimplements them would only prove the
 * fake. Every test works a number nobody else uses and deletes its keys after,
 * so runs never collide with each other or with a dev server on the same
 * instance.
 *
 * The numbers are the DR 08 contract (AG-02, AG-76, AG-77), so they are
 * asserted as values rather than read back from the constants.
 */

const used: string[] = [];

function freshNumber(): string {
  const digits = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
  const mobile = `+919${digits}`;
  used.push(mobile);
  return mobile;
}

const keysFor = (n: string) => [`otp-send:${n}`, `otp-cooldown:${n}`, `otp-fail:${n}`, `otp-lock:${n}`];

afterEach(async () => {
  const keys = used.splice(0).flatMap(keysFor);
  if (keys.length) await redis.del(...keys);
});

async function refusal(promise: Promise<unknown>): Promise<OtpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(OtpError);
    return err as OtpError;
  }
  throw new Error('expected an OtpError');
}

describe('the contract with the screens', () => {
  it('draws what AG-02 and AG-77 draw', () => {
    expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(OTP_SEND_LIMIT).toBe(3);
    expect(OTP_SEND_WINDOW_SECONDS).toBe(10 * 60);
    expect(OTP_LOCK_THRESHOLD).toBe(5);
    expect(OTP_LOCK_SECONDS).toBe(15 * 60);
  });

  it('keeps the HTTP-class code on top and the reason underneath', () => {
    const locked = new OtpError(429, 'locked', { reason: 'OTP_LOCKED', retryAfterSeconds: 9 });
    expect(locked.statusCode).toBe(429);
    expect(locked.code).toBe('TOO_MANY_REQUESTS');
    expect(locked.reason).toBe('OTP_LOCKED');
    expect(locked.retryAfterSeconds).toBe(9);
    expect(locked.details).toEqual({ reason: 'OTP_LOCKED', retryAfterSeconds: 9 });

    const wrong = new OtpError(401, 'wrong', { reason: 'OTP_INVALID', attemptsRemaining: 4 });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.code).toBe('UNAUTHORIZED');
    expect(wrong.retryAfterSeconds).toBeUndefined();
    expect(wrong.name).toBe('OtpError');
  });
});

describe('reserveOtpSend', () => {
  it('takes the first send and starts both clocks', async () => {
    const n = freshNumber();

    await expect(reserveOtpSend(n)).resolves.toEqual({
      resendAfterSeconds: 60,
      sendsRemaining: 2,
    });

    const cooldownTtl = await redis.ttl(`otp-cooldown:${n}`);
    const windowTtl = await redis.ttl(`otp-send:${n}`);
    expect(cooldownTtl).toBeGreaterThan(0);
    expect(cooldownTtl).toBeLessThanOrEqual(60);
    expect(windowTtl).toBeGreaterThan(60);
    expect(windowTtl).toBeLessThanOrEqual(600);
  });

  it('refuses a second send inside the cooldown with the seconds left', async () => {
    const n = freshNumber();
    await reserveOtpSend(n);

    const err = await refusal(reserveOtpSend(n));
    expect(err.statusCode).toBe(429);
    expect(err.reason).toBe('OTP_RESEND_TOO_SOON');
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it('gives two taps in the same instant one code and one refusal', async () => {
    const n = freshNumber();

    const outcomes = await Promise.allSettled([reserveOtpSend(n), reserveOtpSend(n)]);
    const granted = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter((o) => o.status === 'rejected');

    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason.reason).toBe('OTP_RESEND_TOO_SOON');
    // The refusal did not consume budget: one send is on the clock, not two.
    expect(await redis.get(`otp-send:${n}`)).toBe('1');
  });

  it('caps a number at three sends in ten minutes and gives the cooldown back on refusal', async () => {
    const n = freshNumber();
    const cooldown = `otp-cooldown:${n}`;

    expect((await reserveOtpSend(n)).sendsRemaining).toBe(2);
    await redis.del(cooldown);
    expect((await reserveOtpSend(n)).sendsRemaining).toBe(1);
    await redis.del(cooldown);
    expect((await reserveOtpSend(n)).sendsRemaining).toBe(0);
    await redis.del(cooldown);

    const fourth = await refusal(reserveOtpSend(n));
    expect(fourth.reason).toBe('OTP_RESEND_LIMIT');
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(600);

    // The cap refusal released the cooldown it had claimed, so the next answer
    // is the same honest refusal rather than a spurious "too soon".
    expect(await redis.exists(cooldown)).toBe(0);
    const fifth = await refusal(reserveOtpSend(n));
    expect(fifth.reason).toBe('OTP_RESEND_LIMIT');
  });
});

describe('the lockout', () => {
  it('counts down four wrong guesses and locks on the fifth', async () => {
    const n = freshNumber();

    for (const remaining of [4, 3, 2, 1]) {
      await expect(registerOtpFailure(n)).resolves.toEqual({ locked: false, attemptsRemaining: remaining });
    }

    const before = Date.now();
    const outcome = await registerOtpFailure(n);
    expect(outcome.locked).toBe(true);
    if (!outcome.locked) throw new Error('unreachable');

    expect(outcome.retryAfterSeconds).toBe(900);
    const lockedUntil = Date.parse(outcome.lockedUntil);
    expect(lockedUntil).toBeGreaterThanOrEqual(before + 900_000 - 1_000);
    expect(lockedUntil).toBeLessThanOrEqual(Date.now() + 900_000 + 1_000);

    // The slate is wiped with the lock, so the pause has a known end and
    // nothing carries over past it.
    expect(await redis.exists(`otp-fail:${n}`)).toBe(0);
    expect(await redis.get(`otp-lock:${n}`)).toBe(outcome.lockedUntil);
  });

  it('refuses a locked number with the same lockedUntil and the seconds left', async () => {
    const n = freshNumber();
    for (let i = 0; i < OTP_LOCK_THRESHOLD; i += 1) await registerOtpFailure(n);
    const lockedUntil = await redis.get(`otp-lock:${n}`);

    const err = await refusal(assertOtpNotLocked(n));
    expect(err.statusCode).toBe(429);
    expect(err.reason).toBe('OTP_LOCKED');
    expect(err.details).toMatchObject({ reason: 'OTP_LOCKED', lockedUntil });
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it('lets an unlocked number through', async () => {
    await expect(assertOtpNotLocked(freshNumber())).resolves.toBeUndefined();
  });

  it('starts the count again once a correct code clears it', async () => {
    const n = freshNumber();
    await registerOtpFailure(n);
    await registerOtpFailure(n);

    await clearOtpFailures(n);

    await expect(registerOtpFailure(n)).resolves.toEqual({ locked: false, attemptsRemaining: 4 });
  });

  it('keeps the count on a fifteen-minute clock', async () => {
    const n = freshNumber();
    await registerOtpFailure(n);

    const ttl = await redis.ttl(`otp-fail:${n}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });
});
