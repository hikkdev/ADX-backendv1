import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors/api-error';
import { verifyAccessToken } from './jwt';
import type { Role } from '../database';

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing authorization header');
  }

  const token = header.slice(7);
  try {
    req.user = verifyAccessToken(token);
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }

  next();
}

export function requireRole(...roles: Role[]) {
  const guard = (req: Request, _res: Response, next: NextFunction): void => {
    const userRoles = req.user?.roles ?? [];
    const hasRole = roles.some((r) => userRoles.includes(r));
    if (!hasRole) {
      throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions');
    }
    next();
  };
  // Name encodes the roles so the route-inventory snapshot records which
  // roles guard each route, not just that some guard exists. Metadata only.
  Object.defineProperty(guard, 'name', { value: `requireRole(${roles.join('|')})`, configurable: true });
  return guard;
}
