import rateLimit from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { redis } from '../cache/redis';

// Counters live in Redis (keyed by IP, namespaced per prefix) rather than
// in-process memory, so limits hold across instances instead of resetting
// per-process or being divided by however many instances are running.
function redisStore(prefix: string): RedisStore {
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) =>
      redis.call(...(args as [string, ...string[]])) as Promise<RedisReply>,
  });
}

// Password-based login is brute-forceable (unlike OTP, which requires an SMS
// to be sent per attempt), so throttle it per-IP.
export const passwordAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again later.' },
  store: redisStore('rl:password-auth:'),
});

// Google sign-in is not brute-forceable — an ID token is RSA-signed by Google,
// so there is nothing to guess. This limiter exists for the other cost: every
// unverifiable token can force a JWKS refetch against Google, and each accepted
// one writes a refresh-token row. Its own budget, rather than sharing the
// password limiter's, so a burst of Google attempts cannot lock a legitimate
// user out of password login.
export const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again later.' },
  store: redisStore('rl:google-auth:'),
});

// Guards against SMS/email-bombing a number via repeated send-OTP calls from
// one IP. A per-account limit in otp.service.ts backs this up against the
// same abuse spread across many IPs.
export const otpRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many OTP requests. Please try again later.' },
  store: redisStore('rl:otp-request:'),
});

// Looser than the send limiter — each OTP already caps wrong guesses at 5
// attempts (otp.service.ts), this just stops rapid-fire automation across
// many codes/mobiles from a single IP.
export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again later.' },
  store: redisStore('rl:otp-verify:'),
});

// Refresh tokens are 256-bit random values, so brute force isn't realistic —
// this is just cheap insurance against abuse/DoS on the token endpoints.
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please try again later.' },
  store: redisStore('rl:refresh:'),
});
