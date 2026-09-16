import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 01's browse — the advertiser's first search endpoint.
 *
 * What is pinned: the query takes the drawer's facets and refuses a point
 * without both halves; a card carries the spot as the frames draw it (money
 * as a decimal string, the measured size, the photographs) and never the
 * publisher's contact; around a point the box is ordered by exact distance
 * and cut to the radius; a spot that is not live reads as missing.
 */

const { repository, pricing } = vi.hoisted(() => ({
  pricing: { citySupport: vi.fn() },
  // Lot G: the slot count rides every browse read; nothing held here.
  repository: { findActive: vi.fn(), findActiveById: vi.fn(), savedListingIds: vi.fn(), slotsHeld: vi.fn(async () => new Map()) },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
// Lot X-L: the typed city resolves to its key before the repository is asked — Bengaluru is catalogued here.
vi.mock('../../pricing', () => ({
  citySupport: pricing.citySupport,
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
}));

import { browseListings, getBrowseListing, toBrowseCard } from '../browse.service';
import { browseQuerySchema } from '../listings.schema';

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-0001',
  title: 'MG Road Digital Billboard',
  category: 'OUTDOOR',
  subType: 'Digital screen',
  address: 'MG Road, Central Bengaluru',
  city: 'Bengaluru',
  latitude: 12.975,
  longitude: 77.605,
  ratePerDay: '18000',
  pricingUnit: 'PER_DAY',
  basePrice: '18000',
  widthFt: '40',
  heightFt: '20',
  size: null,
  photos: [{ url: 'https://cdn.adx.in/l/1.jpg', type: 'main' }, { url: 'https://cdn.adx.in/l/2.jpg', type: 'gallery' }],
  description: 'Strategically located on MG Road.',
  illumination: 'LED',
  facing: 'North-South',
  placement: 'Single-sided unipole',
  visibility: 'High',
  estimatedDailyFootfall: 85000,
  availableNow: true,
  availableFrom: null,
  availableHoursFrom: null,
  availableHoursTo: null,
  peakPeriodNote: null,
  targetAudience: null,
  uniqueSellingPoint: null,
  ratingAvg: '4.50',
  reviewCount: 12,
  instantBooking: false,
  publisher: { name: 'Suraj Kumar', mobile: '+91', user: { mobile: '+91' } },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findActive.mockResolvedValue({ items: [spot()], total: 1 });
  repository.findActiveById.mockResolvedValue(spot());
  repository.savedListingIds.mockResolvedValue([]);
});

describe('the query', () => {
  it('takes the drawer as drawn — display, price, dates, footfall, illumination — with defaults', () => {
    const parsed = browseQuerySchema.parse({
      category: 'OUTDOOR',
      display: 'DIGITAL',
      minRate: '500',
      maxRate: '50000',
      from: '2026-10-01T00:00:00.000Z',
      minFootfall: '25000',
      illuminated: 'true',
    });
    expect(parsed).toMatchObject({ category: 'OUTDOOR', display: 'DIGITAL', minRate: '500', maxRate: '50000', minFootfall: 25000, illuminated: true, sort: 'NEWEST', page: 1, pageSize: 20, radiusKm: 10 });
  });

  it('E7-2: takes `to` beside `from` as the availability window, and refuses one that ends before it starts', () => {
    const parsed = browseQuerySchema.parse({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' });
    expect(parsed).toMatchObject({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' });
    expect(browseQuerySchema.parse({ to: '2026-10-14T00:00:00.000Z' }).from).toBeUndefined();
    expect(browseQuerySchema.safeParse({ from: '2026-10-14T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' }).success).toBe(false);
    expect(browseQuerySchema.safeParse({ to: 'next week' }).success).toBe(false);
  });

  it('takes the Lot D facets: an instant-booking switch and a rating sort', () => {
    expect(browseQuerySchema.parse({ instant: 'true', sort: 'RATING' })).toMatchObject({ instant: true, sort: 'RATING' });
    expect(browseQuerySchema.parse({ instant: 'false' }).instant).toBe(false);
    expect(browseQuerySchema.parse({}).instant).toBeUndefined();
  });

  it('refuses half a point, a bad rate, and an unknown category', () => {
    expect(browseQuerySchema.safeParse({ lat: '12.9' }).success).toBe(false);
    expect(browseQuerySchema.safeParse({ minRate: 'cheap' }).success).toBe(false);
    expect(browseQuerySchema.safeParse({ category: 'ROOFTOP' }).success).toBe(false);
    expect(browseQuerySchema.safeParse({ lat: '12.9', lng: '77.6' }).success).toBe(true);
  });
});

describe('the card', () => {
  it('carries the spot as the frames draw it, money as a string, and never the publisher’s contact', () => {
    const card = toBrowseCard(spot() as never, null);
    expect(card).toMatchObject({
      ratePerDay: '18000.00',
      size: '40 × 20 ft',
      photos: ['https://cdn.adx.in/l/1.jpg', 'https://cdn.adx.in/l/2.jpg'],
      publisherName: 'Suraj Kumar',
      estimatedDailyFootfall: 85000,
      distanceM: null,
    });
    expect(JSON.stringify(card)).not.toContain('+91');
  });

  it('carries the rating, the review count, the instant-booking mark and whether the viewer saved it (Lot D)', () => {
    expect(toBrowseCard(spot() as never, null)).toMatchObject({ ratingAvg: '4.50', reviewCount: 12, instantBooking: false, saved: false });
    expect(toBrowseCard(spot({ ratingAvg: null, reviewCount: 0, instantBooking: true }) as never, null, true)).toMatchObject({
      ratingAvg: null,
      reviewCount: 0,
      instantBooking: true,
      saved: true,
    });
  });

  it('falls back to the typed size and a null rate', () => {
    const card = toBrowseCard(spot({ widthFt: null, heightFt: null, size: '10x4 ft', ratePerDay: null, basePrice: null }) as never, null);
    expect(card.size).toBe('10x4 ft');
    expect(card.ratePerDay).toBeNull();
  });
});

describe('browsing', () => {
  /* Lot V: a city filter naming a catalogued city with demand off answers "coming soon" instead of rows. */
  it('answers coming soon, and no rows, for a city whose stage has demand off; rows as ever for a launched city or a town off the catalogue', async () => {
    const OPEN = { supplyIntake: true, publishing: true, demand: true, agentOnboarding: true, printPartners: true, leadFeeds: true };
    pricing.citySupport.mockImplementation(async (name: string) =>
      name === 'Mysuru'
        ? { support: 'ACTIVE', resolved: true, stage: 'SEEDING', switches: { ...OPEN, publishing: false, demand: false, printPartners: false }, city: { slug: 'mysuru', name } }
        : name === 'Bengaluru'
          ? { support: 'ACTIVE', resolved: true, stage: 'LAUNCHED', switches: OPEN, city: { slug: 'bengaluru', name } }
          : { support: 'UNKNOWN', resolved: false, stage: null, switches: OPEN, city: null },
    );
    const soon = await browseListings({ sort: 'NEWEST', city: 'Mysuru' }, 1, 20);
    expect(soon).toEqual({ items: [], total: 0, page: 1, pageSize: 20, comingSoon: { city: 'Mysuru', slug: 'mysuru', stage: 'SEEDING' } });
    expect(repository.findActive).not.toHaveBeenCalled();

    const live = await browseListings({ sort: 'NEWEST', city: 'Bengaluru' }, 1, 20);
    expect(live).not.toHaveProperty('comingSoon');
    expect(live.items[0]!.id).toBe('lst_1');
    const far = await browseListings({ sort: 'NEWEST', city: 'Rameswaram' }, 1, 20);
    expect(far).not.toHaveProperty('comingSoon');
    expect(repository.findActive).toHaveBeenCalledTimes(2);
  });

  it('pages the repository’s answer as it is when no point is given', async () => {
    const page = await browseListings({ sort: 'NEWEST', category: 'OUTDOOR' }, 2, 10);
    expect(repository.findActive).toHaveBeenCalledWith({ sort: 'NEWEST', category: 'OUTDOOR' }, 2, 10);
    expect(page).toMatchObject({ total: 1, page: 2, pageSize: 10 });
    expect(page.items[0]!.id).toBe('lst_1');
  });

  it('around a point, orders by exact distance and cuts to the radius', async () => {
    repository.findActive.mockResolvedValue({
      items: [
        spot({ id: 'far', latitude: 13.2, longitude: 77.9 }),
        spot({ id: 'near', latitude: 12.976, longitude: 77.606 }),
        spot({ id: 'mid', latitude: 12.99, longitude: 77.62 }),
      ],
      total: 3,
    });
    const page = await browseListings({ sort: 'NEWEST', near: { latitude: 12.975, longitude: 77.605, radiusKm: 5 } });
    expect(page.items.map((card) => card.id)).toEqual(['near', 'mid']);
    expect(page.items[0]!.distanceM).toBeLessThan(page.items[1]!.distanceM!);
    expect(page.total).toBe(2);
  });

  it('resolves the saved mark for the calling advertiser in one query, and never for nobody', async () => {
    repository.findActive.mockResolvedValue({ items: [spot({ id: 'a' }), spot({ id: 'b' })], total: 2 });
    repository.savedListingIds.mockResolvedValue(['b']);
    const page = await browseListings({ sort: 'NEWEST' }, 1, 20, { advertiserId: 'adv_1' });
    expect(repository.savedListingIds).toHaveBeenCalledTimes(1);
    expect(repository.savedListingIds).toHaveBeenCalledWith('adv_1', ['a', 'b']);
    expect(page.items.map((card) => card.saved)).toEqual([false, true]);

    repository.savedListingIds.mockClear();
    const anonymous = await browseListings({ sort: 'NEWEST' }, 1, 20, { advertiserId: null });
    expect(repository.savedListingIds).not.toHaveBeenCalled();
    expect(anonymous.items.every((card) => card.saved === false)).toBe(true);

    repository.savedListingIds.mockResolvedValue(['lst_1']);
    expect((await getBrowseListing('lst_1', { advertiserId: 'adv_1' })).saved).toBe(true);
  });

  it('a spot that is not live reads as missing', async () => {
    repository.findActiveById.mockResolvedValueOnce(null);
    await expect(getBrowseListing('lst_x')).rejects.toMatchObject({ statusCode: 404 });
    expect((await getBrowseListing('lst_1')).title).toBe('MG Road Digital Billboard');
  });
});
