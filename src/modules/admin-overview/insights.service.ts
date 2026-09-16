import { createHash } from 'node:crypto';
import { getPlatformSettings } from '../app-config';
import { readThrough, redis } from '../../shared/cache';
import { ApiError } from '../../shared/errors';
import { logger } from '../../shared/logging';
import { Decimal } from '../../shared/money';
import { monthOverview } from './admin-overview.service';
import { prismaAdminOverviewRepository as repository } from './prisma-admin-overview.repository';

/**
 * The dashboard's insights — Lot G (Q112): rule-based now, AI later.
 *
 * Eight rules, each a count or a comparison over reads that already exist,
 * each answering `{ key, severity, text, href }` with the console route the
 * operator should open. Only a rule with something to say appears — a zero
 * is silence, not an INFO row — so an empty list is the good news. The
 * thresholds are `getPlatformSettings().insights` (and `kyc.reviewSlaHours`
 * for the KYC rule), so ops tune them on the settings page rather than in a
 * deploy; the README lists every rule beside its threshold.
 *
 * Severity: the GMV rule is INFO on a rise or a small dip, WARN at
 * `gmvDropWarnPct` and CRITICAL at `gmvDropCriticalPct`. Every count rule is
 * WARN, and CRITICAL from `criticalCount` up.
 *
 * G13-B: every row carries a stable `id` (the rule key — a rule is one row),
 * and an operator can dismiss a row for themselves. The dismissal is a Redis
 * key per user + id holding a hash of the row's value, seven days long: the
 * row stays hidden for that operator while the rule's value is unchanged and
 * comes back the moment it moves, because a changed number is news again.
 * The computed list stays shared (one cache for every operator); only the
 * filter is per caller.
 */

export const INSIGHTS_CACHE_SECONDS = 60;
export const INSIGHTS_CACHE_KEY = 'admin-overview:insights';

export type InsightSeverity = 'INFO' | 'WARN' | 'CRITICAL';

export type InsightKey =
  | 'GMV_VS_LAST_MONTH'
  | 'KYC_PAST_SLA'
  | 'PAYOUT_BATCHES_AWAITING_APPROVAL'
  | 'WITHDRAWALS_AWAITING_RELEASE'
  | 'FRAUD_CASES_STALE'
  | 'SUPPORT_TICKETS_BREACHED'
  | 'LISTINGS_FLOOR_GRACE_ENDING'
  | 'CAMPAIGNS_PAYMENT_HOLD_ENDING';

export type Insight = {
  /** G13-B: the stable id the dismiss route takes — the rule key. */
  id: InsightKey;
  key: InsightKey;
  severity: InsightSeverity;
  text: string;
  /** The console route to open. */
  href: string;
  /** The number behind the text — a count, or the GMV percentage. */
  value: number;
  /** GMV only. */
  direction?: 'UP' | 'DOWN';
};

export type DashboardInsights = { generatedAt: string; items: Insight[] };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 5.5 * HOUR_MS;

const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`;

/** This month and the one before, as the console's YYYY-MM, in Indian time. */
function thisAndLastMonth(now: Date): [string, string] {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const label = (y: number, m: number) => `${y}-${String(m).padStart(2, '0')}`;
  return [label(year, month), month === 1 ? label(year - 1, 12) : label(year, month - 1)];
}

async function compute(now: Date): Promise<DashboardInsights> {
  const settings = await getPlatformSettings();
  const { insights: thresholds, kyc } = settings;
  const items: Insight[] = [];

  const countRule = (key: InsightKey, count: number, text: (n: number) => string, href: string) => {
    if (count <= 0) return;
    items.push({
      id: key,
      key,
      severity: count >= thresholds.criticalCount ? 'CRITICAL' : 'WARN',
      text: text(count),
      href,
      value: count,
    });
  };

  // GMV against last month: two reads the dashboard already makes, this month first.
  const [thisMonth, lastMonth] = thisAndLastMonth(now);
  const current = new Decimal((await monthOverview(thisMonth, now)).gmvRecognised);
  const previous = new Decimal((await monthOverview(lastMonth, now)).gmvRecognised);
  if (!previous.isZero() && !current.equals(previous)) {
    const pct = current.minus(previous).dividedBy(previous).times(100);
    const down = pct.isNegative();
    const magnitude = pct.abs();
    const severity: InsightSeverity =
      down && magnitude.greaterThanOrEqualTo(thresholds.gmvDropCriticalPct)
        ? 'CRITICAL'
        : down && magnitude.greaterThanOrEqualTo(thresholds.gmvDropWarnPct)
          ? 'WARN'
          : 'INFO';
    items.push({
      id: 'GMV_VS_LAST_MONTH',
      key: 'GMV_VS_LAST_MONTH',
      severity,
      text: `GMV is ${down ? 'down' : 'up'} ${magnitude.toFixed(2)}% on last month (${current.toFixed(2)} against ${previous.toFixed(2)})`,
      href: '/analytics',
      value: Number(pct.toFixed(2)),
      direction: down ? 'DOWN' : 'UP',
    });
  }

  const [kycLate, batches, withdrawals, fraud, tickets, grace, holds] = await Promise.all([
    repository.kycPendingSubmittedBefore(new Date(now.getTime() - kyc.reviewSlaHours * HOUR_MS)),
    repository.payoutBatchesInReview(),
    repository.withdrawalsApprovedBefore(new Date(now.getTime() - thresholds.withdrawalReleaseHours * HOUR_MS)),
    repository.fraudCasesOpenBefore(new Date(now.getTime() - thresholds.fraudOpenDays * DAY_MS)),
    repository.supportTicketsBreached(now),
    repository.floorGraceEndingBetween(now, new Date(now.getTime() + thresholds.floorGraceDays * DAY_MS)),
    repository.pendingPaymentHoldsEndingBetween(now, new Date(now.getTime() + thresholds.paymentHoldHours * HOUR_MS)),
  ]);

  countRule('KYC_PAST_SLA', kycLate, (n) => `${plural(n, 'KYC case')} past the ${kyc.reviewSlaHours} h review SLA`, '/kyc');
  countRule(
    'PAYOUT_BATCHES_AWAITING_APPROVAL',
    batches,
    (n) => `${plural(n, 'payout batch', 'payout batches')} awaiting a second approver`,
    '/finance/payouts',
  );
  countRule(
    'WITHDRAWALS_AWAITING_RELEASE',
    withdrawals,
    (n) => `${plural(n, 'approved withdrawal')} not released after ${thresholds.withdrawalReleaseHours} h`,
    '/finance',
  );
  countRule('FRAUD_CASES_STALE', fraud, (n) => `${plural(n, 'fraud case')} open for more than ${thresholds.fraudOpenDays} days`, '/disputes/fraud');
  countRule('SUPPORT_TICKETS_BREACHED', tickets, (n) => `${plural(n, 'support ticket')} past SLA`, '/support?breached=true');
  countRule(
    'LISTINGS_FLOOR_GRACE_ENDING',
    grace,
    (n) => `${plural(n, 'listing')} below the floor with grace ending within ${thresholds.floorGraceDays} days`,
    '/pricing/approvals',
  );
  countRule(
    'CAMPAIGNS_PAYMENT_HOLD_ENDING',
    holds,
    (n) => `${plural(n, 'campaign')} awaiting payment with the spot hold ending within ${thresholds.paymentHoldHours} h`,
    '/campaigns?status=PENDING_PAYMENT',
  );

  return { generatedAt: now.toISOString(), items };
}

/* ── G13-B: per-operator dismissal ──────────────────────────────────────── */

export const INSIGHT_DISMISSAL_TTL_SECONDS = 7 * 24 * 60 * 60;

const INSIGHT_KEYS: readonly InsightKey[] = [
  'GMV_VS_LAST_MONTH',
  'KYC_PAST_SLA',
  'PAYOUT_BATCHES_AWAITING_APPROVAL',
  'WITHDRAWALS_AWAITING_RELEASE',
  'FRAUD_CASES_STALE',
  'SUPPORT_TICKETS_BREACHED',
  'LISTINGS_FLOOR_GRACE_ENDING',
  'CAMPAIGNS_PAYMENT_HOLD_ENDING',
];

export const isInsightKey = (id: string): id is InsightKey => (INSIGHT_KEYS as readonly string[]).includes(id);

export const insightDismissalKey = (userId: string, id: string) => `admin-overview:insights:dismissed:${userId}:${id}`;

/** What "the value changed" means: the number behind the row, and the GMV direction. */
export function insightValueHash(row: { value: number; direction?: 'UP' | 'DOWN' | undefined }): string {
  return createHash('sha256').update(JSON.stringify({ value: row.value, direction: row.direction ?? null })).digest('hex').slice(0, 24);
}

/** The shared list with the caller's dismissals taken out — unfiltered when Redis is down, never failed. */
async function withoutDismissed(list: DashboardInsights, userId: string): Promise<DashboardInsights> {
  if (list.items.length === 0) return list;
  let stored: (string | null)[];
  try {
    stored = await redis.mget(...list.items.map((item) => insightDismissalKey(userId, item.id)));
  } catch (err) {
    logger.warn('insight dismissals unreadable; answering the whole list', { userId, err: err instanceof Error ? err.message : String(err) });
    return list;
  }
  const items = list.items.filter((item, index) => stored[index] !== insightValueHash(item));
  return { ...list, items };
}

/** GET /admin/overview/insights — cached a minute; the dashboard polls it. With a user, their dismissals are left out. */
export async function dashboardInsights(now = new Date(), userId?: string): Promise<DashboardInsights> {
  const list = await readThrough(INSIGHTS_CACHE_KEY, INSIGHTS_CACHE_SECONDS, () => compute(now));
  return userId ? withoutDismissed(list, userId) : list;
}

export type InsightDismissal = { id: InsightKey; dismissed: true; expiresAt: string };

/**
 * POST /admin/overview/insights/:id/dismiss — hides the row for this
 * operator until its value changes or seven days pass. A rule with nothing
 * to say right now has no row to dismiss: 404.
 */
export async function dismissInsight(id: string, userId: string, now = new Date()): Promise<InsightDismissal> {
  if (!isInsightKey(id)) throw new ApiError(404, 'NOT_FOUND', 'No such insight');
  const list = await dashboardInsights(now);
  const row = list.items.find((item) => item.id === id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'That insight has nothing to say right now');
  await redis.set(insightDismissalKey(userId, id), insightValueHash(row), 'EX', INSIGHT_DISMISSAL_TTL_SECONDS);
  return { id, dismissed: true, expiresAt: new Date(now.getTime() + INSIGHT_DISMISSAL_TTL_SECONDS * 1000).toISOString() };
}
