import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AV-1 (the owner, 27 Sep 2026): a dated search keeps a static space that is
 * booked over PART of the window — its card says "Partly booked · n of m
 * days free" — and hides it only when one booking covers the whole window,
 * so no day of it can be free. A loop is never hidden for a booking.
 */
const { prisma } = vi.hoisted(() => ({
  prisma: { listing: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) } },
}));
vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
vi.mock('../../pricing', () => ({
  cityKeyFor: async () => null,
  citySupport: async () => ({ support: 'UNKNOWN', resolved: false, stage: null, switches: {}, city: null }),
}));

import { prismaListingsRepository as repository } from '../prisma-listings.repository';

type Where = { AND?: unknown[] };
const clashClause = (where: Where) =>
  (where.AND ?? []).find((clause) => JSON.stringify(clause).includes('"slotsTotal":{"gt":1}')) as
    | { OR: [unknown, { NOT: { campaignSpots: { some: { AND: [{ OR: unknown[] }, { OR: unknown[] }] } } } }] }
    | undefined;

beforeEach(() => vi.clearAllMocks());

describe('a dated search', () => {
  it('hides a static space only when one booking covers the whole window', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-31T23:59:59.999Z');
    await repository.findActive({ sort: 'NEWEST', from, to } as never, 1, 20);
    const where = (prisma.listing.count.mock.calls[0] as unknown as [{ where: Where }])[0].where;
    const clause = clashClause(where);
    expect(clause).toBeDefined();
    const [starts, ends] = clause!.OR[1].NOT.campaignSpots.some.AND;
    // The booking must start on or before the window's first day AND end on or after its last.
    expect(starts.OR).toEqual([{ startDate: null }, { startDate: { lte: from } }]);
    expect(ends.OR).toEqual([{ endDate: null }, { endDate: { gte: to } }]);
  });

  it('adds nothing without an end to the window', async () => {
    await repository.findActive({ sort: 'NEWEST' } as never, 1, 20);
    const where = (prisma.listing.count.mock.calls[0] as unknown as [{ where: Where }])[0].where;
    expect(clashClause(where)).toBeUndefined();
  });
});
