import { Router } from 'express';
import { authenticate, requireRole } from '../../shared/auth';
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

fraudRouter.get('/cases', asyncHandler(listHandler));
fraudRouter.post('/cases', asyncHandler(openHandler));
fraudRouter.get('/cases/:caseId', asyncHandler(getHandler));
fraudRouter.post('/cases/:caseId/notes', asyncHandler(noteHandler));
fraudRouter.post('/cases/:caseId/evidence', asyncHandler(evidenceHandler));
fraudRouter.patch('/cases/:caseId', asyncHandler(patchHandler));
fraudRouter.post('/cases/:caseId/decide', asyncHandler(decideHandler));
// Lot G (Q118/138): the score and its signals, the accounts they link, the escalation; a scan with no case.
fraudRouter.post('/cases/:caseId/score', asyncHandler(scoreHandler));
fraudRouter.get('/cases/:caseId/linked', asyncHandler(linkedHandler));
fraudRouter.post('/cases/:caseId/escalate', asyncHandler(escalateHandler));
fraudRouter.post('/scan/:subjectType/:subjectId', asyncHandler(scanHandler));
