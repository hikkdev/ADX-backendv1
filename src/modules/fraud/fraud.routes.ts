import { Router } from 'express';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import {
  decideHandler,
  escalateHandler,
  evidenceHandler,
  getHandler,
  linkedHandler,
  listHandler,
  noteHandler,
  openHandler,
  patchHandler,
  scanHandler,
  scoreHandler,
} from './fraud.controller';

/**
 * The fraud desk — ADMIN at the router. A case is opened, worked and
 * decided by ADX; the party learns of it through the suspension the decision
 * applies, never through these routes.
 */
export const fraudRouter = Router();
fraudRouter.use(authenticate, requireRole('ADMIN'));

fraudRouter.get('/cases', requirePermission('kyc.view'), asyncHandler(listHandler));
fraudRouter.post('/cases', requirePermission('kyc.edit'), asyncHandler(openHandler));
fraudRouter.get('/cases/:caseId', requirePermission('kyc.view'), asyncHandler(getHandler));
fraudRouter.post('/cases/:caseId/notes', requirePermission('kyc.edit'), asyncHandler(noteHandler));
fraudRouter.post('/cases/:caseId/evidence', requirePermission('kyc.edit'), asyncHandler(evidenceHandler));
fraudRouter.patch('/cases/:caseId', requirePermission('kyc.edit'), asyncHandler(patchHandler));
fraudRouter.post('/cases/:caseId/decide', requirePermission('kyc.approve'), asyncHandler(decideHandler));
// Lot G (Q118/138): the score and its signals, the accounts they link, the escalation; a scan with no case.
fraudRouter.post('/cases/:caseId/score', requirePermission('kyc.edit'), asyncHandler(scoreHandler));
fraudRouter.get('/cases/:caseId/linked', requirePermission('kyc.view'), asyncHandler(linkedHandler));
fraudRouter.post('/cases/:caseId/escalate', requirePermission('kyc.edit'), asyncHandler(escalateHandler));
fraudRouter.post('/scan/:subjectType/:subjectId', requirePermission('kyc.edit'), asyncHandler(scanHandler));
