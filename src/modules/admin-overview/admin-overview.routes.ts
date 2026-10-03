import { Router } from 'express';
import { asyncHandler } from '../../shared/http';
import { authenticate, requireRole, requirePermission } from '../../shared/auth';
import {
  breakdownHandler,
  dismissInsightHandler,
  exportSeriesHandler,
  insightsHandler,
  metricsCatalogueHandler,
  metricsSeriesHandler,
  overviewHandler,
  seriesHandler,
  tilesHandler,
} from './admin-overview.controller';

export const adminOverviewRouter = Router();
adminOverviewRouter.use(authenticate, requireRole('ADMIN'));

adminOverviewRouter.get('/overview', requirePermission('marketplace.view'), asyncHandler(overviewHandler));
/* Lot G (Q115): the analytics set. */
adminOverviewRouter.get('/overview/series', requirePermission('marketplace.view'), asyncHandler(seriesHandler));
adminOverviewRouter.get('/overview/breakdown', requirePermission('marketplace.view'), asyncHandler(breakdownHandler));
adminOverviewRouter.get('/overview/tiles', requirePermission('marketplace.view'), asyncHandler(tilesHandler));
adminOverviewRouter.get('/overview/export.csv', requirePermission('marketplace.export'), asyncHandler(exportSeriesHandler));
/* Lot G (Q112): the dashboard insights. */
adminOverviewRouter.get('/overview/insights', requirePermission('marketplace.view'), asyncHandler(insightsHandler));
/* G13-B: a per-operator dismissal of one insight row. */
adminOverviewRouter.post('/overview/insights/:id/dismiss', requirePermission('marketplace.edit'), asyncHandler(dismissInsightHandler));

/**
 * AN-1: the metric registry and the series over it.
 *
 * Beside `/overview/*` rather than replacing it. The old path keeps serving
 * until the console is migrated, and a parity test holds the two to the same
 * answer for the nine metrics they share; it is retired in AN-10.
 */
adminOverviewRouter.get('/analytics/catalogue', requirePermission('marketplace.view'), asyncHandler(metricsCatalogueHandler));
adminOverviewRouter.get('/analytics/series', requirePermission('marketplace.view'), asyncHandler(metricsSeriesHandler));
