import { redis } from '../shared/cache';
import { ApiError } from '../shared/errors';

// Account-scoped lockout, independent of passwordAuthLimiter's per-IP limit
// in rateLimit.ts — that one is blind to the same account being brute-forced
// from many different IPs.
const FAIL_LIMIT = 5;
const FAIL_WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 15 * 60;

function failKey(email: string): string {
  return `login-fail:${email}`;
}

function lockKey(email: string): string {
  return `login-lock:${email}`;
}

export async function assertAccountNotLocked(email: string): Promise<void> {
  const locked = await redis.get(lockKey(email));
  if (locked) {
    throw new ApiError(
      429,
      'TOO_MANY_REQUESTS',
      'Too many failed login attempts. Please try again in a few minutes or reset your password.',
    );
  }
}

export async function registerFailedLogin(email: string): Promise<void> {
  const key = failKey(email);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, FAIL_WINDOW_SECONDS);
  if (count >= FAIL_LIMIT) {
    await redis.set(lockKey(email), '1', 'EX', LOCK_SECONDS);
  }
}

export async function clearFailedLogins(email: string): Promise<void> {
  await redis.del(failKey(email));
}
