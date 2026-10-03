import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requirePermission, requireRole } from '../../shared/auth';
import { publicReadLimiter } from '../../shared/security';
import {
  archiveHandler,
  createHandler,
  discardDraftHandler,
  fieldKindsHandler,
  getHandler,
  listHandler,
  publicFormHandler,
  publishHandler,
  restoreFormHandler,
  restoreHandler,
  saveDraftHandler,
  submissionGate,
  submissionStatusHandler,
  submissionsCsvHandler,
  submissionsHandler,
  submissionsMapHandler,
  submitHandler,
  updateHandler,
  versionsHandler,
} from './forms.controller';

/**
 * `/app/forms` — the public door. The form is read signed out (the website
 * and both apps draw it from a page's Form block); an answer's guard is the
 * form's own: captcha + the per-IP limiter for a PUBLIC form, a token for a
 * SIGNED_IN one (`submissionGate`).
 */
export const appFormRouter = Router();
appFormRouter.get('/:key', publicReadLimiter, asyncHandler(publicFormHandler));
appFormRouter.post('/:key/submissions', asyncHandler(submissionGate), asyncHandler(submitHandler));

/** `/forms` — the desk. Read with content.view, edit with content.edit, discard/archive with content.delete, publish and restore with content.approve. */
export const formRouter = Router();
formRouter.use(authenticate, requireRole('ADMIN'));
formRouter.get('/', requirePermission('content.view'), asyncHandler(listHandler));
// Above `/:key` so "field-kinds" is never read as a form key.
formRouter.get('/field-kinds', requirePermission('content.view'), asyncHandler(fieldKindsHandler));
formRouter.post('/', requirePermission('content.edit'), asyncHandler(createHandler));
formRouter.get('/:key', requirePermission('content.view'), asyncHandler(getHandler));
formRouter.patch('/:key', requirePermission('content.edit'), asyncHandler(updateHandler));
formRouter.put('/:key/draft', requirePermission('content.edit'), asyncHandler(saveDraftHandler));
formRouter.delete('/:key/draft', requirePermission('content.delete'), asyncHandler(discardDraftHandler));
formRouter.post('/:key/publish', requirePermission('content.approve'), asyncHandler(publishHandler));
formRouter.get('/:key/versions', requirePermission('content.view'), asyncHandler(versionsHandler));
formRouter.post('/:key/versions/:number/restore', requirePermission('content.approve'), asyncHandler(restoreHandler));
formRouter.post('/:key/archive', requirePermission('content.delete'), asyncHandler(archiveHandler));
formRouter.post('/:key/restore-form', requirePermission('content.edit'), asyncHandler(restoreFormHandler));
formRouter.get('/:key/submissions', requirePermission('content.view'), asyncHandler(submissionsHandler));
formRouter.get('/:key/submissions.csv', requirePermission('content.view'), asyncHandler(submissionsCsvHandler));
formRouter.get('/:key/submissions/map', requirePermission('content.view'), asyncHandler(submissionsMapHandler));
formRouter.patch('/:key/submissions/:id', requirePermission('content.edit'), asyncHandler(submissionStatusHandler));
