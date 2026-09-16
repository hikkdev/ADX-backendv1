import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { featureAnswer } from './feature-flags.service';
import type { FlagSubject } from './feature-flags.types';

/** The caller as the rollout rules see them: the token's subject and roles; the city comes through the port when a rule needs it. */
export function subjectFromRequest(req: Request): FlagSubject {
  return req.user ? { id: req.user.sub, roles: req.user.roles ?? [] } : {};
}

/**
 * Lot G (answer 144): the kill switch on a route.
 *
 * `requireFeature('campaigns.landing-pages')` on a router or a route answers
 * 503 FEATURE_OFF `{ key }` when the flag is off for the caller — the
 * rollout rules evaluated on the token's subject, roles and (through the
 * city port) city — and lets the request through otherwise. It also
 * declares coverage: the architecture test reads it off the chain, so a
 * route behind it needs no prefix in `features.ts`.
 *
 * A state read that fails (the table unreachable) lets the request through
 * and logs: a kill switch is for a buggy feature, and turning a flags-table
 * hiccup into a platform-wide 503 would be the bigger outage. Named like
 * requireRole so the route inventory records which feature guards a route.
 */
export function requireFeature(key: string) {
  const guard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    await assertFeatureOn(key, req);
    next();
  };
  Object.defineProperty(guard, 'name', { value: `requireFeature(${key})`, configurable: true });
  return guard;
}

/**
 * G10: the same kill switch on a route that only sometimes asks for the
 * feature — a listing write that opts into instant booking, a campaign
 * write that names a second market. The predicate reads the request (its
 * body, usually) and the flag is evaluated only when it holds, so the
 * ordinary write never touches the flags table. Named apart from
 * `requireFeature` on purpose: the architecture test must not read it as
 * full coverage of the route, which stays under its module's prefix.
 */
export function requireFeatureWhen(key: string, when: (req: Request) => boolean) {
  const guard = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (when(req)) await assertFeatureOn(key, req);
    next();
  };
  Object.defineProperty(guard, 'name', { value: `requireFeatureWhen(${key})`, configurable: true });
  return guard;
}

async function assertFeatureOn(key: string, req: Request): Promise<void> {
  let on = true;
  try {
    on = (await featureAnswer(key, subjectFromRequest(req))).enabled;
  } catch (err) {
    logger.warn('feature state unreadable; letting the request through', {
      key,
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  if (!on) throw new ApiError(503, 'FEATURE_OFF', 'This feature is switched off', { key });
}
