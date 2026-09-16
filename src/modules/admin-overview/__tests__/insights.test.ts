import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * Lot G (Q112): the dashboard's rule-based insights. Every rule is a count or
 * a comparison over reads that already exist; only rules with something to
 * say appear; thresholds come from the platform settings row.
 */

const { repository, cache, settings } = vi.hoisted(() => ({
  repository: {
    bookingsAuthorised: vi.fn(),
    bookingsCount: vi.fn(),
    campaignSpend: vi.fn(),
    hasCampaignSpendLegs: vi.fn(),
    accrualGross: vi.fn(),
    platformRevenue: vi.fn(),
    publisherEarnings: vi.fn(),
    activeCampaigns: vi.fn(),
    newPublishers: vi.fn(),
    newAdvertisers: vi.fn(),
    kycPending: vi.fn(),
    kycPendingSubmittedBefore: vi.fn(),
    payoutBatchesInReview: vi.fn(),
    withdrawalsApprovedBefore: vi.fn(),
    fraudCasesOpenBefore: vi.fn(),
    supportTicketsBreached: vi.fn(),
    floorGraceEndingBetween: vi.fn(),
    pendingPaymentHoldsEndingBetween: vi.fn(),
  },
  cache: { readThrough: vi.fn(), invalidate: vi.fn(), redis: { mget: vi.fn(), set: vi.fn() } },
  settings: { getPlatformSettings: vi.fn() },
}));

vi.mock('../prisma-admin-overview.repository', () => ({ prismaAdminOverviewRepository: repository }));
vi.mock('../../../shared/cache', () => cache);
vi.mock('../../app-config', () => settings);

import {
  INSIGHTS_CACHE_KEY,
  INSIGHTS_CACHE_SECONDS,
  INSIGHT_DISMISSAL_TTL_SECONDS,
  dashboardInsights,
  dismissInsight,
  insightDismissalKey,
  insightValueHash,
} from '../insights.service';

/** The two sections the rules read, at the defaults `app-config` ships. */
const DEFAULT_PLATFORM_SETTINGS = {
  kyc: { reviewSlaHours: 48 },
  insights: {
    gmvDropWarnPct: 10,
    gmvDropCriticalPct: 30,
    withdrawalReleaseHours: 48,
    fraudOpenDays: 7,
    floorGraceDays: 3,
    paymentHoldHours: 2,
    criticalCount: 10,
  },
};

const D = (value: string | number) => new Decimal(value);
const HOUR = 60 * 60 * 1000;
const now = new Date('2026-09-14T06:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  cache.redis.mget.mockImplementation(async (...keys: string[]) => keys.map(() => null));
  cache.redis.set.mockResolvedValue('OK');
  settings.getPlatformSettings.mockResolvedValue(DEFAULT_PLATFORM_SETTINGS);

  repository.bookingsAuthorised.mockResolvedValue({ campaigns: D(0), packages: D(0) });
  repository.bookingsCount.mockResolvedValue(0);
  repository.hasCampaignSpendLegs.mockResolvedValue(true);
  repository.accrualGross.mockResolvedValue(D(0));
  repository.platformRevenue.mockResolvedValue(D(0));
  repository.publisherEarnings.mockResolvedValue(D(0));
  repository.activeCampaigns.mockResolvedValue(0);
  repository.newPublishers.mockResolvedValue(0);
  repository.newAdvertisers.mockResolvedValue(0);
  repository.kycPending.mockResolvedValue(0);
  // This month first, last month second — the order the service asks in.
  repository.campaignSpend.mockResolvedValueOnce(D('120000.00')).mockResolvedValueOnce(D('100000.00'));

  repository.kycPendingSubmittedBefore.mockResolvedValue(4);
  repository.payoutBatchesInReview.mockResolvedValue(1);
  repository.withdrawalsApprovedBefore.mockResolvedValue(2);
  repository.fraudCasesOpenBefore.mockResolvedValue(3);
  repository.supportTicketsBreached.mockResolvedValue(5);
  repository.floorGraceEndingBetween.mockResolvedValue(1);
  repository.pendingPaymentHoldsEndingBetween.mockResolvedValue(2);
});

describe('the insights', () => {
  it('answers every rule with something to say, each with a key, a severity, the text and the console route', async () => {
    const result = await dashboardInsights(now);
    expect(result.items.map((item) => item.key)).toEqual([
      'GMV_VS_LAST_MONTH',
      'KYC_PAST_SLA',
      'PAYOUT_BATCHES_AWAITING_APPROVAL',
      'WITHDRAWALS_AWAITING_RELEASE',
      'FRAUD_CASES_STALE',
      'SUPPORT_TICKETS_BREACHED',
      'LISTINGS_FLOOR_GRACE_ENDING',
      'CAMPAIGNS_PAYMENT_HOLD_ENDING',
    ]);
    for (const item of result.items) {
      expect(['INFO', 'WARN', 'CRITICAL']).toContain(item.severity);
      expect(item.text).toMatch(/\S/);
      expect(item.href.startsWith('/')).toBe(true);
    }
    expect(result.items.map((item) => item.href)).toEqual([
      '/analytics',
      '/kyc',
      '/finance/payouts',
      '/finance',
      '/disputes/fraud',
      '/support?breached=true',
      '/pricing/approvals',
      '/campaigns?status=PENDING_PAYMENT',
    ]);
  });

  it('compares GMV with last month as a percentage with a direction, up as INFO', async () => {
    const result = await dashboardInsights(now);
    const gmv = result.items.find((item) => item.key === 'GMV_VS_LAST_MONTH')!;
    expect(gmv).toMatchObject({ severity: 'INFO', value: 20, direction: 'UP' });
    expect(gmv.text).toContain('20.00%');
    expect(gmv.text).toContain('up');
  });

  it('reads a fall as WARN past the warn threshold and CRITICAL past the critical one', async () => {
    repository.campaignSpend.mockReset().mockResolvedValueOnce(D('85000.00')).mockResolvedValueOnce(D('100000.00'));
    const warn = (await dashboardInsights(now)).items.find((item) => item.key === 'GMV_VS_LAST_MONTH')!;
    expect(warn).toMatchObject({ severity: 'WARN', value: -15, direction: 'DOWN' });

    repository.campaignSpend.mockReset().mockResolvedValueOnce(D('60000.00')).mockResolvedValueOnce(D('100000.00'));
    const critical = (await dashboardInsights(now)).items.find((item) => item.key === 'GMV_VS_LAST_MONTH')!;
    expect(critical).toMatchObject({ severity: 'CRITICAL', value: -40 });

    // A small dip is information, not a warning.
    repository.campaignSpend.mockReset().mockResolvedValueOnce(D('97000.00')).mockResolvedValueOnce(D('100000.00'));
    expect((await dashboardInsights(now)).items.find((item) => item.key === 'GMV_VS_LAST_MONTH')).toMatchObject({ severity: 'INFO', value: -3 });
  });

  it('leaves out every rule whose value is zero', async () => {
    repository.campaignSpend.mockReset().mockResolvedValue(D(0));
    repository.kycPendingSubmittedBefore.mockResolvedValue(0);
    repository.payoutBatchesInReview.mockResolvedValue(0);
    repository.withdrawalsApprovedBefore.mockResolvedValue(0);
    repository.fraudCasesOpenBefore.mockResolvedValue(0);
    repository.supportTicketsBreached.mockResolvedValue(0);
    repository.floorGraceEndingBetween.mockResolvedValue(0);
    repository.pendingPaymentHoldsEndingBetween.mockResolvedValue(0);
    const result = await dashboardInsights(now);
    expect(result.items).toEqual([]);
  });

  it('asks each count with the cutoff its threshold names', async () => {
    await dashboardInsights(now);
    const { kyc, insights } = DEFAULT_PLATFORM_SETTINGS;
    expect(repository.kycPendingSubmittedBefore).toHaveBeenCalledWith(new Date(now.getTime() - kyc.reviewSlaHours * HOUR));
    expect(repository.withdrawalsApprovedBefore).toHaveBeenCalledWith(new Date(now.getTime() - insights.withdrawalReleaseHours * HOUR));
    expect(repository.fraudCasesOpenBefore).toHaveBeenCalledWith(new Date(now.getTime() - insights.fraudOpenDays * 24 * HOUR));
    expect(repository.supportTicketsBreached).toHaveBeenCalledWith(now);
    expect(repository.floorGraceEndingBetween).toHaveBeenCalledWith(now, new Date(now.getTime() + insights.floorGraceDays * 24 * HOUR));
    expect(repository.pendingPaymentHoldsEndingBetween).toHaveBeenCalledWith(now, new Date(now.getTime() + insights.paymentHoldHours * HOUR));
  });

  it('turns a count CRITICAL at the critical count, WARN below it, and reads the thresholds from the settings row', async () => {
    settings.getPlatformSettings.mockResolvedValue({
      ...DEFAULT_PLATFORM_SETTINGS,
      insights: { ...DEFAULT_PLATFORM_SETTINGS.insights, criticalCount: 5, withdrawalReleaseHours: 24 },
    });
    const result = await dashboardInsights(now);
    const byKey = Object.fromEntries(result.items.map((item) => [item.key, item]));
    expect(byKey['SUPPORT_TICKETS_BREACHED']).toMatchObject({ severity: 'CRITICAL', value: 5 });
    expect(byKey['KYC_PAST_SLA']).toMatchObject({ severity: 'WARN', value: 4 });
    expect(byKey['KYC_PAST_SLA']!.text).toContain('4 KYC');
    expect(repository.withdrawalsApprovedBefore).toHaveBeenCalledWith(new Date(now.getTime() - 24 * HOUR));
  });

  it('is cached a minute', async () => {
    await dashboardInsights(now);
    expect(cache.readThrough).toHaveBeenCalledWith(INSIGHTS_CACHE_KEY, INSIGHTS_CACHE_SECONDS, expect.any(Function));
    expect(INSIGHTS_CACHE_SECONDS).toBe(60);
  });
});

/* ── G13-B: a stable id per row, and a per-operator dismissal ─────────────── */

describe('dismissing an insight', () => {
  it('every row carries a stable id — the rule key, since a rule is one row', async () => {
    const result = await dashboardInsights(now);
    for (const item of result.items) expect(item.id).toBe(item.key);
  });

  it('records the dismissal under the operator, the id and the value hash for seven days', async () => {
    const result = await dismissInsight('KYC_PAST_SLA', 'admin-1', now);
    expect(result).toEqual({ id: 'KYC_PAST_SLA', dismissed: true, expiresAt: new Date(now.getTime() + INSIGHT_DISMISSAL_TTL_SECONDS * 1000).toISOString() });
    expect(cache.redis.set).toHaveBeenCalledWith(insightDismissalKey('admin-1', 'KYC_PAST_SLA'), insightValueHash({ value: 4 }), 'EX', INSIGHT_DISMISSAL_TTL_SECONDS);
    expect(INSIGHT_DISMISSAL_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it('is a 404 when the rule has nothing to say right now', async () => {
    repository.payoutBatchesInReview.mockResolvedValue(0);
    await expect(dismissInsight('PAYOUT_BATCHES_AWAITING_APPROVAL', 'admin-1', now)).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('omits a dismissed row for the caller while its value is unchanged, and nothing for another operator', async () => {
    cache.redis.mget.mockImplementation(async (...keys: string[]) =>
      keys.map((key) => (key === insightDismissalKey('admin-1', 'KYC_PAST_SLA') ? insightValueHash({ value: 4 }) : null)),
    );
    const mine = await dashboardInsights(now, 'admin-1');
    expect(mine.items.map((item) => item.key)).not.toContain('KYC_PAST_SLA');
    expect(mine.items).toHaveLength(7);

    repository.campaignSpend.mockReset().mockResolvedValueOnce(D('120000.00')).mockResolvedValueOnce(D('100000.00'));
    const theirs = await dashboardInsights(now, 'admin-2');
    expect(theirs.items.map((item) => item.key)).toContain('KYC_PAST_SLA');
  });

  it('shows the row again once the value behind it changes', async () => {
    cache.redis.mget.mockImplementation(async (...keys: string[]) =>
      keys.map((key) => (key === insightDismissalKey('admin-1', 'KYC_PAST_SLA') ? insightValueHash({ value: 4 }) : null)),
    );
    repository.kycPendingSubmittedBefore.mockResolvedValue(6);
    const result = await dashboardInsights(now, 'admin-1');
    expect(result.items.find((item) => item.key === 'KYC_PAST_SLA')).toMatchObject({ value: 6 });
  });

  it('the GMV row is dismissed by its percentage and direction', () => {
    expect(insightValueHash({ value: 20, direction: 'UP' })).not.toBe(insightValueHash({ value: 20, direction: 'DOWN' }));
    expect(insightValueHash({ value: 20, direction: 'UP' })).toBe(insightValueHash({ value: 20, direction: 'UP' }));
  });

  it('answers the unfiltered list when Redis is down rather than failing the dashboard', async () => {
    cache.redis.mget.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await dashboardInsights(now, 'admin-1');
    expect(result.items).toHaveLength(8);
  });
});
