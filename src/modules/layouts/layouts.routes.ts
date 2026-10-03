import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, authenticateOptional, requirePermission, requireRole } from '../../shared/auth';
import {
  blockTypesHandler,
  discardDraftHandler,
  getHandler,
  listHandler,
  previewHandler,
  previewTokenHandler,
  publishHandler,
  resolveHandler,
  restoreHandler,
  saveDraftHandler,
  versionsHandler,
} from './layouts.controller';

/**
 * `/app/layouts/:surface` — public. The website is read signed out and both
 * apps read it on every home open; a token, when sent, is read as its side.
 * Cached in process for sixty seconds (resolve.cache.ts), so it keeps
 * answering while Redis is down — which is also why it carries no
 * Redis-backed rate limiter.
 */
export const appLayoutRouter = Router();
appLayoutRouter.get('/:surface', authenticateOptional, asyncHandler(resolveHandler));

/** `/layouts` — the desk. Read with content.view, draft with content.edit (discard with content.delete — every DELETE names a delete power), publish and restore with content.approve. */
export const layoutRouter = Router();
layoutRouter.use(authenticate, requireRole('ADMIN'));
layoutRouter.get('/', requirePermission('content.view'), asyncHandler(listHandler));
// Above `/:surface` so "block-types" is never read as a surface.
layoutRouter.get('/block-types', requirePermission('content.view'), asyncHandler(blockTypesHandler));
layoutRouter.get('/:surface', requirePermission('content.view'), asyncHandler(getHandler));
layoutRouter.put('/:surface/draft', requirePermission('content.edit'), asyncHandler(saveDraftHandler));
layoutRouter.delete('/:surface/draft', requirePermission('content.delete'), asyncHandler(discardDraftHandler));
layoutRouter.get('/:surface/preview', requirePermission('content.view'), asyncHandler(previewHandler));
// PB-1: a day's token for the real page to show the draft (`GET /app/layouts/:surface?preview=`).
layoutRouter.post('/:surface/preview-token', requirePermission('content.view'), asyncHandler(previewTokenHandler));
layoutRouter.post('/:surface/publish', requirePermission('content.approve'), asyncHandler(publishHandler));
layoutRouter.get('/:surface/versions', requirePermission('content.view'), asyncHandler(versionsHandler));
layoutRouter.post('/:surface/versions/:number/restore', requirePermission('content.approve'), asyncHandler(restoreHandler));
