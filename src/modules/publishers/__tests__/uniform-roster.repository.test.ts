import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — the party rosters, made uniform: what `findRosterPage`
 * asks the database. Every cut is one AND part (so the city's `OR` and the
 * search's `OR` cannot overwrite each other); the search reaches the email
 * and the phone as the console prints it; the KYC state is the queue's where
 * fragment; the row joins the six KYC columns, never the document links, and
 * counts the spots instead of joining them.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    publisher: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { kycRosterStateWhere } from '../../../shared/kyc-state';
import { publisherStateWhere } from '../../../shared/party-status';
import { prismaPublishersRepository as repository } from '../prisma-publishers.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.publisher.findMany.mockResolvedValue([
    { id: 'pub_1', name: 'Suraj Kumar Prints', kycStatus: 'PENDING', kyc: null, _count: { listings: 3 }, agent: null, user: null },
  ]);
  prisma.publisher.count.mockResolvedValue(1);
  prisma.publisher.groupBy.mockResolvedValue([{ kycStatus: 'PENDING', _count: { _all: 1 } }]);
});

describe('findRosterPage', () => {
  it('ANDs the search, the door, the KYC state, the type and the city', async () => {
    await repository.findRosterPage({ q: '+91 98765 43210', onboardedVia: 'DESK', kycState: 'REQUESTED', type: 'BUSINESS', city: 'Bengaluru', cityId: 'city_blr', page: 1, pageSize: 100 });
    const [args] = prisma.publisher.findMany.mock.calls[0]!;
    // Account lifecycle (2 Oct 2026): the cuts sit inside the base, beside the status facet (ACTIVE by default).
    const parts = args.where.AND[0].AND[0].AND;
    expect(parts).toContainEqual({ onboardedVia: 'DESK' });
    expect(parts).toContainEqual(kycRosterStateWhere('REQUESTED', true));
    expect(parts).toContainEqual({ type: 'BUSINESS' });
    expect(parts).toContainEqual({ OR: [{ cityId: 'city_blr' }, { cityId: null, city: { equals: 'Bengaluru', mode: 'insensitive' } }] });
    const search = parts.find((part: { OR?: unknown[] }) => Array.isArray(part.OR) && part.OR.some((clause) => 'email' in (clause as object)));
    expect(search.OR).toContainEqual({ email: { contains: '+91 98765 43210', mode: 'insensitive' } });
    // The phone as printed finds the row stored as +919876543210 or as the bare ten digits.
    expect(search.OR).toContainEqual({ mobile: { contains: '9876543210' } });
  });

  it('matches only the rows keyed to nothing when the city did not resolve', async () => {
    await repository.findRosterPage({ city: 'Nowhere', cityId: null, page: 1, pageSize: 20 });
    const [args] = prisma.publisher.findMany.mock.calls[0]!;
    expect(args.where.AND[0].AND[0].AND).toContainEqual({ cityId: null, city: { equals: 'Nowhere', mode: 'insensitive' } });
  });

  it('keeps the KYC tab out of the chip counts', async () => {
    await repository.findRosterPage({ category: 'KYC', type: 'INDIVIDUAL', page: 1, pageSize: 20 });
    const [findArgs] = prisma.publisher.findMany.mock.calls[0]!;
    const [groupArgs] = prisma.publisher.groupBy.mock.calls[0]!;
    expect(findArgs.where.AND).toContainEqual({ kycStatus: 'VERIFIED' });
    expect(groupArgs.where).toEqual({ AND: [{ AND: [{ type: 'INDIVIDUAL' }] }, publisherStateWhere('ACTIVE')] });
  });

  it('joins the six KYC columns and counts the spots rather than joining them', async () => {
    const page = await repository.findRosterPage({ page: 1, pageSize: 20 });
    const [args] = prisma.publisher.findMany.mock.calls[0]!;
    expect(args.include.kyc).toEqual({ select: { id: true, status: true, submittedAt: true, requestedAt: true, requestedChannel: true, method: true } });
    expect(args.include._count).toEqual({ select: { listings: true } });
    expect(args.include.listings).toBeUndefined();
    expect(page.items[0]).toMatchObject({ id: 'pub_1', listingCount: 3 });
    expect(page.items[0]).not.toHaveProperty('_count');
  });
});
