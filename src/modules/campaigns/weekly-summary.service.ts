import { logger } from '../../shared/logging';
import { notify } from '../notifications';
import { prismaCampaignsRepository as repository } from './prisma-campaigns.repository';
import { portfolioAnalytics } from './analytics.service';

/**
 * WS-1 (DR 12) — the weekly campaign summary.
 *
 * Every Monday morning (Indian time), each advertiser with a campaign that
 * ran in the last seven days gets one digest: the portfolio analytics of
 * that window — campaigns, reach, scans, clicks, spend, the best performer
 * — as an email (on by default for the WEEKLY_SUMMARY kind, switchable
 * under Notification preferences) and a push, with an in-app row so the
 * bell has it too. Non-transactional: the quiet hours and the weekly cap
 * govern it like any other digest. The job holds the week lock; this runs
 * the week.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** "15–21 Sep 2026" for the seven days ending yesterday, Indian time. */
export function weekLabel(now: Date): string {
  const end = new Date(now.getTime() + IST_OFFSET_MS - DAY_MS);
  const start = new Date(end.getTime() - 6 * DAY_MS);
  const month = (d: Date) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  return sameMonth
    ? `${start.getUTCDate()}–${end.getUTCDate()} ${month(end)} ${end.getUTCFullYear()}`
    : `${start.getUTCDate()} ${month(start)}–${end.getUTCDate()} ${month(end)} ${end.getUTCFullYear()}`;
}

/** Monday, at or after 09:00, Indian time. */
export function isMondayMorningIST(now: Date): boolean {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return shifted.getUTCDay() === 1 && shifted.getUTCHours() >= 9;
}

/** The Monday's date, Indian time, as the week's key. */
export function weekKeyIST(now: Date): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  const sinceMonday = (shifted.getUTCDay() + 6) % 7;
  return new Date(shifted.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
}

const compact = (n: number): string => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(n);

export async function runWeeklySummaries(now = new Date(), options: { link?: string } = {}): Promise<{ advertisers: number; sent: number; skipped: number }> {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const audience = await repository.advertisersWithCampaignActivity(since);
  const label = weekLabel(now);
  let sent = 0;
  let skipped = 0;
  for (const { advertiserId } of audience) {
    try {
      const context = await repository.advertiserContext(advertiserId);
      if (!context?.userId) {
        skipped += 1;
        continue;
      }
      const analytics = await portfolioAnalytics({ userId: context.userId, isAdmin: false, advertiserId, agentId: null }, { days: 7 }, now);
      if (analytics.campaigns.length === 0) {
        skipped += 1;
        continue;
      }
      const live = analytics.campaigns.filter((campaign) => campaign.status === 'LIVE').length;
      const scans = analytics.series.reduce((sum, day) => sum + day.scans, 0);
      const clicks = analytics.series.reduce((sum, day) => sum + day.clicks, 0);
      const top = [...analytics.campaigns].sort((a, b) => Number(b.spend) - Number(a.spend))[0];
      const vars = {
        name: context.name ?? 'there',
        weekLabel: label,
        campaigns: String(analytics.campaigns.length),
        live: String(live),
        reach: compact(analytics.totalReach.value ?? 0),
        scans: compact(scans),
        clicks: compact(clicks),
        spend: analytics.budgetSpent.value,
        topCampaign: top ? top.name : '—',
        link: options.link ?? '',
      };
      await notify('WEEKLY_CAMPAIGN_SUMMARY', context.userId, vars, {
        type: 'WEEKLY_SUMMARY',
        inApp: {
          type: 'WEEKLY_SUMMARY',
          title: `Your ADX week, ${label}`,
          subtitle: `${analytics.campaigns.length} campaign${analytics.campaigns.length === 1 ? '' : 's'}, ${live} live`,
          message: `Reach ${vars.reach}, ${vars.scans} scans, ${vars.clicks} clicks, INR ${vars.spend} spent. ${top ? `${top.name} led.` : ''}`.trim(),
          suggestedAction: 'Open your campaigns',
        },
      }, now);
      sent += 1;
    } catch (err) {
      skipped += 1;
      logger.warn('Could not send a weekly campaign summary', { advertiserId, err });
    }
  }
  return { advertisers: audience.length, sent, skipped };
}
