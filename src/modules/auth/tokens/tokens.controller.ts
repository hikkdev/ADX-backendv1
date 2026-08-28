import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { signAccessToken } from '../../../shared/auth';
import type { Role } from '../../../shared/database';
import { logoutSchema, refreshSchema } from '../auth.schema';
import { prismaAuthRepository as repository } from '../prisma-auth.repository';
import { sessionMeta } from '../auth.session';
import { revokeRefreshToken, rotateRefreshToken } from './tokens.service';

export async function refreshTokenHandler(req: Request, res: Response): Promise<void> {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  let userId: string;
  let newRaw: string;
  try {
    ({ userId, newRaw } = await rotateRefreshToken(parsed.data.refreshToken, sessionMeta(req)));
  } catch {
    // Every rotation failure — unknown, expired, or a reuse that just revoked
    // the whole session family — reports the same message.
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
  }

  const user = await repository.findUserWithRoles(userId);
  if (!user || !user.isActive) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Account not active');
  }

  const roles = user.roles.map((r) => r.role) as Role[];

  // Refresh renews a session rather than starting one, so it re-signs the
  // access token directly and leaves lastLoginAt alone.
  const accessToken = signAccessToken(userId, roles);

  res.json({ success: true, data: { accessToken, refreshToken: newRaw } });
}

export async function logoutHandler(req: Request, res: Response): Promise<void> {
  const parsed = logoutSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  }

  await revokeRefreshToken(parsed.data.refreshToken);

  res.json({ success: true, data: { message: 'Logged out' } });
}
