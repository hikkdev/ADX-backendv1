import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import {
  backfillHandler,
  getFormatHandler,
  listFormatsHandler,
  previewFormatHandler,
  updateFormatHandler,
} from './identifiers.controller';

export const identifierRouter = Router();
identifierRouter.use(authenticate);

identifierRouter.get('/formats', requireRole('ADMIN'), requirePermission('settings.view'), asyncHandler(listFormatsHandler));
identifierRouter.get('/formats/:party', requireRole('ADMIN'), requirePermission('settings.view'), asyncHandler(getFormatHandler));
identifierRouter.patch('/formats/:party', requireRole('ADMIN'), requirePermission('settings.edit'), asyncHandler(updateFormatHandler));
identifierRouter.post('/formats/preview', requireRole('ADMIN'), requirePermission('settings.view'), asyncHandler(previewFormatHandler));

/* Issues identifiers to parties that predate the feature. Idempotent. */
identifierRouter.post('/backfill/publishers', requireRole('ADMIN'), requirePermission('system.jobs'), asyncHandler(backfillHandler));
