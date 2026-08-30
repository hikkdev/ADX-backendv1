import type { Request } from 'express';
import { signAccessToken } from '../../shared/auth';
import type { Role } from '../../shared/database';
import { createRefreshToken, type SessionMeta } from './tokens/tokens.service';
import { prismaAuthRepository as repository } from './prisma-auth.repository';

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
 */
export async function startSession(
  userId: string,
  roles: Role[],
  meta: SessionMeta,
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signAccessToken(userId, roles);

  // The refresh-token INSERT and the lastLoginAt UPDATE touch different tables
  // and neither reads the other's result, so running them sequentially just
  // paid two round trips where one would do. With the database in another
  // region that was ~85ms of pure latency per login, for nothing.
  const [refreshToken] = await Promise.all([
    createRefreshToken(userId, meta),
    repository.recordLogin(userId),
  ]);

  return { accessToken, refreshToken };
}
