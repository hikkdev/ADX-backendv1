import { Router } from 'express';
import { authenticate, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import { reinstateHandlerFor, suspendHandlerFor, suspensionHandler } from './suspension.controller';

/**
 * The suspension routes sit on the party's own path — `/listings/:id/suspend`,
 * `/agents/:id/reinstate` — because that is where the console reaches for
 * them, but they live on this router rather than in each module's routes file.
 *
 * One writer, one guard, one place to read the whole feature. The alternative
 * was the same eight handlers scattered across four modules, each importing
 * this service and each free to drift on its role guard.
 *
 * Mounted at the API root, ahead of the party routers, so `/listings/:id/...`
 * is matched here first rather than passing through a router whose only answer
 * would be a 404. See bootstrap/register-modules.
 *
 * The guard is per route rather than `router.use(...)` for exactly that
 * reason: a router mounted at the root sees every request under `/api/v1`, and
 * an authentication layer on it would answer 401 for every unknown path on the
 * whole API instead of letting it fall through to the 404 handler.
 */
export const suspensionRouter = Router();

const admin = [authenticate, requireRole('ADMIN')] as const;

suspensionRouter.post('/listings/:id/suspend', ...admin, asyncHandler(suspendHandlerFor('LISTING')));
suspensionRouter.post('/listings/:id/reinstate', ...admin, asyncHandler(reinstateHandlerFor('LISTING')));

suspensionRouter.post('/publishers/:id/suspend', ...admin, asyncHandler(suspendHandlerFor('PUBLISHER')));
suspensionRouter.post('/publishers/:id/reinstate', ...admin, asyncHandler(reinstateHandlerFor('PUBLISHER')));

suspensionRouter.post('/advertisers/:id/suspend', ...admin, asyncHandler(suspendHandlerFor('ADVERTISER')));
suspensionRouter.post('/advertisers/:id/reinstate', ...admin, asyncHandler(reinstateHandlerFor('ADVERTISER')));

suspensionRouter.post('/agents/:id/suspend', ...admin, asyncHandler(suspendHandlerFor('AGENT')));
suspensionRouter.post('/agents/:id/reinstate', ...admin, asyncHandler(reinstateHandlerFor('AGENT')));

suspensionRouter.get('/suspension/:partyType/:partyId', ...admin, asyncHandler(suspensionHandler));
