import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  backfillHandler,
  getFormatHandler,
  listFormatsHandler,
  previewFormatHandler,
  updateFormatHandler,
} from './identifiers.controller';

export const identifierRouter = Router();
identifierRouter.use(authenticate);

identifierRouter.get('/formats', requireRole('ADMIN'), asyncHandler(listFormatsHandler));
identifierRouter.get('/formats/:party', requireRole('ADMIN'), asyncHandler(getFormatHandler));
identifierRouter.patch('/formats/:party', requireRole('ADMIN'), asyncHandler(updateFormatHandler));
identifierRouter.post('/formats/preview', requireRole('ADMIN'), asyncHandler(previewFormatHandler));

/* Issues identifiers to parties that predate the feature. Idempotent. */
identifierRouter.post('/backfill/publishers', requireRole('ADMIN'), asyncHandler(backfillHandler));
