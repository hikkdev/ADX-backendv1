import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { requireFeature } from '../feature-flags';
import { cancelHandler, createHandler, getHandler, listHandler, previewCountHandler, previewDraftCountHandler, sendHandler } from './announcements.controller';

/**
 * /announcements — the broadcast desk (Lot E, Q64). ADMIN at the router,
 * the comms tiers on top: reading is `comms.view`, writing and sending
 * `comms.edit`. The literal paths carry no `me`, so nothing is order-sensitive.
 */
export const announcementRouter = Router();
announcementRouter.use(authenticate, requireRole('ADMIN'));

announcementRouter.get('/', requirePermission('comms.view'), asyncHandler(listHandler));
announcementRouter.post('/', requirePermission('comms.edit'), asyncHandler(createHandler));
/* E10-2: the reach of a draft body, before it is saved. A literal path ahead
 * of the `/:id` routes, so "preview-count" is never read as an id. */
announcementRouter.post('/preview-count', requirePermission('comms.view'), asyncHandler(previewDraftCountHandler));
announcementRouter.get('/:id', requirePermission('comms.view'), asyncHandler(getHandler));
announcementRouter.get('/:id/preview-count', requirePermission('comms.view'), asyncHandler(previewCountHandler));
/* G10: the kill switch bites the send — a draft can still be written and read while `comms.announcements` is off. */
announcementRouter.post('/:id/send', requirePermission('comms.edit'), requireFeature('comms.announcements'), asyncHandler(sendHandler));
announcementRouter.post('/:id/cancel', requirePermission('comms.edit'), asyncHandler(cancelHandler));
