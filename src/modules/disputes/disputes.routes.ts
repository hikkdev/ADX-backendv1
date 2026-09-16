import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  evidenceHandler,
  getHandler,
  messageHandler,
  mineHandler,
  queueHandler,
  raiseHandler,
  releaseCreditHandler,
  rateResolutionHandler,
  reopenHandler,
  resolveHandler,
  statusHandler,
  summaryHandler,
} from './disputes.controller';

export const disputeRouter = Router();
disputeRouter.use(authenticate);

/* Self-serve first, ops second; the fixed paths sit above /:disputeId so
 * "my" and "summary" are never read as a case id. */
disputeRouter.get('/my', asyncHandler(mineHandler));
disputeRouter.get('/summary', requireRole('ADMIN'), asyncHandler(summaryHandler));
disputeRouter.get('/', requireRole('ADMIN'), asyncHandler(queueHandler));
disputeRouter.post('/', asyncHandler(raiseHandler));

disputeRouter.get('/:disputeId', asyncHandler(getHandler));
disputeRouter.post('/:disputeId/messages', asyncHandler(messageHandler));
disputeRouter.post('/:disputeId/evidence', asyncHandler(evidenceHandler));
disputeRouter.post('/:disputeId/reopen', asyncHandler(reopenHandler));
/* DR 07's RATE RESOLUTION: the raiser, once, on a decided case. */
disputeRouter.post('/:disputeId/rate', asyncHandler(rateResolutionHandler));

/* ADX decides. Every one of these is logged with who did it. */
disputeRouter.patch('/:disputeId/status', requireRole('ADMIN'), asyncHandler(statusHandler));
disputeRouter.post('/:disputeId/resolve', requireRole('ADMIN'), asyncHandler(resolveHandler));
disputeRouter.post('/:disputeId/credit/release', requireRole('ADMIN'), asyncHandler(releaseCreditHandler));
