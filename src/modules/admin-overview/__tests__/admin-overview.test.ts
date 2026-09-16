import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';
import { monthWindowIST } from '../../../shared/time';

/**
 * Lot B (Q30/Q80): the console's month in numbers.
 *
 * Two figures are easy to conflate and are kept apart on purpose. Bookings
 * authorised is what advertisers committed in the month (Campaign.total by
 * paidAt, plus package sales); GMV recognised is what actually left their
 * wallets (the CAMPAIGN_SPEND legs by the day they were posted). The take
 * rate is ADX's revenue legs over the second, never the first.
 */

const { repository, cache } = vi.hoisted(() => ({
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
  },
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
}));

vi.mock('../prisma-admin-overview.repository', () => ({ prismaAdminOverviewRepository: repository }));
vi.mock('../../../shared/cache', () => cache);

import { MAX_SERIES_MONTHS, OVERVIEW_CACHE_SECONDS, monthOverview, overviewCacheKey, overviewSeries, parseMonth } from '../admin-overview.service';

beforeEach(() => {
  vi.clearAllMocks();
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  repository.bookingsAuthorised.mockResolvedValue({ campaigns: new Decimal('118000.00'), packages: new Decimal('12000.00') });
  repository.bookingsCount.mockResolvedValue(4);
  repository.campaignSpend.mockResolvedValue(new Decimal('100000.00'));
  repository.hasCampaignSpendLegs.mockResolvedValue(true);
  repository.accrualGross.mockResolvedValue(new Decimal('64000.00'));
  repository.platformRevenue.mockResolvedValue(new Decimal('15000.00'));
  repository.publisherEarnings.mockResolvedValue(new Decimal('82450.00'));
  repository.activeCampaigns.mockResolvedValue(7);
  repository.newPublishers.mockResolvedValue(4);
  repository.newAdvertisers.mockResolvedValue(9);
  repository.kycPending.mockResolvedValue(3);
});

describe('the month', () => {
  it('is an Indian calendar month, closed at the next IST midnight', () => {
    const { start, end } = monthWindowIST(2026, 9);
    expect(start.toISOString()).toBe('2026-08-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-09-30T18:30:00.000Z');
  });

  it('parses YYYY-MM and refuses anything else', () => {
    expect(parseMonth('2026-09')).toEqual({ year: 2026, month: 9 });
    expect(() => parseMonth('2026-13')).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => parseMonth('Sept 2026')).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('defaults to the month it is now in India', () => {
    // 23:30 UTC on 30 Sep is already 1 Oct in India.
    expect(parseMonth(undefined, new Date('2026-09-30T23:30:00Z'))).toEqual({ year: 2026, month: 10 });
  });
});

describe('the overview', () => {
  it('adds bookings and package sales, and takes GMV from the spend legs', async () => {
    const result = await monthOverview('2026-09');
    expect(result.month).toBe('2026-09');
    expect(result.bookingsAuthorised).toBe('130000.00');
    expect(result.gmvRecognised).toBe('100000.00');
    expect(result.gmvSource).toBe('CAMPAIGN_SPEND');
    expect(result.takeRatePct).toBe('15.00');
    expect(result.publisherEarnings).toBe('82450.00');
    expect(result).toMatchObject({ activeCampaigns: 7, newPublishers: 4, newAdvertisers: 9, kycPending: 3 });
  });

  it('asks the repository for the IST window of the month', async () => {
    await monthOverview('2026-09');
    const window = monthWindowIST(2026, 9);
    expect(repository.campaignSpend).toHaveBeenCalledWith(window);
    expect(repository.bookingsAuthorised).toHaveBeenCalledWith(window);
  });

  /**
   * Until B3a's capture legs exist on a database, the accrual's gross is the
   * only record of media delivered. The answer names which it used.
   */
  it('falls back to the accrual gross while no spend leg has ever been posted', async () => {
    repository.hasCampaignSpendLegs.mockResolvedValue(false);
    repository.campaignSpend.mockResolvedValue(new Decimal(0));
    const result = await monthOverview('2026-09');
    expect(result.gmvRecognised).toBe('64000.00');
    expect(result.gmvSource).toBe('ACCRUAL_GROSS');
    expect(result.takeRatePct).toBe('23.44');
  });

  it('reports a zero take rate rather than dividing by nothing', async () => {
    repository.campaignSpend.mockResolvedValue(new Decimal(0));
    repository.platformRevenue.mockResolvedValue(new Decimal(0));
    const result = await monthOverview('2026-09');
    expect(result.gmvRecognised).toBe('0.00');
    expect(result.takeRatePct).toBe('0.00');
  });

  it('is cached a minute per month', async () => {
    await monthOverview('2026-09');
    expect(cache.readThrough).toHaveBeenCalledWith(overviewCacheKey('2026-09'), OVERVIEW_CACHE_SECONDS, expect.any(Function));
    expect(OVERVIEW_CACHE_SECONDS).toBe(60);
  });

  it('answers money as decimal strings, never numbers', async () => {
    const result = await monthOverview('2026-09');
    for (const key of ['bookingsAuthorised', 'gmvRecognised', 'publisherEarnings', 'platformRevenue', 'takeRatePct'] as const) {
      expect(typeof result[key]).toBe('string');
      expect(result[key]).toMatch(/^\d+\.\d{2}$/);
    }
  });
});

/* E6: the per-month booking count and mean, and the series over a range. */
describe('bookings and the series', () => {
  it('counts the bookings paid in the month and averages the authorised value over them', async () => {
    const view = await monthOverview('2026-09');
    expect(view.bookingsCount).toBe(4);
    expect(view.averageBookingValue).toBe('32500.00');
    repository.bookingsCount.mockResolvedValue(0);
    expect((await monthOverview('2026-09')).averageBookingValue).toBe('0.00');
  });

  it('answers one single-month shape per month, oldest first, across a year boundary', async () => {
    const series = await overviewSeries('2025-11', '2026-02');
    expect(series).toMatchObject({ from: '2025-11', to: '2026-02' });
    expect(series.months.map((m) => m.month)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(series.months[0]).toMatchObject({ bookingsCount: 4, averageBookingValue: '32500.00', gmvRecognised: '100000.00' });
    // Each month goes through the same cache key the single read uses.
    expect(cache.readThrough).toHaveBeenCalledWith(overviewCacheKey('2025-12'), OVERVIEW_CACHE_SECONDS, expect.any(Function));
  });

  it('refuses a reversed range and one longer than the cap', async () => {
    await expect(overviewSeries('2026-03', '2026-02')).rejects.toMatchObject({ statusCode: 400 });
    await expect(overviewSeries('2024-01', '2026-12')).rejects.toMatchObject({ statusCode: 400 });
    expect(MAX_SERIES_MONTHS).toBe(24);
  });
});
