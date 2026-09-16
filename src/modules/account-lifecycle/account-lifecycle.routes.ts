import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import { requireFeature } from '../feature-flags';
import * as h from './account-lifecycle.controller';
import { latestDataExportHandler, requestDataExportHandler } from './data-export/data-export.controller';

/**
 * The closure and erasure routes hang off `/users`, because that is where the
 * console and the app reach for them, but they live on this router rather than
 * in the users module's routes file.
 *
 * One owner, one guard, one place to read the whole feature -- the same
 * arrangement `suspension` uses for `/listings/:id/suspend`. The alternative
 * was `users` importing the twelve modules a closure review touches, and
 * `users` is imported by six modules itself, so that is a cycle waiting for
 * the first one of them to need a closure.
 *
 * Mounted at `/users` AHEAD of `userRouter`, which is load-bearing:
 * `GET /users/closure-cases` and `GET /users/erasure` would otherwise be
 * matched by that router's `GET /:id` and answered as "no such user". See
 * bootstrap/register-modules.
 *
 * The guard is per route rather than `router.use(authenticate)` for the same
 * reason the suspension router does it that way: this router sees every
 * request under `/users`, and an authentication layer on it would answer 401
 * for `POST /users/bootstrap-admin` -- the deliberately public first-run
 * escape hatch that lives below it.
 */
export const accountLifecycleRouter = Router();

const admin = [authenticate, requireRole('ADMIN')] as const;

/* -- The person's own two asks -- registered first so `me` is never an id. -- */

accountLifecycleRouter.post(
  '/me/closure-request',
  authenticate,
  asyncHandler(h.requestOwnClosureHandler),
);
accountLifecycleRouter.post('/me/erasure', authenticate, asyncHandler(h.requestOwnErasureHandler));
/* G6 (Q104): a copy of the person's own records — asked for here, built by
 * jobs/data-export.job.ts, read back here. */
/* G10: behind the `users.data-export` kill switch — the job is declared on the same key. */
accountLifecycleRouter.post('/me/data-export', authenticate, requireFeature('users.data-export'), asyncHandler(requestDataExportHandler));
accountLifecycleRouter.get('/me/data-export', authenticate, requireFeature('users.data-export'), asyncHandler(latestDataExportHandler));

/* -- The queues. Literal paths, ahead of the `/:id` routes below. -- */

accountLifecycleRouter.get('/closure-cases', ...admin, asyncHandler(h.listClosureCasesHandler));
accountLifecycleRouter.post(
  '/closure-cases/:id/decide',
  ...admin,
  asyncHandler(h.decideClosureCaseHandler),
);

accountLifecycleRouter.get('/erasure', ...admin, asyncHandler(h.listErasureHandler));
/* The DPO's signature. Its own permission group, so a role that holds every
 * settings permission still does not hold this one. */
accountLifecycleRouter.post(
  '/erasure/:id/approve',
  ...admin,
  requirePermission('dpo.erasure'),
  asyncHandler(h.approveErasureHandler),
);
accountLifecycleRouter.post('/erasure/:id/refuse', ...admin, asyncHandler(h.refuseErasureHandler));
accountLifecycleRouter.post(
  '/erasure/:id/execute',
  ...admin,
  asyncHandler(h.executeErasureHandler),
);

/* -- One account at a time. -- */

accountLifecycleRouter.get('/:id/closure-review', ...admin, asyncHandler(h.closureReviewHandler));
accountLifecycleRouter.post('/:id/closure-cases', ...admin, asyncHandler(h.openClosureCaseHandler));
accountLifecycleRouter.post('/:id/erasure', ...admin, asyncHandler(h.requestErasureHandler));
/* E6: the open request the account page reads before it offers the button. */
accountLifecycleRouter.get('/:id/erasure', ...admin, asyncHandler(h.openErasureHandler));
