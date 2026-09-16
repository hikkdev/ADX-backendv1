/**
 * Admin overview — the console's month in numbers (Lot B, Q30/Q80), the
 * analytics set (Lot G, Q115) and the dashboard insights (Lot G, Q112).
 *
 * Only the router leaves. A read-only reporting module: it sums across the
 * tables other modules own and writes nothing, and its repository port is
 * aggregates and window-scoped facts only so that stays true.
 */
export { adminOverviewRouter } from './admin-overview.routes';
export type { MonthOverview } from './admin-overview.service';
export type { AnalyticsSeries, AnalyticsTiles, BreakdownRow } from './analytics.service';
export type { DashboardInsights, Insight } from './insights.service';

// Lot G (answer 144): the module's feature declarations, loaded with the module so the registry sees them at boot.
import './features';
