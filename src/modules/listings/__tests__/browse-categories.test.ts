import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G12-B — the two reads the Lot G mobile screens asked of browse.
 *
 * `GET /listings/browse/categories` is the "Browse by category" grid: one
 * tile per ListingCategory in the place, with the count of live spots and a
 * photograph to draw it with — the newest spot's first public photo. The
 * place is resolved the way browse resolves it: a city by name, or a point
 * and a radius, the box cut to the circle by exact distance.
 *
 * Every browse card also carries `display: 'DIGITAL' | 'STATIC'`, the
 * verdict of the one loop rule `slots.service.carriesLoop` applies, so the
 * apps stop re-implementing "does the sub-type say screen".
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findActive: vi.fn(),
    findActiveById: vi.fn(),
    findActiveForCategories: vi.fn(),
    savedListingIds: vi.fn(),
    slotsHeld: vi.fn(async () => new Map()),
  },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
// Lot X-L: the typed city resolves to its key before the repository is asked — Bengaluru is catalogued here.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  citySupport: vi.fn(),
}));

import { browseCategories, toBrowseCard, getBrowseListing } from '../browse.service';
import { browseCategoriesQuerySchema } from '../listings.schema';

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  displayId: 'LST-0001',
  title: 'MG Road Billboard',
  category: 'OUTDOOR',
  subType: 'Unipole',
  address: 'MG Road',
  city: 'Bengaluru',
  latitude: 12.975,
  longitude: 77.605,
  ratePerDay: '18000',
  pricingUnit: 'PER_DAY',
  basePrice: '18000',
  widthFt: null,
  heightFt: null,
  size: null,
  photos: [{ url: 'https://cdn.adx.in/l/1.jpg', type: 'main' }],
  description: null,
  illumination: null,
  facing: null,
  placement: null,
  visibility: null,
  estimatedDailyFootfall: null,
  availableNow: true,
  availableFrom: null,
  availableHoursFrom: null,
  availableHoursTo: null,
  peakPeriodNote: null,
  targetAudience: null,
  uniqueSellingPoint: null,
  ratingAvg: null,
  reviewCount: 0,
  instantBooking: false,
  slotsTotal: 1,
  mediaType: null,
  publisher: { name: 'Suraj Kumar' },
  ...over,
});

const tile = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  category: 'OUTDOOR',
  latitude: 12.975,
  longitude: 77.605,
  publishedAt: new Date('2026-09-10T00:00:00.000Z'),
  photos: [{ url: 'https://cdn.adx.in/l/1.jpg', type: 'main' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.savedListingIds.mockResolvedValue([]);
  repository.findActiveById.mockResolvedValue(spot());
  repository.findActiveForCategories.mockResolvedValue([]);
});

describe('the card’s display', () => {
  it('is DIGITAL when the sub-type names a screen — the loop rule, not a substring of "digital"', () => {
    expect(toBrowseCard(spot({ subType: 'Digital screen' }) as never, null).display).toBe('DIGITAL');
    expect(toBrowseCard(spot({ subType: 'LED wall' }) as never, null).display).toBe('DIGITAL');
    expect(toBrowseCard(spot({ subType: 'Screen-printed vinyl' }) as never, null).display).toBe('STATIC');
    expect(toBrowseCard(spot({ subType: null }) as never, null).display).toBe('STATIC');
  });

  it('reads the media type the spot was filed under — its name or the catalogue heading — the way slots does', () => {
    expect(toBrowseCard(spot({ subType: 'Wall', mediaType: { name: 'LCD panel', formatGroup: null } }) as never, null).display).toBe('DIGITAL');
    expect(toBrowseCard(spot({ subType: 'Wall', mediaType: { name: 'Kiosk', formatGroup: 'Digital Displays' } }) as never, null).display).toBe('DIGITAL');
    expect(toBrowseCard(spot({ subType: 'Wall', mediaType: { name: 'Vinyl', formatGroup: 'Print' } }) as never, null).display).toBe('STATIC');
    // A row read without the join (a saved-spaces fake, an older caller) is a static wall unless the sub-type says otherwise.
    expect(toBrowseCard(spot({ subType: 'Wall', mediaType: undefined }) as never, null).display).toBe('STATIC');
  });

  it('rides the single-spot read too', async () => {
    repository.findActiveById.mockResolvedValue(spot({ subType: 'Digital screen', slotsTotal: 6 }));
    const card = await getBrowseListing('lst_1');
    expect(card).toMatchObject({ display: 'DIGITAL', slotsTotal: 6 });
  });
});

describe('the categories query', () => {
  it('takes a city, or a point with a radius that defaults to 10 km', () => {
    expect(browseCategoriesQuerySchema.parse({ city: 'Bengaluru' })).toMatchObject({ city: 'Bengaluru', radiusKm: 10 });
    expect(browseCategoriesQuerySchema.parse({ lat: '12.9', lng: '77.6', radiusKm: '25' })).toMatchObject({ lat: 12.9, lng: 77.6, radiusKm: 25 });
    expect(browseCategoriesQuerySchema.parse({})).toMatchObject({ radiusKm: 10 });
  });

  it('refuses half a point', () => {
    expect(browseCategoriesQuerySchema.safeParse({ lat: '12.9' }).success).toBe(false);
    expect(browseCategoriesQuerySchema.safeParse({ lng: '77.6' }).success).toBe(false);
  });
});

describe('GET /listings/browse/categories', () => {
  it('counts the live spots per category, sorted by count, every category present', async () => {
    repository.findActiveForCategories.mockResolvedValue([
      tile({ id: 'a', category: 'INDOOR', publishedAt: new Date('2026-09-12T00:00:00.000Z'), photos: [{ url: 'https://cdn.adx.in/l/a.jpg', type: 'main' }] }),
      tile({ id: 'b', category: 'OUTDOOR', publishedAt: new Date('2026-09-11T00:00:00.000Z'), photos: [{ url: 'https://cdn.adx.in/l/b.jpg', type: 'main' }] }),
      tile({ id: 'c', category: 'INDOOR', publishedAt: new Date('2026-09-10T00:00:00.000Z'), photos: [{ url: 'https://cdn.adx.in/l/c.jpg', type: 'main' }] }),
      tile({ id: 'd', category: 'INDOOR', publishedAt: new Date('2026-09-09T00:00:00.000Z'), photos: [] }),
    ]);

    const result = await browseCategories({ city: 'Bengaluru' });

    expect(repository.findActiveForCategories).toHaveBeenCalledWith({ city: 'Bengaluru', cityId: 'city_bengaluru' });
    expect(result.items.map((item) => [item.category, item.count])).toEqual([
      ['INDOOR', 3],
      ['OUTDOOR', 1],
      ['TRANSIT', 0],
      ['MEDIA', 0],
    ]);
    // The newest spot's first public photo, not the first row's.
    expect(result.items[0]!.photoUrl).toBe('https://cdn.adx.in/l/a.jpg');
    expect(result.items[1]!.photoUrl).toBe('https://cdn.adx.in/l/b.jpg');
    expect(result.items[2]!.photoUrl).toBeNull();
    expect(result.total).toBe(4);
  });

  it('draws the tile with the newest spot that has a public photo — a private file address is not a picture', async () => {
    repository.findActiveForCategories.mockResolvedValue([
      tile({ id: 'newest', category: 'OUTDOOR', publishedAt: new Date('2026-09-12T00:00:00.000Z'), photos: [{ url: '/api/v1/files/f_1', type: 'main' }] }),
      tile({ id: 'older', category: 'OUTDOOR', publishedAt: new Date('2026-09-11T00:00:00.000Z'), photos: [{ url: 'https://cdn.adx.in/l/older.jpg', type: 'gallery' }] }),
    ]);
    const result = await browseCategories({ city: 'Bengaluru' });
    expect(result.items[0]).toMatchObject({ category: 'OUTDOOR', count: 2, photoUrl: 'https://cdn.adx.in/l/older.jpg' });
  });

  it('around a point, cuts the box to the circle by exact distance — the way browse does', async () => {
    repository.findActiveForCategories.mockResolvedValue([
      tile({ id: 'near', category: 'TRANSIT', latitude: 12.976, longitude: 77.606 }),
      // Inside the bounding box's corner, outside the circle.
      tile({ id: 'corner', category: 'MEDIA', latitude: 12.975 + 0.085, longitude: 77.605 + 0.085 }),
      tile({ id: 'nowhere', category: 'MEDIA', latitude: null, longitude: null }),
    ]);
    const near = { latitude: 12.975, longitude: 77.605, radiusKm: 10 };
    const result = await browseCategories({ near });
    expect(repository.findActiveForCategories).toHaveBeenCalledWith({ near });
    expect(result.items.find((item) => item.category === 'TRANSIT')?.count).toBe(1);
    expect(result.items.find((item) => item.category === 'MEDIA')?.count).toBe(0);
    expect(result.total).toBe(1);
  });
});
