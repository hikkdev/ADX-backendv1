import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import { statusPageLimiter, statusSubscribeLimiter } from '../../shared/security';
import {
  addIncidentUpdateHandler,
  confirmSubscriptionHandler,
  createIncidentHandler,
  getIncidentHandler,
  getOpsHealthHandler,
  getRegionsHandler,
  getSystemHealthHistoryHandler,
  listIncidentsHandler,
  patchIncidentHandler,
  publicStatusHandler,
  subscribeHandler,
  unsubscribeHandler,
} from './ops.controller';

/**
 * Mounted at /settings/system-health, beside the platform settings row it
 * complements: `/settings/platform` is what ops set, this is what ops check.
 * ADMIN at the router — there is no non-admin reading of the backup state.
 */
export const opsRouter = Router();
opsRouter.use(authenticate, requireRole('ADMIN'));
opsRouter.get('/ops', asyncHandler(getOpsHealthHandler));
/* E6: the heartbeats and the 30-day 5xx series, for the page's graphs; Lot G adds the per-service sample series. */
opsRouter.get('/history', asyncHandler(getSystemHealthHistoryHandler));
/* Lot G (Q130): the region this API runs in, with a live round trip. */
opsRouter.get('/regions', asyncHandler(getRegionsHandler));
/* Lot G (Q130): the incident log. */
opsRouter.get('/incidents', asyncHandler(listIncidentsHandler));
opsRouter.post('/incidents', asyncHandler(createIncidentHandler));
opsRouter.get('/incidents/:id', asyncHandler(getIncidentHandler));
opsRouter.post('/incidents/:id/updates', asyncHandler(addIncidentUpdateHandler));
opsRouter.patch('/incidents/:id', asyncHandler(patchIncidentHandler));

/**
 * Lot G (Q130): the public status page, root-mounted (`/status`, not under
 * `/api/v1`) like the scan redirect and the package link — it is read
 * during an outage by people with no account, and its confirm and
 * unsubscribe links are sent by email. No authentication; every route is
 * rate-limited by IP, the subscribe form tighter because it sends a mail.
 */
export const statusRouter = Router();
statusRouter.get('/status', statusPageLimiter, asyncHandler(publicStatusHandler));
statusRouter.post('/status/subscribe', statusSubscribeLimiter, asyncHandler(subscribeHandler));
statusRouter.get('/status/confirm/:token', statusPageLimiter, asyncHandler(confirmSubscriptionHandler));
statusRouter.get('/status/unsubscribe/:token', statusPageLimiter, asyncHandler(unsubscribeHandler));
