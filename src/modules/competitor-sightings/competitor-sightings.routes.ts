import { Router } from 'express';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import { analyseSightingHandler, exportSightingsHandler, getSightingHandler, listSightingsHandler, logSightingHandler, sightingBrandsHandler } from './competitor-sightings.controller';

/**
 * VA-2: `/competitor-sightings`.
 *
 * An agent files one; everything else is the desk's. The literal paths sit
 * above `/:id` so `export` and `brands` are never read as an id.
 */
export const competitorSightingRouter = Router();
competitorSightingRouter.use(authenticate);

competitorSightingRouter.post('/', requireRole('AGENT_PUBLISHER', 'AGENT_ADVERTISER'), asyncHandler(logSightingHandler));
competitorSightingRouter.get('/', requireRole('ADMIN'), requirePermission('marketplace.view'), asyncHandler(listSightingsHandler));
competitorSightingRouter.get('/brands', requireRole('ADMIN'), requirePermission('marketplace.view'), asyncHandler(sightingBrandsHandler));
competitorSightingRouter.get('/export', requireRole('ADMIN'), requirePermission('marketplace.export'), asyncHandler(exportSightingsHandler));
competitorSightingRouter.get('/:id', requireRole('ADMIN'), requirePermission('marketplace.view'), asyncHandler(getSightingHandler));
competitorSightingRouter.post('/:id/analyse', requireRole('ADMIN'), requirePermission('marketplace.edit'), asyncHandler(analyseSightingHandler));
