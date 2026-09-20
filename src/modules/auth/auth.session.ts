import type { Request } from 'express';
import { ApiError } from '../../shared/errors';
import { signAccessToken } from '../../shared/auth';
import type { Role } from '../../shared/database';
import { issueRefreshToken, type SessionMeta } from './tokens/tokens.service';
import { prismaAuthRepository as repository } from './prisma-auth.repository';
import { resolvePermissions } from './auth.ports';

export function sessionMeta(req: Request): SessionMeta {
  return { userAgent: req.headers['user-agent'], ipAddress: req.ip };
}

/**
 * Issues the token pair for a freshly authenticated user and stamps
 * `lastLoginAt`.
 *
 * Only the login handlers call this. Refresh renews an existing session rather
 * than starting a new one, so it deliberately leaves `lastLoginAt` untouched
 * and re-signs the access token itself.
 *
 * The access token carries the permissions the person holds at this moment
 * (`perms`), resolved through `auth.ports` — a role change re-resolves them
 * by revoking the session, not by editing the token.
 */
export async function startSession(
  userId: string,
  roles: Role[],
  meta: SessionMeta,
  options: { mustEnrolAuthenticator?: boolean | undefined } = {},
): Promise<{ accessToken: string; refreshToken: string }> {
  // The refresh-token INSERT, the lastLoginAt UPDATE and the permission
  // lookup touch different tables and none reads another's result, so
  // running them sequentially just paid three round trips where one would
  // do. With the database in another region that was ~85ms of pure latency
  // per login, for nothing. The access token is signed after, because it
  // names the session row it belongs to.
  const [{ raw: refreshToken, sessionId }, , perms] = await Promise.all([
    issueRefreshToken(userId, meta),
    repository.recordLogin(userId),
    resolvePermissions(userId, roles),
  ]);
  // Lot K2: the must-enrol claim rides on the access token; authenticate()
  // reads it on every request and refresh re-decides it.
  const accessToken = signAccessToken(userId, roles, sessionId, { perms, mustEnrolAuthenticator: options.mustEnrolAuthenticator });

  return { accessToken, refreshToken };
}

/**
 * QR-2 (16 Sep 2026): re-signs the access token of a session that is still
 * running, with the roles and permissions the account holds NOW.
 *
 * The roles ride inside the access token, so a role granted after sign-in —
 * `POST /users/me/party` opening the publisher side — is invisible to
 * `requireRole` until the token expires and refresh re-reads it: fifteen
 * minutes of "Insufficient permissions" on the publisher's own home. The
 * handler that grants the role calls this and hands the new token back, so
 * the very next request carries it. The refresh token is untouched: the
 * session is the same one, only its claims moved on.
 */
export async function reissueAccessToken(userId: string, sessionId: string): Promise<string> {
  const user = await repository.findUserWithRoles(userId);
  if (!user || !user.isActive) throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  const roles = user.roles.map((r) => r.role) as Role[];
  const perms = await resolvePermissions(userId, roles);
  return signAccessToken(userId, roles, sessionId, { perms });
}
