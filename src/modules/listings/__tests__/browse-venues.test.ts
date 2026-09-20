import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-20 (the owner, 17 Sep 2026) — the sub-categories are tiles too.
 *
 * `GET /listings/browse/venues` answers every active venue type of the
 * catalogue for the place, with how many live spots stand in it and the
 * newest one's photograph; the order is the frame's category order, then
 * the counted venues, then the curated venues people look for first, then
 * the alphabet. The tile's word is the short label where one is known,
 * the catalogue name's first segment otherwise. The browse takes the venue
 * as a facet beside the category.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findActiveForCategories: vi.fn(),
    venueTypes: vi.fn(),
  },
}));

vi.mock('../prisma-listings.repository', () => ({ prismaListingsRepository: repository }));
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  citySupport: vi.fn(),
}));

import { browseVenues, venueLabel } from '../browse.service';
import { browseQuerySchema } from '../listings.schema';

const venues = [
  { id: 'vt_malls', name: 'Shopping Malls / Retail Centers / Department Stores', slug: 'shopping-malls-retail-centers-department-stores', category: 'INDOOR' },
  { id: 'vt_gyms', name: 'Gyms / Fitness Clubs / Wellness Centers / Yoga Studios', slug: 'gyms-fitness-clubs-wellness-centers-yoga-studios', category: 'INDOOR' },
  { id: 'vt_bowling', name: 'Bowling Alleys', slug: 'bowling-alleys', category: 'INDOOR' },
  { id: 'vt_roads', name: 'City Roads / Urban Streets / Main Roads', slug: 'city-roads-urban-streets-main-roads', category: 'OUTDOOR' },
  { id: 'vt_metro', name: 'Metro / Subway / Underground', slug: 'metro-subway-underground', category: 'TRANSIT' },
  { id: 'vt_radio', name: 'Radio', slug: 'radio', category: 'MEDIA' },
];

const spot = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  category: 'INDOOR',
  venueTypeId: 'vt_gyms',
  latitude: 12.975,
  longitude: 77.605,
  publishedAt: new Date('2026-09-10T00:00:00Z'),
  photos: [{ url: 'https://cdn.adx.in/l/gym.jpg', type: 'main' }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.venueTypes.mockResolvedValue(venues);
  repository.findActiveForCategories.mockResolvedValue([]);
});

describe('browseVenues', () => {
  it('answers every venue, counted, in the category order, counted first, then the curated order, then the alphabet', async () => {
    repository.findActiveForCategories.mockResolvedValue([
      spot(),
      spot({ id: 'lst_2', publishedAt: new Date('2026-09-01T00:00:00Z'), photos: [] }),
      spot({ id: 'lst_3', category: 'OUTDOOR', venueTypeId: 'vt_roads', photos: [{ url: 'https://cdn.adx.in/l/road.jpg', type: 'main' }] }),
      // A spot listed before venues: counted by nobody.
      spot({ id: 'lst_4', venueTypeId: null }),
    ]);
    const { items, total } = await browseVenues({ city: 'Bengaluru' });
    expect(total).toBe(4);
    expect(items.map((tile) => [tile.slug, tile.count])).toEqual([
      ['city-roads-urban-streets-main-roads', 1],
      ['gyms-fitness-clubs-wellness-centers-yoga-studios', 2],
      ['shopping-malls-retail-centers-department-stores', 0],
      ['bowling-alleys', 0],
      ['metro-subway-underground', 0],
      ['radio', 0],
    ]);
    expect(items[1]).toMatchObject({ venueTypeId: 'vt_gyms', label: 'Gyms', category: 'INDOOR', photoUrl: 'https://cdn.adx.in/l/gym.jpg' });
    expect(items[2]!.photoUrl).toBeNull();
  });

  it('cuts the count to the circle around a point', async () => {
    repository.findActiveForCategories.mockResolvedValue([spot(), spot({ id: 'far', latitude: 13.5, longitude: 78.2 })]);
    const { items, total } = await browseVenues({ near: { latitude: 12.97, longitude: 77.6, radiusKm: 10 } });
    expect(total).toBe(1);
    expect(items.find((tile) => tile.slug === 'gyms-fitness-clubs-wellness-centers-yoga-studios')?.count).toBe(1);
  });

  it("gives a tile its word — the short label where one is known, the catalogue name's first segment otherwise", () => {
    expect(venueLabel({ slug: 'shopping-malls-retail-centers-department-stores', name: 'Shopping Malls / Retail Centers / Department Stores' })).toBe('Malls');
    expect(venueLabel({ slug: 'bowling-alleys', name: 'Bowling Alleys' })).toBe('Bowling Alleys');
    expect(venueLabel({ slug: 'jewelry-stores-bullion-shops', name: 'Jewelry Stores / Bullion Shops' })).toBe('Jewelry Stores');
  });

  it('the browse takes the venue as a facet', () => {
    expect(browseQuerySchema.parse({ category: 'INDOOR', venueTypeId: 'vt_gyms' })).toMatchObject({ category: 'INDOOR', venueTypeId: 'vt_gyms' });
  });
});
