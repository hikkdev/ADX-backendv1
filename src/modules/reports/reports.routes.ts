import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  catalogueHandler,
  onboardingBoardHandler,
  createScheduleHandler,
  deleteScheduleHandler,
  getRunHandler,
  getScheduleHandler,
  listRunsHandler,
  listSchedulesHandler,
  runFileHandler,
  runHandler,
  signedLinkOrAdmin,
  updateScheduleHandler,
} from './reports.controller';

/**
 * /reports — Lot G (Q129/Q143). ADMIN at the router, with one exception
 * registered ahead of the guard: the run's file, which a scheduled report's
 * recipient opens from a signed, time-limited link with no account. That
 * route carries its own guard (`signedLinkOrAdmin`) — the link, or an
 * ADMIN bearer token — and nothing else is reachable without a token.
 */
export const reportsRouter = Router();

reportsRouter.get('/runs/:id/file', signedLinkOrAdmin, asyncHandler(runFileHandler));

reportsRouter.use(authenticate, requireRole('ADMIN'));
reportsRouter.get('/catalogue', catalogueHandler);
// QR-14: the team onboarding board, on screen — the same rows the 'onboarding-board' report exports.
reportsRouter.get('/boards/onboarding', asyncHandler(onboardingBoardHandler));
reportsRouter.post('/run', asyncHandler(runHandler));
reportsRouter.get('/runs', asyncHandler(listRunsHandler));
reportsRouter.get('/runs/:id', asyncHandler(getRunHandler));
reportsRouter.get('/schedules', asyncHandler(listSchedulesHandler));
reportsRouter.post('/schedules', asyncHandler(createScheduleHandler));
reportsRouter.get('/schedules/:id', asyncHandler(getScheduleHandler));
reportsRouter.patch('/schedules/:id', asyncHandler(updateScheduleHandler));
reportsRouter.delete('/schedules/:id', asyncHandler(deleteScheduleHandler));
