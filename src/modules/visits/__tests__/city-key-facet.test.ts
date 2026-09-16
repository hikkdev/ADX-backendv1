import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot X-L: `GET /visits?city=` (ADMIN) on the key semantic — the one admin
 * facet Lot X-B missed. The service resolves the typed value to the city
 * key; the repository matches keyed rows by key and null-keyed rows by the
 * spelling, so 'Bengaluru' and 'Bangalore' are one board; a town nobody
 * catalogued matches only the rows keyed to nothing.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    fieldVisit: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
// Bengaluru (and its old spelling) is catalogued; the rest are typed towns.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  withCityKey: async (data: { city?: string | null }) => data,
}));
vi.mock('../../agents', () => ({ requireAgentProfile: vi.fn(), findAgentProfile: vi.fn(), getAgentWithUser: vi.fn(), assertAgentAcceptsWork: vi.fn() }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../payouts', () => ({ recordIncentive: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn(), notify: vi.fn() }));

import { visitsForAdmin } from '../visits.service';
import { adminVisitsQuerySchema } from '../visits.schema';

const NOW = new Date('2026-09-15T06:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.fieldVisit.findMany.mockResolvedValue([]);
  prisma.fieldVisit.count.mockResolvedValue(0);
  prisma.fieldVisit.groupBy.mockResolvedValue([]);
});

const cityClause = () => {
  const [args] = prisma.fieldVisit.findMany.mock.calls[0]!;
  return args.where.AND[0];
};

describe('GET /visits?city= — the key is the identity', () => {
  it('two spellings of one city are one board: keyed rows by key, null-keyed rows by the spelling', async () => {
    await visitsForAdmin(adminVisitsQuerySchema.parse({ city: 'Bangalore' }), NOW);
    expect(cityClause()).toEqual({
      OR: [{ cityId: 'city_bengaluru' }, { cityId: null, city: { contains: 'Bangalore', mode: 'insensitive' } }],
    });
    prisma.fieldVisit.findMany.mockClear();
    await visitsForAdmin(adminVisitsQuerySchema.parse({ city: 'bengaluru' }), NOW);
    expect(cityClause().OR[0]).toEqual({ cityId: 'city_bengaluru' });
  });

  it('a town nobody catalogued matches only the rows keyed to nothing', async () => {
    await visitsForAdmin(adminVisitsQuerySchema.parse({ city: 'Rameswaram' }), NOW);
    expect(cityClause()).toEqual({ cityId: null, city: { contains: 'Rameswaram', mode: 'insensitive' } });
  });

  it('the city clause and q keep their own OR — neither overwrites the other', async () => {
    await visitsForAdmin(adminVisitsQuerySchema.parse({ city: 'Bengaluru', q: 'Cafe' }), NOW);
    const [args] = prisma.fieldVisit.findMany.mock.calls[0]!;
    expect(args.where.AND).toHaveLength(2);
    expect(args.where.AND[1].OR[0]).toEqual({ businessName: { contains: 'Cafe', mode: 'insensitive' } });
    expect(args.where.OR).toBeUndefined();
  });
});
