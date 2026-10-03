import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { handleUploadMiddleware } from '../uploads';
import {
  archiveHandler,
  getHandler,
  listHandler,
  patchHandler,
  restoreHandler,
  specsHandler,
  uploadHandler,
} from './media.controller';

export const mediaRouter = Router();

mediaRouter.use(authenticate);

/* The specs are read by the desk and by a buyer making ad artwork — an
 * advertiser, or the sales agent acting for one. Above `/:id` so "specs"
 * is never read as a picture's id. */
mediaRouter.get('/specs', requireRole('ADMIN', 'ADVERTISER', 'AGENT_ADVERTISER'), requirePermission('content.view'), asyncHandler(specsHandler));

mediaRouter.get('/', requireRole('ADMIN'), requirePermission('content.view'), asyncHandler(listHandler));
/* The guards run before the multipart body is read, so a caller who may not
 * upload never leaves a temp file behind. */
mediaRouter.post('/', requireRole('ADMIN'), requirePermission('content.edit'), handleUploadMiddleware, asyncHandler(uploadHandler));
mediaRouter.get('/:id', requireRole('ADMIN'), requirePermission('content.view'), asyncHandler(getHandler));
mediaRouter.patch('/:id', requireRole('ADMIN'), requirePermission('content.edit'), asyncHandler(patchHandler));
mediaRouter.post('/:id/archive', requireRole('ADMIN'), requirePermission('content.edit'), asyncHandler(archiveHandler));
mediaRouter.post('/:id/restore', requireRole('ADMIN'), requirePermission('content.edit'), asyncHandler(restoreHandler));
