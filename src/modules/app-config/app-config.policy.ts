import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';
import { authenticate, requireRole } from '../../shared/auth';

/**
 * PUT /config accepts either of two credentials:
 *
 *  - the `x-admin-secret` header, used by the standalone flow editor, which has
 *    no login and no JWT to present;
 *  - a normal ADMIN access token.
 *
 * The header is checked first so the flow editor never needs a session. When it
 * is absent or wrong the request falls through to the ordinary JWT path, which
 * produces the usual 401 or 403.
 */
export function adminSecretOrAdminRole(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['x-admin-secret'] === env.ADMIN_SECRET) return next();
  return authenticate(req, res, () => requireRole('ADMIN')(req, res, next));
}
