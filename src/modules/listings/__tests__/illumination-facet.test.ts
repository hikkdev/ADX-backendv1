import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 26 Sep 2026 — `GET /listings/browse?illumination=FRONTLIT,BACKLIT`: how
 * the face is lit. The listing flow stores the option's title ("Front-lit"),
 * the seed the upper-case word ("FRONTLIT"); both match, case-insensitively,
 * and a spot with nothing recorded counts as NONE. The clause sits in the
 * AND list so `q`'s OR keeps its seat.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: { listing: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) } },
}));

vi.mock('../../../shared/database', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), prisma }));
vi.mock('../../pricing', () => ({ cityKeyFor: async () => null, citySupport: async () => ({ support: 'UNKNOWN', resolved: false, stage: null, switches: {}, city: null }) }));

import { browseQuerySchema } from '../listings.schema';
import { prismaListingsRepository as repository } from '../prisma-listings.repository';

beforeEach(() => vi.clearAllMocks());

describe('the illumination facet', () => {
  it('parses a comma list, upper-cased and de-duplicated; refuses an unknown kind', () => {
    expect(browseQuerySchema.parse({ illumination: 'frontlit, BACKLIT,frontlit' }).illumination).toEqual(['FRONTLIT', 'BACKLIT']);
    expect(browseQuerySchema.parse({}).illumination).toBeUndefined();
    expect(browseQuerySchema.safeParse({ illumination: 'NEON' }).success).toBe(false);
  });

  it('matches both spellings of each kind, and NONE takes an empty column too', async () => {
    await repository.findActive({ sort: 'NEWEST', illumination: ['FRONTLIT', 'NONE'], q: 'mall' }, 1, 20);
    const where = (prisma.listing.findMany.mock.calls[0] as unknown as [{ where: { AND: { OR?: unknown[] }[]; OR?: unknown[] } }])[0].where;
    const facet = where.AND.find((clause) => JSON.stringify(clause).includes('Front-lit'));
    expect(facet?.OR).toEqual(expect.arrayContaining([
      { illumination: { equals: 'FRONTLIT', mode: 'insensitive' } },
      { illumination: { equals: 'Front-lit', mode: 'insensitive' } },
      { illumination: { equals: 'Non-lit', mode: 'insensitive' } },
      { illumination: null },
    ]));
    expect(JSON.stringify(facet)).not.toContain('Back-lit');
    // `q` keeps the top-level OR.
    expect(JSON.stringify(where.OR)).toContain('mall');
  });

  it('adds no clause when the facet is absent', async () => {
    await repository.findActive({ sort: 'NEWEST' }, 1, 20);
    const where = (prisma.listing.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(JSON.stringify(where)).not.toContain('Front-lit');
  });
});
