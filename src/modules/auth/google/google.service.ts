import crypto from 'crypto';
import jwt, { type JwtHeader } from 'jsonwebtoken';
import { env } from '../../../config/env';
import { ApiError } from '../../../shared/errors';
import { logger } from '../../../shared/logging';

/**
 * Verifies the ID token Google Identity Services hands the browser.
 *
 * Deliberately not `google-auth-library`: the whole job is one JWKS fetch and
 * an RS256 verify, both of which `jsonwebtoken` and node's `crypto` already do.
 * Same call made for Turnstile and Digio — a plain `fetch` against a documented
 * endpoint rather than a vendor SDK.
 *
 * This file is the *stateless* half of Google sign-in, mirroring the split in
 * `shared/auth/jwt`: it proves who the caller is and nothing more. Deciding
 * whether that person may have a session — the account must already exist and
 * be active — belongs to the controller.
 */

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

// Google publishes both spellings and has never committed to one, so both are
// accepted. Anything else is not Google.
const ISSUERS: [string, ...string[]] = ['https://accounts.google.com', 'accounts.google.com'];

// Small skew allowance: an ID token minted seconds ago fails `iat` validation
// on a host whose clock runs a little fast.
const CLOCK_TOLERANCE_SECONDS = 30;

/** The subset of Google's ID token claims this codebase reads. */
export interface GoogleIdentity {
  /** Google's stable, immutable account id. Never reused across accounts. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  /** Workspace domain. Absent on personal (gmail.com) accounts. */
  hostedDomain?: string;
}

/* ------------------------------------------------------------------ */
/* JWKS cache                                                          */
/* ------------------------------------------------------------------ */

type Jwk = { kid: string; kty: string; alg?: string; use?: string; n: string; e: string };

let keyCache: Map<string, crypto.KeyObject> | null = null;
let keyCacheExpiresAt = 0;

// The `kid` is attacker-controlled — it is read from an unverified token header
// — and a miss is what triggers a refetch. Without these three guards, a caller
// sending a fresh random kid per request turns this endpoint into an amplifier
// pointed at Google, one outbound request per inbound one.
//
//   inFlight        collapses concurrent misses into a single fetch
//   refetch budget  caps miss-driven fetches per minute. A budget rather than a
//                   fixed interval on purpose: a real key rotation still gets
//                   through on its first attempt, which a hard cooldown would
//                   have stalled for up to a minute.
//   FETCH_TIMEOUT   stops a hung response from pinning an Express request
let inFlight: Promise<Map<string, crypto.KeyObject>> | null = null;
let refetchWindowStart = 0;
let refetchCount = 0;
const MAX_REFETCHES_PER_WINDOW = 5;
const REFETCH_WINDOW_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** Spends one refetch from the current window's budget. False when exhausted. */
function claimRefetchBudget(): boolean {
  const now = Date.now();
  if (now - refetchWindowStart > REFETCH_WINDOW_MS) {
    refetchWindowStart = now;
    refetchCount = 0;
  }
  if (refetchCount >= MAX_REFETCHES_PER_WINDOW) return false;
  refetchCount += 1;
  return true;
}

// Google rotates signing keys roughly daily and the endpoint's Cache-Control
// says exactly how long the current set is good for. Honour it, but clamp: a
// missing or absurd max-age must not mean "never refresh" or "refetch on
// every login".
const MIN_CACHE_SECONDS = 5 * 60;
const MAX_CACHE_SECONDS = 24 * 60 * 60;

function cacheSecondsFrom(header: string | null): number {
  const maxAge = header?.match(/max-age=(\d+)/)?.[1];
  const seconds = maxAge ? Number(maxAge) : MIN_CACHE_SECONDS;
  return Math.min(Math.max(seconds, MIN_CACHE_SECONDS), MAX_CACHE_SECONDS);
}

async function fetchSigningKeys(): Promise<Map<string, crypto.KeyObject>> {
  let response: Response;
  try {
    response = await fetch(JWKS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    // `{ err }` alone serialises to `{}` — Error's message and stack are
    // non-enumerable, and the logger walks own enumerable properties.
    logger.error('Google JWKS request failed', { reason: (err as Error).message });
    throw new ApiError(503, 'INTERNAL_ERROR', 'Google sign-in is temporarily unavailable');
  }

  if (!response.ok) {
    logger.error('Google JWKS returned a non-OK status', { status: response.status });
    throw new ApiError(503, 'INTERNAL_ERROR', 'Google sign-in is temporarily unavailable');
  }

  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = new Map<string, crypto.KeyObject>();

  for (const jwk of body.keys ?? []) {
    // Only RSA signing keys can carry the RS256 tokens Google issues. Google
    // publishes nothing else on this endpoint, so the `use`/`alg` checks are
    // defence in depth — but they are one `&&` away, and they keep an
    // encryption key from ever being accepted as a signature key. Skip rather
    // than throw, so one odd entry cannot discard the whole set.
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    if (jwk.use && jwk.use !== 'sig') continue;
    if (jwk.alg && jwk.alg !== 'RS256') continue;
    try {
      const key = crypto.createPublicKey({ key: jwk as crypto.webcrypto.JsonWebKey, format: 'jwk' });
      keys.set(jwk.kid, key);
    } catch (err) {
      logger.warn('Skipping unusable Google signing key', {
        kid: jwk.kid,
        reason: (err as Error).message,
      });
    }
  }

  if (keys.size === 0) {
    logger.error('Google JWKS contained no usable RSA keys');
    throw new ApiError(503, 'INTERNAL_ERROR', 'Google sign-in is temporarily unavailable');
  }

  keyCache = keys;
  keyCacheExpiresAt = Date.now() + cacheSecondsFrom(response.headers.get('cache-control')) * 1000;
  return keys;
}

/** Collapses concurrent refreshes into one outbound request. */
function refreshSigningKeys(): Promise<Map<string, crypto.KeyObject>> {
  if (inFlight) return inFlight;

  inFlight = fetchSigningKeys().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Returns the public key for `kid`, refetching once on a miss.
 *
 * A cached set that predates a rotation is the expected way to miss, so the
 * miss itself is not an error — it is the trigger to refresh.
 */
async function signingKeyFor(kid: string): Promise<crypto.KeyObject> {
  const fresh = keyCache && Date.now() < keyCacheExpiresAt;
  if (fresh) {
    const cached = keyCache!.get(kid);
    if (cached) return cached;

    // A miss against a still-fresh cache is almost always a made-up kid rather
    // than a rotation, so it spends from a capped budget. A rotation lands well
    // inside that budget; a caller cycling random kids exhausts it and gets a
    // 401 without another request leaving for Google.
    if (!claimRefetchBudget()) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Google sign-in could not be verified');
    }
  }

  const refreshed = await refreshSigningKeys();
  const key = refreshed.get(kid);
  if (!key) {
    // Signed by a key Google does not publish — not a token we can trust.
    throw new ApiError(401, 'UNAUTHORIZED', 'Google sign-in could not be verified');
  }
  return key;
}

/** Test seam: drops the cached JWKS so a suite can control what gets fetched. */
export function resetGoogleKeyCache(): void {
  keyCache = null;
  keyCacheExpiresAt = 0;
  inFlight = null;
  refetchWindowStart = 0;
  refetchCount = 0;
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

function allowedDomains(): string[] {
  return env.GOOGLE_ALLOWED_DOMAINS.split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

/** True when Google sign-in is configured; the route 503s when it is not. */
export function isGoogleSignInConfigured(): boolean {
  return !!env.GOOGLE_CLIENT_ID;
}

type GoogleIdTokenClaims = {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  picture?: string;
  hd?: string;
};

/**
 * Verifies a Google ID token and returns the identity it asserts.
 *
 * Every failure is a 401 carrying one generic message. The specific reason —
 * wrong audience, expired, bad signature, unverified email — is logged, not
 * returned, so the endpoint tells an attacker nothing about why a forged token
 * was rejected.
 *
 * Domain rejection is the deliberate exception: it is 403 with a message that
 * names the problem, because an employee who picked their personal Gmail
 * account in the Google popup needs to be told to pick the other one.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new ApiError(503, 'INTERNAL_ERROR', 'Google sign-in is not configured');
  }

  const decoded = jwt.decode(idToken, { complete: true });
  const kid = (decoded?.header as JwtHeader | undefined)?.kid;
  if (!decoded || !kid) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Google sign-in could not be verified');
  }

  const key = await signingKeyFor(kid);

  let claims: GoogleIdTokenClaims;
  try {
    claims = jwt.verify(idToken, key, {
      // Pinned, not read from the token's own header — otherwise a forged
      // token could nominate a weaker algorithm.
      algorithms: ['RS256'],
      // `aud` must be this deployment's client ID. A token minted for some
      // other Google app is a perfectly valid Google token and still must not
      // log anyone in here.
      audience: env.GOOGLE_CLIENT_ID,
      issuer: ISSUERS,
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }) as GoogleIdTokenClaims;
  } catch (err) {
    logger.warn('Google ID token rejected', { reason: (err as Error).message });
    throw new ApiError(401, 'UNAUTHORIZED', 'Google sign-in could not be verified');
  }

  if (!claims.sub || !claims.email) {
    logger.warn('Google ID token missing sub or email');
    throw new ApiError(401, 'UNAUTHORIZED', 'Google sign-in could not be verified');
  }

  // Google sends a real boolean on ID tokens but the string "true" on some
  // legacy endpoints. Accept both, and nothing else.
  const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
  if (!emailVerified) {
    // An unverified address proves nothing about who controls the mailbox,
    // and the account match downstream is made on email.
    logger.warn('Google sign-in rejected: email not verified');
    throw new ApiError(401, 'UNAUTHORIZED', 'Google sign-in could not be verified');
  }

  const domains = allowedDomains();
  const hostedDomain = claims.hd?.toLowerCase();
  if (domains.length > 0 && (!hostedDomain || !domains.includes(hostedDomain))) {
    throw new ApiError(403, 'FORBIDDEN', 'Use your work Google account to sign in to ADX Admin.');
  }

  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified,
    ...(claims.name ? { name: claims.name } : {}),
    ...(claims.picture ? { picture: claims.picture } : {}),
    ...(hostedDomain ? { hostedDomain } : {}),
  };
}
