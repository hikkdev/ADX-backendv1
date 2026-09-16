import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole } from '../../shared/auth';
import {
  breakdownHandler,
  dismissInsightHandler,
  exportSeriesHandler,
  insightsHandler,
  overviewHandler,
  seriesHandler,
  tilesHandler,
} from './admin-overview.controller';

export const adminOverviewRouter = Router();
adminOverviewRouter.use(authenticate, requireRole('ADMIN'));

adminOverviewRouter.get('/overview', asyncHandler(overviewHandler));
/* Lot G (Q115): the analytics set. */
adminOverviewRouter.get('/overview/series', asyncHandler(seriesHandler));
adminOverviewRouter.get('/overview/breakdown', asyncHandler(breakdownHandler));
adminOverviewRouter.get('/overview/tiles', asyncHandler(tilesHandler));
adminOverviewRouter.get('/overview/export.csv', asyncHandler(exportSeriesHandler));
/* Lot G (Q112): the dashboard insights. */
adminOverviewRouter.get('/overview/insights', asyncHandler(insightsHandler));
/* G13-B: a per-operator dismissal of one insight row. */
adminOverviewRouter.post('/overview/insights/:id/dismiss', asyncHandler(dismissInsightHandler));
