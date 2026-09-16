/**
 * How far to trust `X-Forwarded-For`.
 *
 * Express reads `req.ip` off the socket unless it is told how many proxy hops
 * sit in front of it. Nothing set that, so behind any reverse proxy or CDN
 * every caller *was* the load balancer — and every per-IP limiter in
 * `shared/security/rate-limit.ts` keys on `req.ip`. The first time one fired
 * in production it would have been a global lock, not a throttle: one person
 * mistyping an OTP three times would have locked sign-in for everybody.
 *
 * The value is Express's own `trust proxy` setting, read from `TRUST_PROXY` so
 * an environment states what is in front of it rather than the code guessing:
 *
 *   (blank) / false / 0   nothing — the socket address is the client
 *   1, 2, …               that many trusted hops
 *   true                  trust the whole chain (only safe behind a proxy that
 *                         overwrites the header rather than appending to it)
 *   loopback, 10.0.0.0/8  addresses and subnets, Express's list syntax
 */
export type TrustProxy = boolean | number | string;

export function parseTrustProxy(raw: string | undefined): TrustProxy {
  const value = (raw ?? '').trim();
  if (value === '' || value.toLowerCase() === 'false' || value === '0') return false;
  if (value.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
