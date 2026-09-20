import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { getManagerHandler, listReleasesHandler, publishHandler, putDraftHandler, restoreHandler } from './branding.controller';

/**
 * QR-11: Settings › Brand & theme. ADMIN at the router; the writes need
 * `settings.edit` as every other settings write does. The public read of the
 * LIVE brand stays `GET /app/branding` in app-config.
 */
export const brandingRouter = Router();
brandingRouter.use(authenticate, requireRole('ADMIN'));

brandingRouter.get('/', asyncHandler(getManagerHandler));
brandingRouter.put('/draft', requirePermission('settings.edit'), asyncHandler(putDraftHandler));
brandingRouter.post('/publish', requirePermission('settings.edit'), asyncHandler(publishHandler));
brandingRouter.get('/releases', asyncHandler(listReleasesHandler));
brandingRouter.post('/releases/:number/restore', requirePermission('settings.edit'), asyncHandler(restoreHandler));
