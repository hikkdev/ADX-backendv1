import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../../shared/errors';

/**
 * Allow a user to manage their own employee record, or an ADMIN to manage
 * anyone's.
 *
 * Named so the route-inventory snapshot records it by name in the middleware
 * chain; it guards GET and PUT on `/:userId`.
 */
export function selfOrAdmin(req: Request, _res: Response, next: NextFunction): void {
  const targetUserId = req.params['userId'];
  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');
  if (isAdmin || req.user?.sub === targetUserId) return next();
  throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions');
}
