import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q8/Q107) — multi-market campaigns, behind the flag.
 *
 * What is pinned: `targetMarkets` is the list, `targetMarket` and
 * `targetLocation` stay its first entry for every existing reader, and
 * choosing markets clears the radius and the pins the way the MarketArea
 * step does; a second market needs the flag (409 FEATURE_OFF) and the cap
 * is the platform setting, not a constant; the matcher's city fallback
 * becomes city IN markets; the read warns above one market; analytics folds
 * the spots by market; and the review's completeness reads the list.
 */

const { repository, flags, settings, assertCityAllows } = vi.hoisted(() => ({
  repository: {
    findCampaignBare: vi.fn(),
    updateCampaign: vi.fn(),
    replacePois: vi.fn(),
    findCampaign: vi.fn(),
    candidateListings: vi.fn(),
    clashingListingIds: vi.fn(),
    trackingTotals: vi.fn(),
    interactionTotals: vi.fn(async () => ({ byDevice: [], byHour: [], byCity: [], byCta: [] })),
    findDailyMetrics: vi.fn(),
    // E11-2: the stored rows the previous-window comparison reads; none here.
    dailyMetricsFor: vi.fn(async () => []),
    eventTotalsByDay: vi.fn(),
  },
  flags: { isFeatureEnabled: vi.fn() },
  settings: { getPlatformSettings: vi.fn() },
  assertCityAllows: vi.fn(),
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));
// Lot X-B: the key beside the market — Bengaluru (and its old spelling) is catalogued, the rest are typed towns.
vi.mock('../../pricing', () => ({
  assertCityAllows,
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
}));
vi.mock('../../visits', () => ({ assertVisitOutcome: vi.fn() }));
vi.mock('../../feature-flags', () => ({ ...flags, ...passThroughFeatureGates() }));
vi.mock('../../app-config', () => settings);

import { missingAnswers, patchDraft, withMarketWarning } from '../campaigns.service';
import { matchingInventory } from '../inventory.service';
import { campaignAnalytics } from '../analytics.service';
import { patchCampaignSchema } from '../campaigns.schema';

const ADMIN = { userId: 'usr_1', isAdmin: true, advertiserId: null, agentId: null };

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'cmp_1',
  status: 'DRAFT',
  advertiserId: 'adv_1',
  agentId: null,
  triggerType: 'NONE',
  triggerConfig: null,
  creativePath: null,
  creativeConfig: null,
  trackingMethod: 'NONE',
  trackingConfig: null,
  startDate: null,
  endDate: null,
  visitId: null,
  targetMarket: null,
  targetMarkets: [],
  ...over,
});

const written = () => {
  const calls = repository.updateCampaign.mock.calls;
  return calls.length === 0 ? {} : calls[calls.length - 1]![1];
};

beforeEach(() => {
  vi.clearAllMocks();
  repository.findCampaignBare.mockResolvedValue(stored());
  repository.findCampaign.mockResolvedValue(stored());
  repository.updateCampaign.mockResolvedValue(undefined);
  repository.replacePois.mockResolvedValue([]);
  flags.isFeatureEnabled.mockResolvedValue(true);
  settings.getPlatformSettings.mockResolvedValue({ marketplace: { minBookingDays: 1, maxMarketsPerCampaign: 3 } });
  assertCityAllows.mockResolvedValue(undefined);
});

describe('the patch', () => {
  it('accepts a list of markets beside the single one', () => {
    expect(patchCampaignSchema.parse({ targetMarkets: ['Bengaluru', 'Chennai'] })).toMatchObject({ targetMarkets: ['Bengaluru', 'Chennai'] });
    expect(patchCampaignSchema.safeParse({ targetMarkets: [''] }).success).toBe(false);
  });

  it('keeps targetMarket and targetLocation as the first market and clears the radius and the pins', async () => {
    await patchDraft('cmp_1', { targetMarkets: ['Bengaluru', 'Chennai'] }, ADMIN);
    expect(flags.isFeatureEnabled).toHaveBeenCalledWith('multi-market-campaigns', 'adv_1');
    expect(assertCityAllows).toHaveBeenCalledTimes(2);
    expect(written()).toMatchObject({
      targetMarkets: ['Bengaluru', 'Chennai'],
      targetMarket: 'Bengaluru',
      // Lot X-B: the first market's key.
      targetMarketCityId: 'city_bengaluru',
      targetLocation: 'Bengaluru',
      targetLatitude: null,
      targetLongitude: null,
      targetRadiusKm: null,
    });
    expect(repository.replacePois).toHaveBeenCalledWith('cmp_1', []);
  });

  it('refuses a second market with the flag off, and a single one still goes through', async () => {
    flags.isFeatureEnabled.mockResolvedValue(false);
    await expect(patchDraft('cmp_1', { targetMarkets: ['Bengaluru', 'Chennai'] }, ADMIN)).rejects.toMatchObject({ statusCode: 409, code: 'FEATURE_OFF' });
    expect(repository.updateCampaign).not.toHaveBeenCalled();
    await patchDraft('cmp_1', { targetMarkets: ['Bengaluru'] }, ADMIN);
    expect(written()).toMatchObject({ targetMarkets: ['Bengaluru'], targetMarket: 'Bengaluru' });
  });

  it('caps the list at the platform setting, de-duplicated case-insensitively', async () => {
    await expect(patchDraft('cmp_1', { targetMarkets: ['A', 'B', 'C', 'D'] }, ADMIN)).rejects.toMatchObject({ statusCode: 400 });
    await patchDraft('cmp_1', { targetMarkets: ['Bengaluru', ' bengaluru ', 'Chennai'] }, ADMIN);
    expect(written().targetMarkets).toEqual(['Bengaluru', 'Chennai']);
  });

  /* Lot X-B: the key beside the market. */
  it('keys the market to its catalogue row however spelt, null for a typed town or a cleared market, and leaves the key alone when the market is not touched', async () => {
    await patchDraft('cmp_1', { targetMarket: 'Bangalore' }, ADMIN);
    expect(written()).toMatchObject({ targetMarket: 'Bangalore', targetMarketCityId: 'city_bengaluru' });
    await patchDraft('cmp_1', { targetMarkets: ['Rameswaram'] }, ADMIN);
    expect(written()).toMatchObject({ targetMarket: 'Rameswaram', targetMarketCityId: null });
    await patchDraft('cmp_1', { targetMarket: null }, ADMIN);
    expect(written()).toMatchObject({ targetMarket: null, targetMarketCityId: null });
    await patchDraft('cmp_1', { name: 'Renamed' }, ADMIN);
    expect(written()).not.toHaveProperty('targetMarketCityId');
  });

  it('keeps the list in step when only the single market is sent, the way the app still does', async () => {
    await patchDraft('cmp_1', { targetMarket: 'Pune', targetLocation: 'Pune' }, ADMIN);
    expect(written()).toMatchObject({ targetMarket: 'Pune', targetMarkets: ['Pune'] });
    await patchDraft('cmp_1', { targetMarket: null }, ADMIN);
    expect(written()).toMatchObject({ targetMarket: null, targetMarkets: [] });
  });
});

describe('the read', () => {
  it('warns above one market — advisory, never a refusal', () => {
    expect(withMarketWarning({ targetMarkets: ['A', 'B'] }).multiMarketWarning).toBe(true);
    expect(withMarketWarning({ targetMarkets: ['A'] }).multiMarketWarning).toBe(false);
    expect(withMarketWarning({}).multiMarketWarning).toBe(false);
  });

  it('is complete on MARKET_OR_DMA with at least one market in the list', () => {
    const base = { targetingMethod: 'MARKET_OR_DMA', pois: [], spots: [], creatives: [] };
    const missingMarket = missingAnswers(stored({ ...base, targetMarket: null, targetMarkets: [] }) as never);
    expect(missingMarket.some((answer) => answer.field === 'targetMarket')).toBe(true);
    const listed = missingAnswers(stored({ ...base, targetMarket: null, targetMarkets: ['Chennai'] }) as never);
    expect(listed.some((answer) => answer.field === 'targetMarket')).toBe(false);
  });
});

describe('the matcher', () => {
  const campaign = (over: Record<string, unknown> = {}) => ({
    ...stored(),
    targetingMethod: 'MARKET_OR_DMA',
    targetLatitude: null,
    targetLongitude: null,
    targetRadiusKm: null,
    targetLocation: 'Bengaluru',
    targetMarket: 'Bengaluru',
    targetMarkets: ['Bengaluru', 'Chennai'],
    pois: [],
    spots: [],
    goal: null,
    persona: null,
    strategy: null,
    budget: null,
    ...over,
  });

  beforeEach(() => {
    repository.candidateListings.mockResolvedValue([]);
    repository.clashingListingIds.mockResolvedValue([]);
  });

  it('falls back to city IN the markets, and to the single market or location when the list is empty', async () => {
    await matchingInventory(campaign() as never);
    expect(repository.candidateListings.mock.calls[0]![0]).toMatchObject({ cities: ['Bengaluru', 'Chennai'] });
    await matchingInventory(campaign({ targetMarkets: [] }) as never);
    expect(repository.candidateListings.mock.calls[1]![0]).toMatchObject({ city: 'Bengaluru' });
    await matchingInventory(campaign({ targetMarkets: [], targetMarket: null, targetLocation: 'Pune' }) as never);
    expect(repository.candidateListings.mock.calls[2]![0]).toMatchObject({ city: 'Pune' });
  });
});

describe('analytics', () => {
  it('folds the spots by market over bySpot.city', async () => {
    repository.trackingTotals.mockResolvedValue({ scans: 0, clicks: 0, redemptions: 0 });
    repository.findDailyMetrics.mockResolvedValue([]);
    repository.eventTotalsByDay.mockResolvedValue([]);
    const spot = (id: string, city: string | null, rate: string) => ({
      id,
      status: 'LIVE',
      ratePerDay: rate,
      quantity: 1,
      days: 10,
      lineTotal: String(Number(rate) * 10),
      listing: { title: id, city, estimatedDailyFootfall: null, mediaType: null },
    });
    const analytics = await campaignAnalytics(
      {
        ...stored({ status: 'LIVE', startDate: new Date('2026-09-01T00:00:00.000Z'), endDate: new Date('2026-09-10T00:00:00.000Z'), total: null, reference: 'ADX-CMP-1', name: 'One', trackingMethod: 'NONE' }),
        spots: [spot('s1', 'Bengaluru', '100'), spot('s2', 'bengaluru', '50'), spot('s3', 'Chennai', '10'), spot('s4', null, '1')],
        codes: [],
      } as never,
      new Date('2026-09-03T00:00:00.000Z'),
    );
    expect(analytics.byMarket.map((row) => [row.market, row.spots, row.spend])).toEqual([
      ['Bengaluru', 2, '450.00'],
      ['Chennai', 1, '30.00'],
      [null, 1, '3.00'],
    ]);
  });
});
