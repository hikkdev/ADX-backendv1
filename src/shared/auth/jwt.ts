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
export type AccessTokenPayload = {
  sub: string;
  roles: Role[];
};

export function signAccessToken(userId: string, roles: Role[]): string {
  return jwt.sign({ sub: userId, roles } as AccessTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as any,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}
