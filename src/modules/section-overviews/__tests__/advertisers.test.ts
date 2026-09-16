import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, QUERY, advertisersSeed, labelsOf } from './fixtures';
import { inMemoryRepository } from './in-memory.repository';

/** O-B: the advertisers overview — the demand funnel reused, spend by day as money, the top ten by spend, the city filter and the cache key. */

const state = vi.hoisted(() => ({
  repository: null as unknown as ReturnType<typeof import('./in-memory.repository').inMemoryRepository>,
  cache: { readThrough: vi.fn(), invalidate: vi.fn() },
  advertisers: { advertiserFunnel: vi.fn(), findAdvertiserLabels: vi.fn() },
  agents: { findAgentLabels: vi.fn() },
}));

vi.mock('../prisma-section-overviews.repository', () => ({
  prismaSectionOverviewsRepository: new Proxy({}, { get: (_target, property) => (state.repository as unknown as Record<PropertyKey, unknown>)[property] }),
}));
vi.mock('../../../shared/cache', () => state.cache);
// Lot X-B: `?city=` resolves once through pricing — Bengaluru and Mumbai are catalogued (by name or slug), anything else is a typed town.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => {
    const key = (name ?? '').trim().toLowerCase();
    return key === 'bengaluru' || key === 'bangalore' ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : key === 'mumbai' ? { cityId: 'city_mumbai', slug: 'mumbai' } : null;
  },
}));

vi.mock('../../advertisers', () => state.advertisers);
vi.mock('../../agents', () => state.agents);
vi.mock('../../supply', () => ({}));
vi.mock('../../publishers', () => ({}));
vi.mock('../../employees', () => ({}));
vi.mock('../../print-partners', () => ({}));

import { SECTION_OVERVIEW_CACHE_SECONDS, sectionOverview, sectionOverviewCacheKey, type AdvertisersOverview } from '../section-overviews.service';

const FUNNEL = {
  accountsCreated: 9,
  profileComplete: 8,
  kycVerified: 5,
  platformAgreementAccepted: 5,
  funded: 3,
  stuckOnAdvertiser: { awaitingProfile: 1, awaitingKycSubmission: 2, awaitingAgreement: 0, awaitingFunds: 2 },
  stuckOnAdx: { pendingKycReview: 3 },
};

const read = (query: { from?: string; to?: string; city?: string } = QUERY) => {
  state.repository = inMemoryRepository(advertisersSeed());
  return sectionOverview('advertisers', query, NOW) as Promise<AdvertisersOverview>;
};

beforeEach(() => {
  vi.clearAllMocks();
  state.cache.readThrough.mockImplementation(async (_key: string, _ttl: number, load: () => Promise<unknown>) => load());
  state.advertisers.advertiserFunnel.mockResolvedValue(FUNNEL);
  state.advertisers.findAdvertiserLabels.mockImplementation(labelsOf);
  state.agents.findAgentLabels.mockImplementation(labelsOf);
});

describe('the advertisers overview', () => {
  it('counts the window against the previous one, signed', async () => {
    const { tiles } = await read();
    expect(tiles.total).toEqual({ value: 9, previous: 6, delta: 3 });
    expect(tiles.newInWindow).toEqual({ value: 3, previous: 5, delta: -2 });
    // Two advertisers spent in the window, one in the window before.
    expect(tiles.active).toEqual({ value: 2, previous: 1, delta: 1 });
    expect(tiles.kyc).toEqual({ awaitingDocuments: 2, requested: 0, pending: 3, needsInfo: 0, rejected: 1, verified: 5 });
    expect(tiles.byIndustry.items.map((row) => [row.key, row.count])).toEqual([['Retail', 6], ['Education', 3]]);
  });

  it('reuses the demand funnel through the advertisers export', async () => {
    const result = await read();
    expect(result.funnel).toEqual(FUNNEL);
    expect(state.advertisers.advertiserFunnel).toHaveBeenCalledTimes(1);
  });

  it('answers spend by day as money on the seam days, with the previous window beside it', async () => {
    const { series } = await read();
    expect(series.spend.days[0]).toEqual({ day: '2026-09-01', value: '10000.00' });
    expect(series.spend.days[6]).toEqual({ day: '2026-09-07', value: '22500.50' });
    expect(series.spend.days[1]).toEqual({ day: '2026-09-02', value: '0.00' });
    expect(series.spend.previous[9]).toEqual({ day: '2026-08-31', value: '9000.00' });
    expect(series.spend.total).toEqual({ value: '32500.50', previous: '9000.00', delta: '23500.50' });
    expect(series.newAdvertisers.total).toEqual({ value: 3, previous: 5, delta: -2 });
    expect(series.firstCampaigns.total).toEqual({ value: 1, previous: 1, delta: 0 });
  });

  it('ranks the top ten by spend with labels, and answers the wallet and the top-ups as money', async () => {
    const { top, money } = await read();
    expect(top.bySpend.items.map((row) => [row.key, row.amount, row.href])).toEqual([
      ['adv_b', '20000.00', '/advertisers/adv_b'],
      ['adv_a', '12500.50', '/advertisers/adv_a'],
    ]);
    expect(money.walletBalanceHeld).toEqual({ value: '12345.50', previous: null, delta: null });
    expect(money.topUps).toEqual({ value: '5000.00', previous: '8000.00', delta: '-3000.00' });
  });

  it('answers the breakdowns on the list contract', async () => {
    const { breakdowns } = await read();
    expect(breakdowns.byCity).toMatchObject({ total: 2, page: 1, pageSize: 100, counts: {} });
    expect(breakdowns.byCity.items[1]).toEqual({ key: 'mumbai', label: 'Mumbai', href: '/advertisers?city=mumbai', cityId: 'city_mumbai', typed: [], count: 4, spend: '20000.00' });
    expect(breakdowns.byPackageTier.items[0]).toMatchObject({ key: 'GROWTH', label: 'Growth', count: 4 });
    expect(breakdowns.byAgent.items[0]).toMatchObject({ key: 'agt_1', label: 'Name agt_1', href: '/agents/agt_1', count: 3 });
  });

  it('narrows to a city', async () => {
    const result = await read({ ...QUERY, city: 'MUMBAI' });
    expect(result.tiles.newInWindow).toEqual({ value: 1, previous: 2, delta: -1 });
    expect(result.series.spend.total.value).toBe('20000.00');
    expect(result.top.bySpend.items.map((row) => row.key)).toEqual(['adv_b']);
    expect(result.money.topUps).toEqual({ value: '0.00', previous: '8000.00', delta: '-8000.00' });
  });

  it('is cached a minute per section, window and city', async () => {
    await read({ ...QUERY, city: 'Mumbai' });
    expect(state.cache.readThrough).toHaveBeenCalledWith(sectionOverviewCacheKey('advertisers', '2026-09-01', '2026-09-10', 'Mumbai'), SECTION_OVERVIEW_CACHE_SECONDS, expect.any(Function));
    expect(sectionOverviewCacheKey('advertisers', '2026-09-01', '2026-09-10', 'Mumbai')).toBe('section-overviews:advertisers:2026-09-01:2026-09-10:mumbai');
  });
});
