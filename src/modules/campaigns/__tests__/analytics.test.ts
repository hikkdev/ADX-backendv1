import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The point of these tests is not the arithmetic — it is the refusal.
 *
 * Out-of-home has no impression pixel. Reach is arithmetic over footfall figures
 * publishers typed in, and when none of them typed one there is no reach figure
 * and the screen has to say so. Every number carries where it came from, and
 * these tests are what stops a later change quietly relabelling a guess as a
 * measurement.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    trackingTotals: vi.fn(),
    eventTotalsByDay: vi.fn(),
    // Lot D (Q7): the landing-page interactions, folded four ways.
    interactionTotals: vi.fn(async () => ({ byDevice: [], byHour: [], byCity: [], byCta: [] })),
    listCampaigns: vi.fn(),
    findCampaign: vi.fn(),
    upsertDailyMetric: vi.fn(),
    // E11-2: the stored rows the previous-window comparison reads; none here.
    dailyMetricsFor: vi.fn(async () => []),
  },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));

import { campaignAnalytics, portfolioAnalytics } from '../analytics.service';

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
    estimatedDailyFootfall: null,
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
    endDate: new Date('2026-04-14T00:00:00Z'),
    budget: new Decimal('100000'),
    total: new Decimal('34810'),
    trackingMethod: 'QR_OR_DEEPLINK',
    spots: [spot()],
    codes: [{ id: 'code_1', spotId: 'spt_1', method: 'QR_OR_DEEPLINK', scans: 0, clicks: 0, redemptions: 0 }],
    ...over,
  }) as never;

/** Five days into the fourteen-day flight. */
const NOW = new Date('2026-04-05T12:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  repository.trackingTotals.mockResolvedValue({ scans: 0, clicks: 0, redemptions: 0 });
  repository.eventTotalsByDay.mockResolvedValue([]);
});

describe('one campaign', () => {
  it('counts spend only for the days that have actually run', async () => {
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.daysElapsed).toBe(5);
    expect(analytics.daysTotal).toBe(14);
    expect(analytics.spend.toDate).toBe('10000.00');
    expect(analytics.spend.committed).toBe('34810.00');
  });

  it('stops counting when the flight ends', async () => {
    const analytics = await campaignAnalytics(campaign(), new Date('2026-05-30T00:00:00Z'));
    expect(analytics.daysElapsed).toBe(14);
    expect(analytics.spend.toDate).toBe('28000.00');
  });

  it('reports nothing spent before the flight starts', async () => {
    const analytics = await campaignAnalytics(campaign(), new Date('2026-03-01T00:00:00Z'));
    expect(analytics.daysElapsed).toBe(0);
    expect(analytics.spend.toDate).toBe('0.00');
    expect(analytics.series).toEqual([]);
  });

  /** The heart of it: no footfall data means no reach figure, and it says why. */
  it('has no reach figure when no booked site states a footfall', async () => {
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.reach).toEqual({
      value: null,
      provenance: 'UNAVAILABLE',
      basis: 'No booked site states a daily footfall figure',
    });
  });

  it('estimates reach from stated footfall, and says how many sites it came from', async () => {
    const analytics = await campaignAnalytics(
      campaign({
        spots: [
          spot({ listing: { ...spot().listing, estimatedDailyFootfall: 20_000 } }),
          spot({ id: 'spt_2', listing: { ...spot().listing, estimatedDailyFootfall: null } }),
        ],
      }),
      NOW
    );
    expect(analytics.reach.provenance).toBe('ESTIMATED');
    expect(analytics.reach.value).toBe(100_000); // 20,000 a day x 5 days
    expect(analytics.reach.basis).toContain('1 of 2 sites');
  });

  it('calls scans measured and redemptions reported', async () => {
    repository.trackingTotals.mockResolvedValue({ scans: 400, clicks: 340, redemptions: 12 });
    const analytics = await campaignAnalytics(
      campaign({
        trackingMethod: 'VANITY_OR_PROMO',
        codes: [{ id: 'code_1', spotId: null, method: 'VANITY_OR_PROMO', scans: 400, clicks: 340, redemptions: 12 }],
      }),
      NOW
    );
    expect(analytics.scans).toMatchObject({ value: 400, provenance: 'MEASURED' });
    expect(analytics.redemptions).toMatchObject({ value: 12, provenance: 'REPORTED' });
    expect(analytics.redemptions.basis).toContain('not observed by ADX');
  });

  it('works out a click rate from scans that reached the destination', async () => {
    repository.trackingTotals.mockResolvedValue({ scans: 400, clicks: 340, redemptions: 0 });
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.clickRate.value).toBe(85);
    expect(analytics.clickRate.basis).toBe('340 of 400 scans reached the destination');
  });

  it('says an untracked campaign is untracked rather than reporting zero', async () => {
    const analytics = await campaignAnalytics(
      campaign({ trackingMethod: 'NONE', codes: [] }),
      NOW
    );
    expect(analytics.scans).toEqual({
      value: null,
      provenance: 'UNAVAILABLE',
      basis: 'This campaign is not tracked',
    });
  });

  it('draws a point for every day, including the quiet ones', async () => {
    repository.eventTotalsByDay.mockResolvedValue([
      { day: '2026-04-03', type: 'SCAN', count: 40 },
      { day: '2026-04-03', type: 'CLICK', count: 33 },
    ]);
    const analytics = await campaignAnalytics(campaign(), NOW);
    expect(analytics.series).toHaveLength(5);
    expect(analytics.series.map((point) => point.day)).toEqual([
      '2026-04-01',
      '2026-04-02',
      '2026-04-03',
      '2026-04-04',
      '2026-04-05',
    ]);
    expect(analytics.series[2]).toMatchObject({ scans: 40, clicks: 33 });
    expect(analytics.series[0]).toMatchObject({ scans: 0, clicks: 0 });
  });

  /** The donut, honestly: what was bought, not who saw it. */
  it('breaks the spend down by media type', async () => {
    const analytics = await campaignAnalytics(
      campaign({
        spots: [
          spot(),
          spot({
            id: 'spt_2',
            lineTotal: new Decimal('12000'),
            listing: { ...spot().listing, mediaType: { id: 'mt_2', name: 'Mall panel', category: 'INDOOR' } },
          }),
        ],
      }),
      NOW
    );
    expect(analytics.mix).toEqual([
      { label: 'Billboard', spots: 1, spend: '28000.00', share: 70 },
      { label: 'Mall panel', spots: 1, spend: '12000.00', share: 30 },
    ]);
  });

  it('attributes scans to the spot whose code was scanned', async () => {
    const analytics = await campaignAnalytics(
      campaign({
        codes: [
          { id: 'code_1', spotId: 'spt_1', method: 'QR_OR_DEEPLINK', scans: 120, clicks: 100, redemptions: 0 },
        ],
      }),
      NOW
    );
    expect(analytics.bySpot[0]).toMatchObject({ spotId: 'spt_1', scans: 120, clicks: 100 });
  });
});

describe('across campaigns', () => {
  const actor = { userId: 'usr_1', isAdmin: false, advertiserId: 'adv_1', agentId: null };

  beforeEach(() => {
    repository.listCampaigns.mockResolvedValue([
      { id: 'cmp_1', status: 'LIVE', brandName: "Anita's Coffee" },
      { id: 'cmp_2', status: 'DRAFT', brandName: 'Half-finished' },
    ]);
    repository.findCampaign.mockResolvedValue(campaign());
  });

  it('leaves drafts out — they have nothing to report', async () => {
    const portfolio = await portfolioAnalytics(actor, {}, NOW);
    expect(portfolio.campaigns).toHaveLength(1);
    expect(repository.findCampaign).toHaveBeenCalledTimes(1);
  });

  it('fills the four tiles the analytics screen draws', async () => {
    repository.trackingTotals.mockResolvedValue({ scans: 400, clicks: 340, redemptions: 0 });
    const portfolio = await portfolioAnalytics(actor, {}, NOW);

    expect(portfolio.activeCampaigns.value).toBe(1);
    expect(portfolio.clickRate.value).toBe(85);
    expect(portfolio.budgetSpent.value).toBe('10000.00');
    expect(portfolio.totalReach.provenance).toBe('UNAVAILABLE');
  });

  it('passes the search through to the query', async () => {
    await portfolioAnalytics(actor, { search: 'coffee' }, NOW);
    expect(repository.listCampaigns).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'coffee', advertiserId: 'adv_1' })
    );
  });

  it('scopes an agent to their own campaigns', async () => {
    await portfolioAnalytics(
      { userId: 'usr_2', isAdmin: false, advertiserId: null, agentId: 'agt_1' },
      {},
      NOW
    );
    expect(repository.listCampaigns).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_1' })
    );
  });

  it('gives an admin everything', async () => {
    await portfolioAnalytics(
      { userId: 'usr_3', isAdmin: true, advertiserId: null, agentId: null },
      {},
      NOW
    );
    const call = repository.listCampaigns.mock.calls[0]![0];
    expect(call.advertiserId).toBeUndefined();
    expect(call.agentId).toBeUndefined();
  });

  it('returns one point a day over the window, zeros included', async () => {
    const portfolio = await portfolioAnalytics(actor, { days: 7 }, NOW);
    expect(portfolio.series).toHaveLength(7);
    expect(portfolio.series[0]!.day).toBe('2026-03-30');
    expect(portfolio.series[6]!.day).toBe('2026-04-05');
  });
});
