import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decimal } from '../../../shared/money';

/**
 * The matcher decides what an advertiser is shown and in what order, which is
 * the whole shape of what they end up buying. What matters is that the score is
 * built from the reasons it reports — a percentage nobody can decompose is a
 * percentage nobody should act on — and that a spot somebody else has already
 * booked never appears above one that can actually be bought.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    candidateListings: vi.fn(),
    clashingListingIds: vi.fn(),
  },
}));

vi.mock('../prisma-campaigns.repository', () => ({ prismaCampaignsRepository: repository }));

import { matchingInventory, scoreListing } from '../inventory.service';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'MG Road Billboard',
  city: 'Bengaluru',
  address: 'MG Road',
  latitude: 12.9757,
  longitude: 77.6069,
  ratePerDay: new Decimal('2000'),
  widthFt: new Decimal('20'),
  heightFt: new Decimal('10'),
  areaSqFt: new Decimal('200'),
  illumination: 'Back-lit',
  estimatedDailyFootfall: null,
  minBookingDays: 7,
  availableNow: true,
  mediaType: { id: 'mt_1', name: 'Billboard', category: 'OUTDOOR' },
  venueType: { id: 'vt_1', name: 'Main road' },
  photos: [{ url: 'https://cdn/1.jpg' }],
  ...over,
});

const campaign = (over: Record<string, unknown> = {}) =>
  ({
    id: 'cmp_1',
    goal: 'BRAND_AWARENESS',
    persona: 'HIGH_INCOME_CONSUMERS',
    strategy: 'GENERAL',
    targetingMethod: 'RADIUS',
    targetLatitude: 12.9757,
    targetLongitude: 77.6069,
    targetRadiusKm: 5,
    targetMarket: null,
    targetLocation: 'Bengaluru',
    budget: new Decimal('100000'),
    startDate: new Date('2026-04-01T00:00:00Z'),
    endDate: new Date('2026-04-14T00:00:00Z'),
    spots: [],
    pois: [],
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  repository.candidateListings.mockResolvedValue([listing()]);
  repository.clashingListingIds.mockResolvedValue([]);
});

describe('the score', () => {
  const base = {
    listing: listing(),
    goal: 'BRAND_AWARENESS',
    persona: 'HIGH_INCOME_CONSUMERS',
    strategy: 'GENERAL',
    distanceMeters: 0,
    radiusMeters: 5000,
    budgetRemaining: new Decimal('100000'),
    days: 14,
  };

  it('reports a reason for every component it counted', () => {
    const { score, reasons } = scoreListing(base);
    expect(score).toBeGreaterThan(0);
    // The reported contributions must add up to the score, or the explanation is
    // decoration rather than an account of it.
    const claimed = reasons.reduce((sum, reason) => sum + reason.contribution, 0);
    expect(Math.abs(claimed - score)).toBeLessThanOrEqual(4);
  });

  it('scores a spot at the centre above one at the edge', () => {
    const near = scoreListing({ ...base, distanceMeters: 100 }).score;
    const far = scoreListing({ ...base, distanceMeters: 4900 }).score;
    expect(near).toBeGreaterThan(far);
  });

  it('prefers a format that suits the goal', () => {
    const digitalForLift = scoreListing({
      ...base,
      goal: 'DIGITAL_LIFT',
      listing: listing({ mediaType: { id: 'mt_2', name: 'LED screen', category: 'DIGITAL' } }),
    }).score;
    const billboardForLift = scoreListing({ ...base, goal: 'DIGITAL_LIFT' }).score;
    expect(digitalForLift).toBeGreaterThan(billboardForLift);
  });

  it('prefers a venue that reaches the persona', () => {
    const mall = scoreListing({
      ...base,
      listing: listing({ venueType: { id: 'vt_2', name: 'Premium mall' } }),
    }).score;
    expect(mall).toBeGreaterThan(scoreListing(base).score);
  });

  /** A spot that eats the entire budget is a worse plan than one that leaves room. */
  it('marks down a spot that outruns what is left', () => {
    const affordable = scoreListing({ ...base, budgetRemaining: new Decimal('100000') }).score;
    const unaffordable = scoreListing({ ...base, budgetRemaining: new Decimal('10000') }).score;
    expect(unaffordable).toBeLessThan(affordable);
    expect(
      scoreListing({ ...base, budgetRemaining: new Decimal('10000') }).reasons.find(
        (reason) => reason.label === 'Budget'
      )?.detail
    ).toBe('More than the remaining budget');
  });

  it('never returns more than 100 or less than 0', () => {
    const perfect = scoreListing({
      ...base,
      listing: listing({
        estimatedDailyFootfall: 90_000,
        venueType: { id: 'vt_2', name: 'Premium mall' },
      }),
      strategy: 'ATTACK',
    }).score;
    expect(perfect).toBeLessThanOrEqual(100);
    expect(perfect).toBeGreaterThanOrEqual(0);
  });
});

describe('the shortlist', () => {
  it('prices the whole flight, not one day', async () => {
    const [match] = await matchingInventory(campaign());
    expect(match!.ratePerDay).toBe('2000.00');
    // 1 Apr to 14 Apr inclusive is fourteen days.
    expect(match!.lineTotal).toBe('28000.00');
  });

  it('drops a listing outside the exact radius the box let through', async () => {
    repository.candidateListings.mockResolvedValue([
      listing(),
      // ~11 km north: inside the bounding box for a 5 km radius, outside the circle.
      listing({ id: 'lst_far', latitude: 13.0757, longitude: 77.6069 }),
    ]);
    const matches = await matchingInventory(campaign());
    expect(matches.map((match) => match.listingId)).toEqual(['lst_1']);
  });

  it('sorts by rate, by reach, or by match', async () => {
    repository.candidateListings.mockResolvedValue([
      listing({ id: 'a', ratePerDay: new Decimal('5000'), estimatedDailyFootfall: 50_000 }),
      listing({ id: 'b', ratePerDay: new Decimal('1000'), estimatedDailyFootfall: 1_000 }),
    ]);
    expect(
      (await matchingInventory(campaign(), { sort: 'LOWEST_RATE' })).map((m) => m.listingId)
    ).toEqual(['b', 'a']);
    expect(
      (await matchingInventory(campaign(), { sort: 'MOST_REACH' })).map((m) => m.listingId)
    ).toEqual(['a', 'b']);
  });

  /** Shown, because an operator may want to know it exists — but never first. */
  it('pushes an already-booked spot below everything bookable', async () => {
    repository.candidateListings.mockResolvedValue([
      listing({ id: 'taken', estimatedDailyFootfall: 90_000 }),
      listing({ id: 'free' }),
    ]);
    repository.clashingListingIds.mockResolvedValue(['taken']);
    const matches = await matchingInventory(campaign());
    expect(matches.map((match) => match.listingId)).toEqual(['free', 'taken']);
    expect(matches[1]!.clashes).toBe(true);
  });

  it('never offers what is already in the cart', async () => {
    await matchingInventory(
      campaign({ spots: [{ listingId: 'lst_1', lineTotal: new Decimal('28000') }] })
    );
    expect(repository.candidateListings).toHaveBeenCalledWith(
      expect.objectContaining({ excludeListingIds: ['lst_1'] })
    );
  });

  /**
   * The POI screen collects several pins and draws all of them on a map. If
   * matching only used the first, the second and third venue would be answers
   * the advertiser gave to a question nobody asked.
   */
  it('matches around every venue a POI campaign pinned, not just the first', async () => {
    const poiCampaign = campaign({
      targetingMethod: 'POI_VENUE',
      targetLatitude: null,
      targetLongitude: null,
      targetRadiusKm: null,
      pois: [
        // Church Street, Bengaluru — and Koramangala, about 5 km south-east.
        { label: 'Third Wave Coffee', latitude: 12.9752, longitude: 77.6045 },
        { label: 'Matteo Coffea', latitude: 12.9352, longitude: 77.6245 },
      ],
    });
    repository.candidateListings.mockResolvedValue([
      listing({ id: 'near_first', latitude: 12.9762, longitude: 77.6055 }),
      listing({ id: 'near_second', latitude: 12.9362, longitude: 77.6255 }),
      // Between the two, inside the union box but more than 2 km from either.
      listing({ id: 'between', latitude: 12.9557, longitude: 77.615 }),
    ]);

    const matches = await matchingInventory(poiCampaign);

    expect(matches.map((match) => match.listingId).sort()).toEqual(['near_first', 'near_second']);
    // The distance reported is to the nearest pin, not always to the first.
    expect(matches.find((match) => match.listingId === 'near_second')!.distanceMeters).toBeLessThan(
      2_000
    );
  });

  it('searches the market by name when there is no radius', async () => {
    await matchingInventory(
      campaign({
        targetingMethod: 'MARKET_OR_DMA',
        targetLatitude: null,
        targetLongitude: null,
        targetRadiusKm: null,
        targetMarket: 'Mumbai',
      })
    );
    expect(repository.candidateListings).toHaveBeenCalledWith(
      expect.objectContaining({ city: 'Mumbai' })
    );
  });
});
