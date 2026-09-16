import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * E11-2: the deltas the analytics frames print.
 *
 * Both reads carry `comparison` — the current window against the one of
 * the same length immediately before it, from the stored daily metrics
 * (`CampaignDailyMetric`), for the three headline tiles: totalReach,
 * clickRate and budgetSpent. Each is `{ previous, deltaPct, provenance,
 * basis } | null`: null when the previous window has no rows, so a
 * campaign in its first week prints no delta rather than "+100%". The
 * provenance is the metric's own — MEASURED for spend and the click rate,
 * ESTIMATED for reach. The per-campaign spend also says `onTrack`, the
 * way the portfolio's budget tile does.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    trackingTotals: vi.fn(),
    eventTotalsByDay: vi.fn(),
    interactionTotals: vi.fn(async () => ({ byDevice: [], byHour: [], byCity: [], byCta: [] })),
    listCampaigns: vi.fn(),
    findCampaign: vi.fn(),
    dailyMetricsFor: vi.fn(),
  },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));

import { campaignAnalytics, compareWindows, portfolioAnalytics } from '../analytics.service';

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'spt_1',
  listingId: 'lst_1',
  status: 'LIVE',
  ratePerDay: new Decimal('2000'),
  days: 14,
  quantity: 1,
  lineTotal: new Decimal('28000'),
  listing: {
    id: 'lst_1',
    title: 'MG Road Billboard',
    city: 'Bengaluru',
    estimatedDailyFootfall: 20_000,
    mediaType: { id: 'mt_1', name: 'Billboard', category: 'OUTDOOR' },
    photos: [],
  },
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    reference: 'ADX-CMP-2026-482913',
    name: 'Anita coffee, April',
    status: 'LIVE',
    startDate: new Date('2026-04-01T00:00:00Z'),
    endDate: new Date('2026-04-30T00:00:00Z'),
    budget: new Decimal('100000'),
    total: new Decimal('60000'),
    trackingMethod: 'QR_OR_DEEPLINK',
    spots: [spot()],
    codes: [{ id: 'code_1', spotId: 'spt_1', method: 'QR_OR_DEEPLINK', scans: 0, clicks: 0, redemptions: 0 }],
    ...over,
  }) as never;

/** Fourteen days in; the window is the last seven, the previous the seven before. */
const NOW = new Date('2026-04-14T12:00:00Z');

const metric = (day: string, over: Record<string, unknown> = {}) => ({
  id: `m_${day}`,
  campaignId: 'cmp_1',
  day: new Date(`${day}T00:00:00Z`),
  spotsLive: 1,
  spend: new Decimal('2000'),
  scans: 10,
  clicks: 5,
  redemptions: 0,
  estimatedReach: 20_000,
  reachFromSpots: 1,
  computedAt: new Date(),
  ...over,
});

/** Two windows of rows: 1–7 April (previous) and 8–14 April (current). */
const twoWindows = () => [
  ...['01', '02', '03', '04', '05', '06', '07'].map((d) =>
    metric(`2026-04-${d}`, { spend: new Decimal('1000'), scans: 10, clicks: 4, estimatedReach: 10_000 }),
  ),
  ...['08', '09', '10', '11', '12', '13', '14'].map((d) =>
    metric(`2026-04-${d}`, { spend: new Decimal('2000'), scans: 20, clicks: 10, estimatedReach: 20_000 }),
  ),
];

beforeEach(() => {
  vi.clearAllMocks();
  repository.trackingTotals.mockResolvedValue({ scans: 0, clicks: 0, redemptions: 0 });
  repository.eventTotalsByDay.mockResolvedValue([]);
  repository.dailyMetricsFor.mockResolvedValue([]);
});

describe('compareWindows — pure', () => {
  it('splits the rows at the window boundary and compares like for like', () => {
    const comparison = compareWindows(twoWindows(), NOW, 7);
    expect(comparison.window).toEqual({
      days: 7,
      from: '2026-04-08',
      to: '2026-04-14',
      previousFrom: '2026-04-01',
      previousTo: '2026-04-07',
    });
    // 7 × 1,000 before, 7 × 2,000 now.
    expect(comparison.budgetSpent).toEqual({
      previous: '7000.00',
      deltaPct: 100,
      provenance: 'MEASURED',
      basis: expect.stringContaining('2026-04-01'),
    });
    // 28 of 70 (40%) before, 70 of 140 (50%) now: +25%.
    expect(comparison.clickRate).toEqual({ previous: 40, deltaPct: 25, provenance: 'MEASURED', basis: expect.any(String) });
    // 70,000 before, 140,000 now.
    expect(comparison.totalReach).toEqual({ previous: 70_000, deltaPct: 100, provenance: 'ESTIMATED', basis: expect.any(String) });
  });

  it('is null per metric when the previous window has no rows', () => {
    const comparison = compareWindows(twoWindows().slice(7), NOW, 7);
    expect(comparison.budgetSpent).toBeNull();
    expect(comparison.clickRate).toBeNull();
    expect(comparison.totalReach).toBeNull();
  });

  it('leaves out a row outside both windows', () => {
    const rows = [...twoWindows(), metric('2026-03-31', { spend: new Decimal('99999') })];
    expect(compareWindows(rows, NOW, 7).budgetSpent?.previous).toBe('7000.00');
  });

  it('has no delta when the previous value was zero, and no reach when nothing was estimated', () => {
    const rows = twoWindows().map((row, index) =>
      index < 7 ? { ...row, spend: new Decimal(0), scans: 0, clicks: 0, estimatedReach: null } : row,
    );
    const comparison = compareWindows(rows, NOW, 7);
    expect(comparison.budgetSpent).toMatchObject({ previous: '0.00', deltaPct: null });
    // No scans before: a click rate cannot be worked out, so there is nothing to compare against.
    expect(comparison.clickRate).toBeNull();
    expect(comparison.totalReach).toBeNull();
  });

  it('reads a fall as a negative delta', () => {
    const rows = twoWindows().map((row, index) => (index >= 7 ? { ...row, spend: new Decimal('500') } : row));
    expect(compareWindows(rows, NOW, 7).budgetSpent).toMatchObject({ previous: '7000.00', deltaPct: -50 });
  });
});

describe('one campaign', () => {
  it('says whether the spend is on track, the way the portfolio does', async () => {
    const analytics = await campaignAnalytics(campaign(), NOW);
    // 14 days × 2,000 = 28,000 against 60,000 committed.
    expect(analytics.spend.toDate).toBe('28000.00');
    expect(analytics.spend.onTrack).toBe(true);
  });

  it('is not on track once the spend passes what was committed', async () => {
    const analytics = await campaignAnalytics(campaign({ total: new Decimal('10000') }), NOW);
    expect(analytics.spend.onTrack).toBe(false);
  });

  it('cannot say with nothing committed', async () => {
    const analytics = await campaignAnalytics(campaign({ total: null, spots: [] }), NOW);
    expect(analytics.spend.onTrack).toBeNull();
  });

  it('carries the comparison over the stored daily metrics, seven days by default', async () => {
    repository.dailyMetricsFor.mockResolvedValue(twoWindows());
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(repository.dailyMetricsFor).toHaveBeenCalledWith(
      ['cmp_1'],
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-04-14T00:00:00Z'),
    );
    expect(analytics.comparison.window.days).toBe(7);
    expect(analytics.comparison.budgetSpent).toMatchObject({ previous: '7000.00', deltaPct: 100, provenance: 'MEASURED' });
    expect(analytics.comparison.clickRate).toMatchObject({ previous: 40, deltaPct: 25, provenance: 'MEASURED' });
    expect(analytics.comparison.totalReach).toMatchObject({ previous: 70_000, deltaPct: 100, provenance: 'ESTIMATED' });
  });

  it('takes the window length from the caller', async () => {
    repository.dailyMetricsFor.mockResolvedValue(twoWindows());
    const analytics = await campaignAnalytics(campaign(), NOW, { days: 3 });
    expect(analytics.comparison.window).toEqual({
      days: 3,
      from: '2026-04-12',
      to: '2026-04-14',
      previousFrom: '2026-04-09',
      previousTo: '2026-04-11',
    });
    // Both windows inside the 2,000-a-day stretch: flat.
    expect(analytics.comparison.budgetSpent).toMatchObject({ previous: '6000.00', deltaPct: 0 });
  });

  it('prints no delta in the first week', async () => {
    repository.dailyMetricsFor.mockResolvedValue(twoWindows().slice(7));
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.comparison).toMatchObject({ totalReach: null, clickRate: null, budgetSpent: null });
  });
});

describe('across campaigns', () => {
  const actor = { userId: 'usr_1', isAdmin: false, advertiserId: 'adv_1', agentId: null };

  beforeEach(() => {
    repository.listCampaigns.mockResolvedValue([
      { id: 'cmp_1', status: 'LIVE', brandName: "Anita's Coffee" },
      { id: 'cmp_2', status: 'LIVE', brandName: 'Second' },
      { id: 'cmp_3', status: 'DRAFT', brandName: 'Half-finished' },
    ]);
    repository.findCampaign.mockImplementation(async (id: string) => campaign({ id }));
  });

  it("folds every campaign's rows into one comparison over the portfolio window", async () => {
    repository.dailyMetricsFor.mockResolvedValue([
      ...twoWindows(),
      ...twoWindows().map((row) => ({ ...row, id: `b_${row.id}`, campaignId: 'cmp_2' })),
    ]);
    const portfolio = await portfolioAnalytics(actor, { days: 7 }, NOW);
    // One read for every campaign the tiles count — never the draft — and
    // none inside the per-campaign fold.
    expect(repository.dailyMetricsFor).toHaveBeenCalledTimes(1);
    expect(repository.dailyMetricsFor.mock.calls[0]![0]).toEqual(['cmp_1', 'cmp_2']);
    expect(portfolio.comparison.budgetSpent).toMatchObject({ previous: '14000.00', deltaPct: 100, provenance: 'MEASURED' });
    expect(portfolio.comparison.clickRate).toMatchObject({ previous: 40, deltaPct: 25 });
    expect(portfolio.comparison.totalReach).toMatchObject({ previous: 140_000, deltaPct: 100, provenance: 'ESTIMATED' });
  });

  it('is null across the board when nothing was stored before the window', async () => {
    const portfolio = await portfolioAnalytics(actor, {}, NOW);
    expect(portfolio.comparison).toMatchObject({ totalReach: null, clickRate: null, budgetSpent: null });
    expect(portfolio.budgetSpent.onTrack).toBe(true);
  });
});
