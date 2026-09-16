import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import type { Role } from '../database';

/**
 * Stateless access-token primitives.
 *
 * These live in shared rather than in the auth module because the
 * authenticate() middleware needs to verify a token on every request, and
 * shared infrastructure may not depend on a business module. Refresh tokens
 * are the opposite case: they are rows in the database with a lifecycle, so
 * they stay in the auth module.
 */

/** Who an impersonation token is really held by. */
export type ActingAdmin = {
  /** The admin's user id. */
  sub: string;
  /** The `ImpersonationSession` row, so the token can be ended by id. */
  sessionId: string;
};

export type AccessTokenPayload = {
  sub: string;
  roles: Role[];
  /**
   * The permission ids this session holds (shared/auth/permissions). Resolved
   * at session start and on refresh: an ADMIN with no role config holds every
   * id (the launch rule); one with a role holds that role's list; everyone
   * else holds none. Absent on tokens minted before it existed — see
   * `hasPermission` for how those are read.
   */
  perms?: string[];
  /**
   * The refresh-token row this access token was issued beside — the session.
   * Carried so a device can recognise its own row in the sessions list
   * (DR 07's "This device"). Absent on tokens minted before it existed.
   */
  sid?: string;
  /**
   * Present only on an impersonation token: the admin acting as `sub`.
   * authenticate() refuses every non-GET request that carries it.
   */
  act?: ActingAdmin;
  /** `read` on an impersonation token; absent otherwise. */
  scope?: 'read';
  /**
   * Lot K2: the platform requires an authenticator app of every admin and
   * this one has not enrolled yet. The session was earned with a code to
   * the phone or the mailbox, so it is real — but `authenticate()` lets it
   * open only the enrolment, status, logout and /users/me routes until the
   * app is set up (403 TOTP_ENROLMENT_REQUIRED elsewhere). Absent otherwise.
   */
  mustEnrolAuthenticator?: true;
  /** Seconds since the epoch, stamped by jsonwebtoken. Compared against the revocation marker. */
  iat?: number;
  exp?: number;
};

export type SignAccessTokenOptions = {
  perms?: string[] | undefined;
  /** Lot K2: stamp the must-enrol claim. */
  mustEnrolAuthenticator?: boolean | undefined;
};

export function signAccessToken(
  userId: string,
  roles: Role[],
  sessionId?: string,
  options: SignAccessTokenOptions = {},
): string {
  const payload: AccessTokenPayload = {
    sub: userId,
    roles,
    ...(options.perms ? { perms: options.perms } : {}),
    ...(sessionId ? { sid: sessionId } : {}),
    ...(options.mustEnrolAuthenticator ? { mustEnrolAuthenticator: true as const } : {}),
  };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as any,
  });
}

/** How long an admin may read as somebody else on one token. */
export const IMPERSONATION_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * A read-only token for `targetId`, carrying who is really holding it. Signed
 * with the same secret as an access token so authenticate() reads it the same
 * way; the `act` claim is what makes it different, and what the read-only
 * guard keys on.
 */
export function signImpersonationToken(
  targetId: string,
  roles: Role[],
  act: ActingAdmin,
  perms: string[] = [],
): string {
  const payload: AccessTokenPayload = { sub: targetId, roles, perms, act, scope: 'read' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: IMPERSONATION_TOKEN_TTL_SECONDS });
}

/**
 * Verifies an access token. Refuses anything signed with the access secret
 * that is not an access token: a 2FA challenge token carries `purpose` and
 * no roles, and must never open an authenticated route.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as Record<string, unknown>;
  if (typeof payload !== 'object' || payload === null) throw new Error('Malformed access token');
  if ('purpose' in payload) throw new Error('Not an access token');
  if (typeof payload['sub'] !== 'string' || !Array.isArray(payload['roles'])) {
    throw new Error('Not an access token');
  }
  return payload as unknown as AccessTokenPayload;
}
