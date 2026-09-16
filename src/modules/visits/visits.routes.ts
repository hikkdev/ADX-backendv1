import { Router } from 'express';

import { authenticate, requireRole } from '../../shared/auth';
import { asyncHandler } from '../../shared/http';
import {
  acceptVisitHandler,
  adminVisitsHandler,
  completeVisitHandler,
  createVisitHandler,
  getVisitHandler,
  myDayHandler,
  myVisitsHandler,
  patchVisitHandler,
  rejectVisitHandler,
  scheduleVisitHandler,
  startVisitHandler,
  visitLocationHandler,
} from './visits.controller';

export const visitRouter = Router();

visitRouter.use(authenticate);

/* The agent's own list, declared before '/:visitId' so "mine" is never read as
 * an id. Not role-gated beyond a session: both agent sides make visits. */
visitRouter.get('/mine', asyncHandler(myVisitsHandler));

/* The dispatch board — the cross-agent view that did not exist. */
visitRouter.get('/', requireRole('ADMIN'), asyncHandler(adminVisitsHandler));

/* An agent books for themselves; ADX dispatches to a named agent and it is an
 * offer with the 25-minute clock. Same route, told apart by the role. */
visitRouter.post('/', asyncHandler(createVisitHandler));

visitRouter.get('/:visitId', asyncHandler(getVisitHandler));
visitRouter.post('/:visitId/accept', asyncHandler(acceptVisitHandler));
visitRouter.post('/:visitId/reject', asyncHandler(rejectVisitHandler));
visitRouter.post('/:visitId/schedule', asyncHandler(scheduleVisitHandler));
visitRouter.post('/:visitId/start', asyncHandler(startVisitHandler));
visitRouter.post('/:visitId/complete', asyncHandler(completeVisitHandler));
/* G12-B: the live-position ping on the way to the visit — the order lane's
 * body; the visit's own agent. */
visitRouter.post('/:visitId/update-location', asyncHandler(visitLocationHandler));
visitRouter.patch('/:visitId', requireRole('ADMIN'), asyncHandler(patchVisitHandler));

/**
 * GET /agents/me/day. Mounted there by bootstrap — an agent's own things live
 * under /agents/me — but owned here, because the day is made of visits.
 */
export const agentDayRouter = Router();
agentDayRouter.use(authenticate);
agentDayRouter.get('/', asyncHandler(myDayHandler));
