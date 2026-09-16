import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logging/logger';
import { logActivity } from './activity-log';

/**
 * The universal admin-write audit tap — Lot A, Q28.
 *
 * Mounted once in create-app ahead of the routers, it does nothing until the
 * response finishes. Then, for a request that was a write (not GET/HEAD/
 * OPTIONS), succeeded (2xx), came from an ADMIN, and was not already audited
 * by hand (`res.locals.audited`, set by `logActivity` when it is given the
 * request), it writes one generic row: which module, which route template,
 * which target — and the *shape* of the input (body keys, params, query
 * keys), never its values. A password in a body must not end up in a table
 * every admin can read.
 *
 * It is a net under the hand-written rows, not a replacement for them. A
 * row that says `WALLET_ADJUSTED` with a diff is better than one that says
 * `wallets.POST /wallets/:id/adjust`; the second exists so the first being
 * forgotten is a gap in quality rather than a hole.
 */

const API_PREFIX = '/api/v1';
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** cuid, cuid2, uuid, and plain numbers — what an id looks like in a URL. */
const ID_SHAPED = /^(c[a-z0-9]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

interface RouteShape {
  baseUrl: string;
  path: string;
  params: Record<string, string | string[] | undefined>;
  route?: { path: string | RegExp | (string | RegExp)[] } | undefined;
}

function stripPrefix(path: string): string {
  return path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) || '/' : path;
}

/**
 * The route as it was registered, not as it was called: `/orders/:orderId/
 * milestones/:milestoneId/approve`. Express keeps the leaf in `req.route.path`
 * and the resolved mount prefix in `req.baseUrl`; the prefix's parameters
 * are put back by matching the segment against the request's param values.
 * Without a matched route (a 2xx from middleware) id-shaped segments are
 * replaced with `:id`.
 */
export function routeTemplate(req: RouteShape): string {
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(req.params)) {
    if (typeof value === 'string' && value.length > 0) values.set(value, name);
  }
  const templated = (segment: string): string => {
    const named = values.get(segment);
    if (named) return `:${named}`;
    return ID_SHAPED.test(segment) ? ':id' : segment;
  };
  const base = req.baseUrl.split('/').map(templated).join('/');
  const leaf =
    req.route && typeof req.route.path === 'string'
      ? req.route.path
      : req.path.split('/').map(templated).join('/');
  const joined = `${base}${leaf === '/' ? '' : leaf}`.replace(/\/{2,}/g, '/');
  return stripPrefix(joined.length > 1 ? joined.replace(/\/$/, '') : joined);
}

/** `rate-cards` → `RateCard`; `legal` → `Legal`; `kyc` → `Kyc`. */
export function singularModel(module: string): string {
  return module
    .split('-')
    .filter(Boolean)
    .map((part, index, parts) => {
      const word = index === parts.length - 1 && part.length > 3 && part.endsWith('s') && !part.endsWith('ss') ? part.slice(0, -1) : part;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

/**
 * What the write was about: the first parameter ending in `Id` names both the
 * type and the row (`orderId` → Order); a bare `id` is the module's own model.
 */
export function targetOf(
  params: Record<string, string | string[] | undefined>,
  module: string,
): { targetType: string | undefined; targetId: string | undefined } {
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !value) continue;
    if (name.length > 2 && name.endsWith('Id')) {
      const stem = name.slice(0, -2);
      return { targetType: stem.charAt(0).toUpperCase() + stem.slice(1), targetId: value };
    }
  }
  const id = params['id'];
  if (typeof id === 'string' && id) return { targetType: singularModel(module), targetId: id };
  return { targetType: undefined, targetId: undefined };
}

function moduleOf(originalUrl: string): string {
  const path = stripPrefix(originalUrl.split('?')[0] ?? '');
  return path.split('/').find(Boolean) ?? 'root';
}

export function auditAdminWrites(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (READ_METHODS.has(req.method)) return;
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const user = req.user;
    if (!user || !user.roles.includes('ADMIN')) return;
    if (res.locals['audited'] === true) return;

    const module = moduleOf(req.originalUrl);
    const template = routeTemplate(req as unknown as RouteShape);
    const params = req.params as Record<string, string | string[] | undefined>;
    const { targetType, targetId } = targetOf(params, module);
    const body = req.body;

    void logActivity(user.sub, `${module}.${req.method} ${template}`, {
      req,
      module,
      targetType,
      targetId,
      metadata: {
        bodyKeys: body && typeof body === 'object' ? Object.keys(body as object) : [],
        params,
        queryKeys: Object.keys(req.query ?? {}),
        status: res.statusCode,
      },
    }).catch((cause: unknown) => {
      logger.warn('Admin write audit row failed', {
        requestId: req.requestId,
        action: `${module}.${req.method} ${template}`,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    });
  });
  next();
}
