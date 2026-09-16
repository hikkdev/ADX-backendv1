import { redis } from '../cache/redis';
import { logger } from '../logging/logger';
import { env } from '../../config/env';

/**
 * Session revocation for stateless access tokens.
 *
 * A refresh token is a row and can be revoked; an access token is a signed
 * claim and cannot — it stays valid until it expires. So a revocation writes
 * a marker, `auth:revoked:<userId>` = the moment of revocation, and
 * authenticate() refuses any token for that user issued before it. The
 * marker lives exactly as long as an access token can, because after that
 * every token it could refuse has expired on its own.
 *
 * The check is one Redis GET per request, memoised in-process for a few
 * seconds so a page that fans out into a dozen calls pays one round trip.
 * The instance that writes the marker drops its own memo at once; another
 * instance sees it within `REVOCATION_MEMO_MS`. If Redis cannot be reached
 * the check fails OPEN and logs: the refresh token is already revoked by
 * then, so the exposure is one access-token lifetime, and a Redis outage
 * must not turn every authenticated route into a 401.
 */

export const REVOCATION_KEY_PREFIX = 'auth:revoked:';
export const REVOCATION_MEMO_MS = 10_000;

/** `15m`, `12h`, `900s`, `2d` → seconds. Falls back to 15 minutes. */
export function accessTokenLifetimeSeconds(): number {
  const match = String(env.JWT_ACCESS_EXPIRES_IN).trim().match(/^(\d+)\s*([smhd])?$/);
  if (!match?.[1]) return 15 * 60;
  const n = parseInt(match[1], 10);
  const unit = match[2] ?? 's';
  const factor = unit === 'd' ? 86_400 : unit === 'h' ? 3_600 : unit === 'm' ? 60 : 1;
  return n * factor;
}

export const revocationKey = (userId: string): string => `${REVOCATION_KEY_PREFIX}${userId}`;

type Memo = { issuedBefore: number | null; checkedAt: number };
const memo = new Map<string, Memo>();

/** Test seam, and what a fresh marker on this instance calls. */
export function clearRevocationMemo(userId?: string): void {
  if (userId === undefined) memo.clear();
  else memo.delete(userId);
}

/**
 * Records that every token for `userId` issued before now is refused.
 *
 * `issuedBefore` is seconds since the epoch — the same unit as a JWT `iat` —
 * rounded DOWN, so a token minted in the same second as the revocation
 * survives (under a second of exposure) rather than a re-login in that
 * second being refused for a whole token lifetime.
 */
export async function markSessionsRevoked(userId: string, at = new Date()): Promise<number> {
  const issuedBefore = Math.floor(at.getTime() / 1000);
  await redis.set(revocationKey(userId), String(issuedBefore), 'EX', accessTokenLifetimeSeconds());
  clearRevocationMemo(userId);
  return issuedBefore;
}

async function issuedBeforeFor(userId: string): Promise<number | null> {
  const now = Date.now();
  const cached = memo.get(userId);
  if (cached && now - cached.checkedAt < REVOCATION_MEMO_MS) return cached.issuedBefore;

  const raw = await redis.get(revocationKey(userId));
  const issuedBefore = raw === null ? null : Number(raw);
  memo.set(userId, { issuedBefore: Number.isFinite(issuedBefore) ? issuedBefore : null, checkedAt: now });
  return issuedBefore;
}

/**
 * True when a token with this `iat` for this user has been revoked. A token
 * with no `iat` cannot be placed before or after the marker; it is treated
 * as revoked only if a marker exists, which is the conservative reading.
 */
export async function isTokenRevoked(userId: string, iat: number | undefined): Promise<boolean> {
  let issuedBefore: number | null;
  try {
    issuedBefore = await issuedBeforeFor(userId);
  } catch (err) {
    logger.warn('Revocation check unavailable — allowing the request', {
      userId,
      cause: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (issuedBefore === null) return false;
  if (iat === undefined) return true;
  return iat < issuedBefore;
}
