import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * G11-1: every breakdown row carries the same figures for the window
 * shifted back — `previous { gmvRecognised, bookings } | null`, null for a
 * row that had nothing in the previous window — and `deltaPct | null`, the
 * GMV movement between the two (null when there is nothing to compare
 * with). The previous window's facts are read beside the current ones and
 * cached with the same table, so a sort or a page never walks them again.
 */

const { repository, cache } = vi.hoisted(() => ({
  repository: {
    hasCampaignSpendLegs: vi.fn(),
    campaignCaptures: vi.fn(),
    campaignsWithSpots: vi.fn(),
    paidCampaigns: vi.fn(),
    paidPackageSales: vi.fn(),
    accrualBySpot: vi.fn(),
    spotCampaigns: vi.fn(),
  },
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
}));

vi.mock('../prisma-admin-overview.repository', () => ({ prismaAdminOverviewRepository: repository }));
vi.mock('../../../shared/cache', () => cache);

import { analyticsBreakdown, analyticsWindow } from '../analytics.service';

const D = (value: string | number) => new Decimal(value);
const at = (iso: string) => new Date(iso);

const campaigns = [
  { id: 'cmp-1', name: 'Diwali burst', advertiserId: 'adv-1', advertiserName: 'Acme Foods', agentId: 'agt-1', agentName: 'Ravi', spots: [{ id: 'spot-1', listingId: 'lst-1', lineTotal: D('6000.00'), category: 'INDOOR', city: 'Bengaluru', cityId: 'city_bengaluru', citySlug: 'bengaluru', cityName: 'Bengaluru', publisherId: 'pub-1', publisherName: 'Metro Gym' }] },
  { id: 'cmp-2', name: 'Monsoon sale', advertiserId: 'adv-2', advertiserName: 'Brolly Co', agentId: null, agentName: null, spots: [{ id: 'spot-3', listingId: 'lst-3', lineTotal: D('5000.00'), category: 'INDOOR', city: 'Bengaluru', cityId: 'city_bengaluru', citySlug: 'bengaluru', cityName: 'Bengaluru', publisherId: 'pub-2', publisherName: 'Sea Face Boards' }] },
  // Only in the previous window.
  { id: 'cmp-0', name: 'August push', advertiserId: 'adv-1', advertiserName: 'Acme Foods', agentId: null, agentName: null, spots: [{ id: 'spot-0', listingId: 'lst-1', lineTotal: D('4000.00'), category: 'INDOOR', city: 'Bengaluru', cityId: 'city_bengaluru', citySlug: 'bengaluru', cityName: 'Bengaluru', publisherId: 'pub-1', publisherName: 'Metro Gym' }] },
];

const window = analyticsWindow('2026-09-01', '2026-09-03');
const inCurrent = (w: { start: Date }) => w.start.getTime() === window.start.getTime();
const inPrevious = (w: { start: Date }) => w.start.getTime() === window.previous.start.getTime();

const query = (by: 'publisher' | 'advertiser' | 'category', extra: Record<string, unknown> = {}) => ({ from: '2026-09-01', to: '2026-09-03', by, sort: 'GMV_DESC' as const, page: 1, pageSize: 20, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  repository.hasCampaignSpendLegs.mockResolvedValue(true);
  repository.campaignsWithSpots.mockResolvedValue(campaigns);
  repository.spotCampaigns.mockResolvedValue([]);
  repository.accrualBySpot.mockResolvedValue([]);
  repository.paidPackageSales.mockResolvedValue([]);
  repository.campaignCaptures.mockImplementation(async (w: { start: Date }) =>
    inCurrent(w)
      ? [
          { occurredAt: at('2026-09-02T06:00:00Z'), campaignId: 'cmp-1', amount: D('6000.00') },
          { occurredAt: at('2026-09-03T06:00:00Z'), campaignId: 'cmp-2', amount: D('5000.00') },
        ]
      : inPrevious(w)
        ? [{ occurredAt: at('2026-08-30T06:00:00Z'), campaignId: 'cmp-0', amount: D('4000.00') }]
        : [],
  );
  repository.paidCampaigns.mockImplementation(async (w: { start: Date }) =>
    inCurrent(w)
      ? [
          { id: 'cmp-1', paidAt: at('2026-09-02T05:00:00Z'), total: D('6000.00'), advertiserId: 'adv-1', agentId: 'agt-1' },
          { id: 'cmp-2', paidAt: at('2026-09-03T05:00:00Z'), total: D('5000.00'), advertiserId: 'adv-2', agentId: null },
        ]
      : inPrevious(w)
        ? [{ id: 'cmp-0', paidAt: at('2026-08-30T05:00:00Z'), total: D('4000.00'), advertiserId: 'adv-1', agentId: null }]
        : [],
  );
});

describe('GET /admin/overview/breakdown — previous and deltaPct on every row', () => {
  it('carries the previous window figures and the GMV delta per row; null where there was nothing before', async () => {
    const page = await analyticsBreakdown(query('publisher'));
    expect(page.items).toEqual([
      expect.objectContaining({ key: 'pub-1', gmvRecognised: '6000.00', bookingsCount: 1, previous: { gmvRecognised: '4000.00', bookings: 1 }, deltaPct: '50.00' }),
      expect.objectContaining({ key: 'pub-2', gmvRecognised: '5000.00', bookingsCount: 1, previous: null, deltaPct: null }),
    ]);
  });

  it('reads the previous window beside the current one, and the campaigns of both in one lookup', async () => {
    await analyticsBreakdown(query('advertiser'));
    expect(repository.campaignCaptures).toHaveBeenCalledTimes(2);
    expect(repository.campaignCaptures).toHaveBeenCalledWith(expect.objectContaining({ start: window.previous.start, end: window.previous.end }));
    expect(repository.paidCampaigns).toHaveBeenCalledTimes(2);
    expect(repository.campaignsWithSpots).toHaveBeenCalledTimes(1);
    expect([...(repository.campaignsWithSpots.mock.calls[0]![0] as string[])].sort()).toEqual(['cmp-0', 'cmp-1', 'cmp-2']);
  });

  it('a row seen only before is not a row now — the previous figures hang off the current rows', async () => {
    const page = await analyticsBreakdown(query('category'));
    expect(page.items.map((r) => r.key)).toEqual(['INDOOR']);
    expect(page.items[0]).toMatchObject({ gmvRecognised: '11000.00', previous: { gmvRecognised: '4000.00', bookings: 1 }, deltaPct: '175.00' });
  });

  it('deltaPct is null when the previous GMV was zero even though the row existed', async () => {
    repository.campaignCaptures.mockImplementation(async (w: { start: Date }) => (inCurrent(w) ? [{ occurredAt: at('2026-09-02T06:00:00Z'), campaignId: 'cmp-1', amount: D('6000.00') }] : []));
    const page = await analyticsBreakdown(query('publisher'));
    expect(page.items[0]).toMatchObject({ key: 'pub-1', previous: { gmvRecognised: '0.00', bookings: 1 }, deltaPct: null });
  });
});
