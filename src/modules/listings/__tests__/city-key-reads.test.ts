import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot X-L: the two listings reads the verifier named still on the city
 * string, moved to the key — over the real Prisma repository with the
 * client stubbed, so what is pinned is the `where` that reaches the table.
 *
 * `findSimilar` compares by the key when the listing carries one (a spot
 * typed 'Bangalore' is compared with the Bengaluru ones), else the string.
 * Browse stays on the spelling BY DESIGN — a shopper types — but the typed
 * value is resolved through `cityKeyFor` and, when it resolves, the rows
 * keyed to that city match as well as the spelling.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    listing: { findMany: vi.fn(), count: vi.fn() },
    order: { findMany: vi.fn() },
    campaignSpot: { groupBy: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
// Bengaluru (and its old spelling) is catalogued and launched; the rest are typed towns.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  citySupport: async () => ({ support: 'UNKNOWN', resolved: false, stage: null, switches: {}, city: null }),
}));

import { browseCategories, browseListings } from '../browse.service';
import { prismaListingsRepository as repository } from '../prisma-listings.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.listing.findMany.mockResolvedValue([]);
  prisma.listing.count.mockResolvedValue(0);
});

const listing = (over: Record<string, unknown> = {}) =>
  ({ id: 'lst_1', city: 'Bangalore', cityId: 'city_bengaluru', category: 'OUTDOOR', monthlyPrice: 1000, ...over }) as never;

describe('findSimilar — by key when the listing carries one', () => {
  it("a spot typed 'Bangalore' with the Bengaluru key is compared with every spot keyed to Bengaluru", async () => {
    await repository.findSimilar(listing());
    const [args] = prisma.listing.findMany.mock.calls[0]!;
    expect(args.where).toMatchObject({ id: { not: 'lst_1' }, cityId: 'city_bengaluru', category: 'OUTDOOR', status: 'ACTIVE' });
    expect(args.where.city).toBeUndefined();
  });

  it('a spot in a town nobody catalogued is compared by the string, as before', async () => {
    await repository.findSimilar(listing({ city: 'Rameswaram', cityId: null }));
    const [args] = prisma.listing.findMany.mock.calls[0]!;
    expect(args.where).toMatchObject({ city: 'Rameswaram' });
    expect(args.where.cityId).toBeUndefined();
  });
});

describe('GET /listings/browse?city= — the spelling by design, plus the key when it resolves', () => {
  const placeClause = () => prisma.listing.findMany.mock.calls[0]![0].where.AND[0];

  it("a shopper typing 'Bangalore' sees the Bengaluru listings: keyed rows by key OR the spelling", async () => {
    await browseListings({ sort: 'NEWEST', city: 'Bangalore' }, 1, 20);
    expect(placeClause()).toEqual({
      OR: [{ cityId: 'city_bengaluru' }, { city: { contains: 'Bangalore', mode: 'insensitive' } }],
    });
  });

  it('a town nobody catalogued matches by the spelling alone, and q keeps the top-level OR', async () => {
    await browseListings({ sort: 'NEWEST', city: 'Rameswaram', q: 'temple' }, 1, 20);
    const [args] = prisma.listing.findMany.mock.calls[0]!;
    expect(args.where.AND[0]).toEqual({ city: { contains: 'Rameswaram', mode: 'insensitive' } });
    expect(args.where.OR[0]).toEqual({ title: { contains: 'temple', mode: 'insensitive' } });
  });

  it('the category grid resolves the place the same way', async () => {
    await browseCategories({ city: 'bengaluru' });
    expect(placeClause()).toEqual({
      OR: [{ cityId: 'city_bengaluru' }, { city: { contains: 'bengaluru', mode: 'insensitive' } }],
    });
  });
});
