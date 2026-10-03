import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LM-1 — sponsored listings in browse and the similar row.
 *
 * Pinned: page one of the default order carries today's SEARCH_TOP boosts
 * whose listing is in the filtered set, first, marked `sponsored: true` with
 * the `boostId`, lifted out of their organic place; at most the placement's
 * `maxConcurrent`; nothing on a later page, around a point, or under a
 * chosen sort; the similar row (and `similarTo`) put SIMILAR_TOP boosts
 * first; an unregistered or failing port is a page with nothing sponsored.
 */

const { repository } = vi.hoisted(() => ({
  repository: {
    findActive: vi.fn(),
    findById: vi.fn(),
    findActiveByDisplayId: vi.fn(),
    findSimilar: vi.fn(),
    savedListingIds: vi.fn(async () => []),
    datedHolds: vi.fn(async () => []),
  },
}));

vi.mock('../prisma-listings.repository', async (importOriginal) => ({ ...(await importOriginal<typeof import('../prisma-listings.repository')>()), prismaListingsRepository: repository }));
vi.mock('../../pricing', () => ({ citySupport: vi.fn(async () => ({ resolved: false })), cityKeyFor: async () => null }));

import { browseListings, similarListings } from '../browse.service';
import { registerSponsoredPort } from '../sponsored.port';

const row = (id: string) => ({
  id,
  displayId: `LST-${id}`,
  title: `Spot ${id}`,
  category: 'OUTDOOR',
  subType: 'Hoarding',
  address: 'MG Road',
  city: 'Bengaluru',
  cityId: 'city_blr',
  latitude: 12.97,
  longitude: 77.6,
  ratePerDay: '1000',
  pricingUnit: 'PER_DAY',
  basePrice: '1000',
  widthFt: null,
  heightFt: null,
  size: null,
  photos: [],
  publisherId: 'pub_1',
  publisher: { name: 'Sharma Media', kycStatus: 'VERIFIED', user: null },
  mediaType: null,
  slotsTotal: 1,
  monthlyPrice: 30000,
});

const live = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  registerSponsoredPort({ live });
  live.mockResolvedValue({ max: 2, boosts: [] });
  // The organic page: five spots, newest first.
  repository.findActive.mockImplementation(async (filter: { onlyIds?: string[] }) => {
    if (filter.onlyIds) return { items: filter.onlyIds.filter((id) => id !== 'lst_outside').map(row), total: filter.onlyIds.length };
    return { items: ['lst_1', 'lst_2', 'lst_3', 'lst_4', 'lst_5'].map(row), total: 42 };
  });
  repository.findById.mockImplementation(async (id: string) => (id === 'lst_anchor' ? row('lst_anchor') : null));
  repository.findSimilar.mockResolvedValue(['lst_2', 'lst_3', 'lst_4'].map(row));
});

describe('GET /listings/browse — SEARCH_TOP', () => {
  it('puts the boosted listing first, marked, and lifts it out of its organic place', async () => {
    live.mockResolvedValue({ max: 2, boosts: [{ boostId: 'bst_1', listingId: 'lst_4' }] });
    const page = await browseListings({ sort: 'NEWEST', city: 'Bengaluru' }, 1, 20);
    expect(page.items.map((card) => card.id)).toEqual(['lst_4', 'lst_1', 'lst_2', 'lst_3', 'lst_5']);
    expect(page.items[0]).toMatchObject({ sponsored: true, boostId: 'bst_1' });
    expect(page.items[1]).not.toHaveProperty('sponsored');
    expect(page.total).toBe(42);
    expect(live).toHaveBeenCalledWith('SEARCH_TOP', expect.any(Date));
    // The boosted ids are checked against the page's own filters.
    expect(repository.findActive).toHaveBeenCalledWith(expect.objectContaining({ city: 'Bengaluru', onlyIds: ['lst_4'] }), 1, 1);
  });

  it('shows only boosts whose listing is in the filtered set', async () => {
    live.mockResolvedValue({ max: 2, boosts: [{ boostId: 'bst_x', listingId: 'lst_outside' }] });
    const page = await browseListings({ sort: 'NEWEST', category: 'INDOOR' }, 1, 20);
    expect(page.items.some((card) => card.sponsored)).toBe(false);
  });

  it('carries at most the placement\'s maxConcurrent, a listing boosted twice once', async () => {
    live.mockResolvedValue({
      max: 2,
      boosts: [
        { boostId: 'bst_1', listingId: 'lst_9' },
        { boostId: 'bst_2', listingId: 'lst_8' },
        { boostId: 'bst_3', listingId: 'lst_7' },
        { boostId: 'bst_4', listingId: 'lst_9' },
      ],
    });
    const page = await browseListings({ sort: 'NEWEST' }, 1, 20);
    const sponsored = page.items.filter((card) => card.sponsored);
    expect(sponsored).toHaveLength(2);
    expect(new Set(sponsored.map((card) => card.id)).size).toBe(2);
    expect(page.items.slice(0, 2).every((card) => card.sponsored)).toBe(true);
  });

  it('leaves page two, a chosen sort and a search around a point organic', async () => {
    live.mockResolvedValue({ max: 2, boosts: [{ boostId: 'bst_1', listingId: 'lst_4' }] });
    expect((await browseListings({ sort: 'NEWEST' }, 2, 20)).items.some((card) => card.sponsored)).toBe(false);
    expect((await browseListings({ sort: 'PRICE_ASC' }, 1, 20)).items.some((card) => card.sponsored)).toBe(false);
    expect((await browseListings({ sort: 'NEWEST', near: { latitude: 12.97, longitude: 77.6, radiusKm: 5 } }, 1, 20)).items.some((card) => card.sponsored)).toBe(false);
  });

  it('a failing port is a page with nothing sponsored', async () => {
    live.mockRejectedValue(new Error('db down'));
    const page = await browseListings({ sort: 'NEWEST' }, 1, 20);
    expect(page.items.map((card) => card.id)).toEqual(['lst_1', 'lst_2', 'lst_3', 'lst_4', 'lst_5']);
  });
});

describe('SIMILAR_TOP — the similar row and "view all similar"', () => {
  it('puts the boosted similar listing first in the row, within the limit', async () => {
    live.mockResolvedValue({ max: 3, boosts: [{ boostId: 'bst_s', listingId: 'lst_3' }] });
    const cards = await similarListings('lst_anchor', 3);
    expect(cards.map((card) => card.id)).toEqual(['lst_3', 'lst_2', 'lst_4']);
    expect(cards[0]).toMatchObject({ sponsored: true, boostId: 'bst_s' });
    expect(live).toHaveBeenCalledWith('SIMILAR_TOP', expect.any(Date));
    // Checked against the similar rule, not the whole market.
    expect(repository.findActive).toHaveBeenCalledWith(expect.objectContaining({ similar: expect.objectContaining({ excludeId: 'lst_anchor' }), onlyIds: ['lst_3'] }), 1, 1);
  });

  it('?similarTo= reads SIMILAR_TOP, not SEARCH_TOP', async () => {
    live.mockResolvedValue({ max: 3, boosts: [{ boostId: 'bst_s', listingId: 'lst_5' }] });
    const page = await browseListings({ sort: 'NEWEST', similarToId: 'lst_anchor' }, 1, 20);
    expect(live).toHaveBeenCalledWith('SIMILAR_TOP', expect.any(Date));
    expect(page.items[0]).toMatchObject({ id: 'lst_5', sponsored: true });
  });
});
