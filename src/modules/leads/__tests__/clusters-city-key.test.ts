import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot X-L: the hunting map's city scope on the key. Without a position the
 * dashboard clusters the agent's city; that city is resolved to its key and
 * the bubbles cover the leads keyed to it — whatever they were typed as —
 * plus the null-keyed ones typed under this spelling, so 'Bengaluru' and
 * 'Bangalore' are one map rather than two. Pinned over the real Prisma
 * repository with the client stubbed: the `where` that reaches the table.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: { lead: { groupBy: vi.fn() } },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
// Bengaluru (and its old spelling) is catalogued; the rest are typed towns.
vi.mock('../../pricing', () => ({
  cityKeyFor: async (name: string | null | undefined) => (name && /^(bengaluru|bangalore)$/i.test(name.trim()) ? { cityId: 'city_bengaluru', slug: 'bengaluru' } : null),
  citySupport: vi.fn(),
  withCityKey: async (data: { city?: string | null }) => data,
}));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../payouts', () => ({ rateFor: vi.fn() }));
vi.mock('../../visits', () => ({ createVisit: vi.fn() }));
vi.mock('../../agents', () => ({ assertAgentAcceptsWork: vi.fn() }));

import { leadClusters } from '../leads.service';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.lead.groupBy.mockResolvedValue([
    { locality: 'Koramangala', _count: { _all: 4 }, _avg: { latitude: 12.93, longitude: 77.62 } },
    { locality: 'Indiranagar', _count: { _all: 7 }, _avg: { latitude: 12.97, longitude: 77.64 } },
  ]);
});

const where = () => prisma.lead.groupBy.mock.calls[0]![0].where;

describe('leadClusters by city — one map, not one per spelling', () => {
  it("scoped to 'Bangalore', clusters the leads keyed to Bengaluru plus the null-keyed ones typed 'Bangalore'", async () => {
    const clusters = await leadClusters({ city: 'Bangalore' });
    expect(where()).toMatchObject({
      status: { notIn: ['CONVERTED', 'LOST'] },
      locality: { not: null },
      OR: [{ cityId: 'city_bengaluru' }, { cityId: null, city: { equals: 'Bangalore', mode: 'insensitive' } }],
    });
    expect(where().city).toBeUndefined();
    expect(clusters.map((c) => [c.label, c.count])).toEqual([
      ['Indiranagar', 7],
      ['Koramangala', 4],
    ]);
  });

  it('a town nobody catalogued clusters by the spelling alone, as before', async () => {
    await leadClusters({ city: 'Rameswaram' });
    expect(where()).toMatchObject({ city: { equals: 'Rameswaram', mode: 'insensitive' } });
    expect(where().OR).toBeUndefined();
  });

  it('a point scope is untouched — the box, no city', async () => {
    await leadClusters({ point: { latitude: 12.97, longitude: 77.59, radiusKm: 5 } });
    expect(where().OR).toBeUndefined();
    expect(where().city).toBeUndefined();
    expect(where().latitude).toBeDefined();
  });
});
