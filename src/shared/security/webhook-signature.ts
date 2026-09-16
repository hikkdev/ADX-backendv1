import crypto from 'crypto';

/**
 * HMAC verification for inbound provider webhooks.
 *
 * A webhook endpoint is an unauthenticated write. Whatever it changes, anyone
 * on the internet can ask it to change — unless the body carries a signature
 * only the provider could have produced. That is the entire security model, so
 * the checks below are deliberately strict about every way it can go wrong.
 */

export type SignatureResult =
  | { ok: true }
  | { ok: false; reason: 'NO_SECRET' | 'NO_SIGNATURE' | 'NO_BODY' | 'MISMATCH' };

/**
 * Constant-time compare of two hex digests.
 *
 * `===` on strings returns as soon as it finds a differing character, and that
 * timing difference is enough to recover a signature byte by byte given enough
 * attempts. `timingSafeEqual` throws on length mismatch, so that is checked
 * first — and checked on the *buffers*, since a hex string of the wrong length
 * is a malformed signature rather than a near miss.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verifies an HMAC-SHA256 signature over the raw request body.
 *
 * Fails closed on every path, including a missing secret. A verifier that
 * accepts everything when unconfigured is worse than no verifier at all: it
 * reads as protection in code review and provides none in production, and the
 * day someone deploys without the environment variable is the day the endpoint
 * silently reverts to accepting anything.
 */
export function verifyHmacSignature(input: {
  rawBody: Buffer | undefined;
  signature: string | undefined;
  secret: string | undefined;
}): SignatureResult {
  if (!input.secret) return { ok: false, reason: 'NO_SECRET' };
  if (!input.signature) return { ok: false, reason: 'NO_SIGNATURE' };
  if (!input.rawBody || input.rawBody.length === 0) return { ok: false, reason: 'NO_BODY' };

  const expected = crypto
    .createHmac('sha256', input.secret)
    .update(input.rawBody)
    .digest('hex');

  // Providers differ on casing and on whether they prefix the algorithm.
  // Normalising here rather than pinning one format means a provider changing
  // their presentation does not read as an attack.
  const offered = input.signature.trim().replace(/^sha256=/i, '').toLowerCase();

  return safeEqual(expected, offered) ? { ok: true } : { ok: false, reason: 'MISMATCH' };
}

/** What to tell an operator when verification fails, without leaking the digest. */
export const signatureFailureMessage: Record<
  Exclude<SignatureResult, { ok: true }>['reason'],
  string
> = {
  NO_SECRET: 'Webhook secret is not configured, so this endpoint cannot verify callers',
  NO_SIGNATURE: 'Request carried no signature header',
  NO_BODY: 'Request had no body to verify',
  MISMATCH: 'Signature did not match the request body',
};
