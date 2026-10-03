import type { Request, Response, NextFunction } from 'express';
import { ApiError } from '../errors/api-error';
import { verifyAccessToken, type AccessTokenPayload } from './jwt';
import { isTokenRevoked } from './revocation';
import type { Role } from '../database';

/** Methods an impersonation token may use. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** One entry of the must-enrol allowlist: a method and the path it opens. */
export type EnrolmentOnlyRoute = { readonly method: 'GET' | 'POST'; readonly path: string };

/**
 * Lot K2: the routes a session carrying `mustEnrolAuthenticator` may still
 * open — enough to set the app up, see where one stands, read one's own
 * profile and sign out; nothing else. Matched on the path's tail so the
 * mount prefix (`/api/v1`) and a test app mounted at the root read alike.
 * M-B: matched on the method too — `GET /users/me` is the profile read,
 * `PATCH /users/me` is an edit and is not on the list.
 */
export const ENROLMENT_ONLY_PATHS: readonly EnrolmentOnlyRoute[] = [
  { method: 'POST', path: '/auth/2fa/totp/enrol' },
  { method: 'POST', path: '/auth/2fa/totp/confirm' },
  { method: 'GET', path: '/auth/2fa/status' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'GET', path: '/users/me' },
];

function enrolmentAllows(req: Request): boolean {
  const path = (req.originalUrl || req.url).split('?')[0]!.replace(/\/+$/, '');
  return ENROLMENT_ONLY_PATHS.some((allowed) => allowed.method === req.method && path.endsWith(allowed.path));
}

/**
 * W1 (24 Sep 2026): the website's public reads. A visitor with no session
 * may look; one who sends a token is read as themselves — the saved hearts,
 * their advertiser — and a token that is present but bad is refused exactly
 * as it is anywhere else. Never a substitute for `authenticate` on a write.
 */
export function authenticateOptional(req: Request, res: Response, next: NextFunction): void {
  if (!req.headers.authorization) {
    next();
    return;
  }
  authenticate(req, res, next);
}

/**
 * Verifies the bearer token, then two checks the signature alone cannot make:
 *
 *  - the token was not issued before the user's sessions were revoked
 *    (shared/auth/revocation — one Redis read, memoised);
 *  - a token carrying `act` (an admin reading as somebody else) is only
 *    honoured on a read. Every other method is 403 IMPERSONATION_READ_ONLY,
 *    here, so no route has to remember to check;
 *  - Lot K2: a token carrying `mustEnrolAuthenticator` opens only the
 *    enrolment routes (`ENROLMENT_ONLY_PATHS`) — 403 TOTP_ENROLMENT_REQUIRED
 *    anywhere else, here, for the same reason.
 *
 * The header and signature failures are thrown synchronously, as they
 * always were, so a bad token is a 401 before any role guard can make it a
 * 403. Only the revocation read is asynchronous, and its refusal goes
 * through `next(err)`.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing authorization header');
  }

  const token = header.slice(7);
  let payload: AccessTokenPayload;
  try {
    payload = verifyAccessToken(token);
  } catch {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
  }

  if (payload.act && !READ_METHODS.has(req.method)) {
    throw new ApiError(403, 'IMPERSONATION_READ_ONLY', 'An impersonation session can only read');
  }

  // Lot K2: one claim read and one string test — the whole cost of the
  // must-enrol state on every other request.
  if (payload.mustEnrolAuthenticator === true && !enrolmentAllows(req)) {
    throw new ApiError(403, 'TOTP_ENROLMENT_REQUIRED', 'Set up an authenticator app before continuing', {
      enrolAt: '/api/v1/auth/2fa/totp/enrol',
    });
  }

  req.user = payload;

  // The admin behind an impersonation token is checked too: revoking the
  // admin's sessions must end what they are reading as somebody else.
  const subjects: [string, number | undefined][] = [[payload.sub, payload.iat]];
  if (payload.act) subjects.push([payload.act.sub, payload.iat]);

  Promise.all(subjects.map(([userId, iat]) => isTokenRevoked(userId, iat)))
    .then((results) => {
      if (results.some(Boolean)) {
        req.user = undefined;
        next(new ApiError(401, 'UNAUTHORIZED', 'Session has been revoked'));
        return;
      }
      next();
    })
    .catch(next);
}

export function requireRole(...roles: Role[]) {
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const userRoles = req.user?.roles ?? [];
    const matched = roles.filter((r) => userRoles.includes(r));
    if (matched.length === 0) {
      throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions');
    }
    /* RP-1: an ADMIN reaches an admin route only through a console role.
       Only Super admin holds every permission; anyone else needs one
       assigned, and until then their token carries no `perms` and every
       admin route says so by name. An account that also holds a party
       role the route accepts passes as that party. */
    if (matched.every((r) => r === 'ADMIN') && (req.user?.perms ?? []).length === 0) {
      throw new ApiError(403, 'ROLE_REQUIRED', 'No console role assigned — ask a super admin to assign one');
    }
    /* RP-2: which of the route's roles admitted this token, for the
       permission guard behind it — a party the route accepts is judged by
       its role, an admin by their console role's list. */
    res.locals.matchedRoles = matched;
    next();
  };
  // Name encodes the roles so the route-inventory snapshot records which
  // roles guard each route, not just that some guard exists. Metadata only.
  Object.defineProperty(guard, 'name', { value: `requireRole(${roles.join('|')})`, configurable: true });
  return guard;
}

/**
 * Whether a token holds one permission id — exactly what its `perms` claim
 * carries, resolved at sign-in from the console role (RP-1, 24 Sep 2026).
 * Super admin's list is the whole catalogue; an admin with no role has
 * none; a token minted before the claim existed holds none either — its
 * holder signs in again and gets a resolved one. The launch rule that read
 * a claimless ADMIN token as holding everything is gone.
 */
export function hasPermission(user: Pick<AccessTokenPayload, 'roles' | 'perms'> | undefined, id: string): boolean {
  if (!user) return false;
  return (user.perms ?? []).includes(id);
}

/** The ids in `ids` the token lacks. */
export function missingPermissions(user: Pick<AccessTokenPayload, 'roles' | 'perms'> | undefined, ids: readonly string[]): string[] {
  return ids.filter((id) => !hasPermission(user, id));
}

/**
 * Refuses a request whose token lacks ANY of the permissions named. The
 * 403 body says which in `details.missing`. Named like requireRole so the
 * route inventory records what guards each route.
 *
 * RP-2 (24 Sep 2026): every admin route carries one. On a route a party role
 * may also call — a publisher accepting an agreement, an agent filing a
 * claim — the permission is what an ADMIN needs; an account the role guard
 * admitted as that party passes as the party (`res.locals.matchedRoles`,
 * stamped by `requireRole`). Without a role guard in front, the check is
 * strict.
 */
export function requirePermission(...ids: string[]) {
  const guard = (req: Request, res: Response, next: NextFunction): void => {
    const admitted = res.locals.matchedRoles as Role[] | undefined;
    if (admitted && admitted.some((r) => r !== 'ADMIN')) {
      next();
      return;
    }
    const missing = missingPermissions(req.user, ids);
    if (missing.length > 0) {
      throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions', { missing });
    }
    next();
  };
  Object.defineProperty(guard, 'name', { value: `requirePermission(${ids.join('|')})`, configurable: true });
  return guard;
}
