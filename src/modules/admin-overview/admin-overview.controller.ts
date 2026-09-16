import type { Request, Response } from 'express';
import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import { breakdownQuerySchema, insightIdParamSchema, overviewQuerySchema, seriesQuerySchema, tilesQuerySchema } from './admin-overview.schema';
import { monthOverview, overviewSeries } from './admin-overview.service';
import { analyticsBreakdown, analyticsSeries, analyticsTiles, seriesCsvLines } from './analytics.service';
import { dashboardInsights, dismissInsight } from './insights.service';

const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

// GET /admin/overview?month=YYYY-MM — the console's month in numbers, cached a minute.
// E6: ?from=YYYY-MM&to=YYYY-MM answers the series instead — { from, to, months[] }.
export async function overviewHandler(req: Request, res: Response): Promise<void> {
  const parsed = overviewQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  if (parsed.data.from !== undefined && parsed.data.to !== undefined) {
    res.json({ success: true, data: await overviewSeries(parsed.data.from, parsed.data.to) });
    return;
  }
  res.json({ success: true, data: await monthOverview(parsed.data.month) });
}

// GET /admin/overview/series — Lot G (Q115): the day-granular series with the previous window beside it.
export async function seriesHandler(req: Request, res: Response): Promise<void> {
  const parsed = seriesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await analyticsSeries(parsed.data) });
}

// GET /admin/overview/breakdown — GMV, bookings and earnings by a dimension, on the list contract.
export async function breakdownHandler(req: Request, res: Response): Promise<void> {
  const parsed = breakdownQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await analyticsBreakdown(parsed.data) });
}

// GET /admin/overview/tiles — the KPI row: active listings, fill rate and the four KPIs, each against the previous window.
export async function tilesHandler(req: Request, res: Response): Promise<void> {
  const parsed = tilesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await analyticsTiles(parsed.data) });
}

// GET /admin/overview/export.csv — the series streamed, one line per bucket; the pull itself is audited.
export async function exportSeriesHandler(req: Request, res: Response): Promise<void> {
  const parsed = seriesQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  const series = await analyticsSeries(parsed.data);

  // Logged before the first byte, the way the audit trail's own export is: an
  // export that fails half-way was still an export.
  await logActivity(req.user!.sub, 'ANALYTICS_EXPORTED', {
    req,
    module: 'admin-overview',
    metadata: { ...parsed.data, buckets: series.buckets.length },
  });

  res.status(200);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="analytics-${parsed.data.from}-${parsed.data.to}-${parsed.data.granularity}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  for (const line of seriesCsvLines(series)) res.write(line);
  res.end();
}

// GET /admin/overview/insights — Lot G (Q112): the rule-based insights, only the rules with something to say.
// G13-B: the caller's own dismissals are left out.
export async function insightsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await dashboardInsights(new Date(), req.user!.sub) });
}

// POST /admin/overview/insights/:id/dismiss — G13-B: hide one row for this operator until its value changes.
export async function dismissInsightHandler(req: Request, res: Response): Promise<void> {
  const parsed = insightIdParamSchema.safeParse(req.params);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await dismissInsight(parsed.data.id, req.user!.sub) });
}
