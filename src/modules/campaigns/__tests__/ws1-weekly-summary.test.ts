import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WS-1 — the weekly campaign summary.
 *
 * What is pinned: the audience is every advertiser with campaign activity
 * in the window; each gets ONE notify of WEEKLY_CAMPAIGN_SUMMARY under the
 * WEEKLY_SUMMARY kind with the window's figures; an advertiser with no
 * login, or nothing to say, is skipped; one failure does not stop the rest;
 * the Monday-morning and week-key helpers read Indian time.
 */
const { repository, notify, portfolioAnalytics } = vi.hoisted(() => ({
  repository: { advertisersWithCampaignActivity: vi.fn(), advertiserContext: vi.fn() },
  notify: vi.fn(),
  portfolioAnalytics: vi.fn(),
}));
vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
vi.mock('../../notifications', () => ({ notify }));
vi.mock('../analytics.service', () => ({ portfolioAnalytics }));

import { isMondayMorningIST, runWeeklySummaries, weekKeyIST, weekLabel } from '../weekly-summary.service';

const analytics = (over: Record<string, unknown> = {}) => ({
  totalReach: { value: 12500, basis: 'footfall' },
  clickRate: { value: 2.1, basis: '' },
  activeCampaigns: { value: 2, basis: '' },
  budgetSpent: { value: '48000.00', basis: '', onTrack: true },
  series: [
    { day: '2026-09-15', spend: '1000.00', scans: 40, clicks: 12 },
    { day: '2026-09-16', spend: '1000.00', scans: 35, clicks: 9 },
  ],
  comparison: {},
  campaigns: [
    { id: 'cmp_1', reference: 'ADX-CMP-1', name: 'Diwali burst', status: 'LIVE', spend: '30000.00' },
    { id: 'cmp_2', reference: 'ADX-CMP-2', name: 'Monsoon sale', status: 'COMPLETED', spend: '18000.00' },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.advertisersWithCampaignActivity.mockResolvedValue([{ advertiserId: 'adv_1' }, { advertiserId: 'adv_2' }, { advertiserId: 'adv_3' }]);
  repository.advertiserContext.mockImplementation(async (id: string) => (id === 'adv_2' ? { id, userId: null } : { id, userId: `usr_${id}`, name: 'Anita' }));
  portfolioAnalytics.mockImplementation(async (actor: { advertiserId: string }) => (actor.advertiserId === 'adv_3' ? analytics({ campaigns: [] }) : analytics()));
  notify.mockResolvedValue({ notificationId: 'n_1', templateKey: 'weekly-campaign-summary', deliveries: [] });
});

describe('runWeeklySummaries', () => {
  it('sends one digest per advertiser with a login and something to say, with the window figures', async () => {
    const now = new Date('2026-09-21T04:00:00Z'); // Monday 09:30 IST
    const result = await runWeeklySummaries(now, { link: 'https://adx.in/advertiser/campaigns' });
    expect(result).toEqual({ advertisers: 3, sent: 1, skipped: 2 });
    expect(portfolioAnalytics).toHaveBeenCalledWith({ userId: 'usr_adv_1', isAdmin: false, advertiserId: 'adv_1', agentId: null }, { days: 7 }, now);
    expect(notify).toHaveBeenCalledTimes(1);
    const [event, userId, vars, opts] = notify.mock.calls[0] as [string, string, Record<string, string>, { type: string; inApp: { type: string; title: string } }];
    expect(event).toBe('WEEKLY_CAMPAIGN_SUMMARY');
    expect(userId).toBe('usr_adv_1');
    expect(vars).toMatchObject({ name: 'Anita', weekLabel: '14–20 Sep 2026', campaigns: '2', live: '1', reach: '12,500', scans: '75', clicks: '21', spend: '48000.00', topCampaign: 'Diwali burst', link: 'https://adx.in/advertiser/campaigns' });
    expect(opts.type).toBe('WEEKLY_SUMMARY');
    expect(opts.inApp.type).toBe('WEEKLY_SUMMARY');
    expect(opts.inApp.title).toBe('Your ADX week, 14–20 Sep 2026');
  });

  it('one advertiser failing does not stop the rest', async () => {
    portfolioAnalytics.mockImplementationOnce(async () => { throw new Error('boom'); });
    repository.advertisersWithCampaignActivity.mockResolvedValue([{ advertiserId: 'adv_1' }, { advertiserId: 'adv_4' }]);
    const result = await runWeeklySummaries(new Date('2026-09-21T04:00:00Z'));
    expect(result).toEqual({ advertisers: 2, sent: 1, skipped: 1 });
  });
});

describe('the clock', () => {
  it('is Monday morning from 09:00 IST, and the week is keyed on its Monday', () => {
    expect(isMondayMorningIST(new Date('2026-09-21T03:29:00Z'))).toBe(false); // 08:59 IST
    expect(isMondayMorningIST(new Date('2026-09-21T03:30:00Z'))).toBe(true); // 09:00 IST
    expect(isMondayMorningIST(new Date('2026-09-22T04:00:00Z'))).toBe(false); // Tuesday
    expect(weekKeyIST(new Date('2026-09-24T10:00:00Z'))).toBe('2026-09-21');
    expect(weekLabel(new Date('2026-10-01T04:00:00Z'))).toBe('24–30 Sep 2026');
    expect(weekLabel(new Date('2026-10-03T04:00:00Z'))).toBe('26 Sep–2 Oct 2026');
  });
});
