import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-5 (17 Sep 2026) — when an advertiser browses, verified publishers'
 * spots come first and the unverified follow; every card says which.
 *
 * The owner's rule: an unverified publisher lists and goes live, "just that
 * their listing will also be marked along with their profile as unverified
 * and be pushed below verified listings or profiles when an advertiser
 * checks out listings". A KycStatus enum cannot be ordered "VERIFIED first"
 * by the database (PENDING sorts before VERIFIED), so `findActive` reads
 * two partitions — verified (and ADX's own spots, which carry no
 * publisher) then the rest — and cuts one page across them. Pinned, over
 * the real repository with the client stubbed: the verified partition is
 * the same `where` plus one AND clause, so `q`'s OR and the place clause
 * keep their seats; a page is filled from the verified first and the rest
 * from the unverified with the offset moved past the verified count; a
 * page entirely inside either partition reads only that partition; `total`
 * is the whole; the card carries `publisherVerified`, true for ADX's own.
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
vi.mock('../../pricing', () => ({
  cityKeyFor: async () => null,
  citySupport: async () => ({ support: 'UNKNOWN', resolved: false, stage: null, switches: {}, city: null }),
}));

import { toBrowseCard } from '../browse.service';
import { prismaListingsRepository as repository } from '../prisma-listings.repository';

type Where = { AND?: unknown[]; OR?: unknown[] };
const isVerifiedPartition = (where: Where) =>
  (where.AND ?? []).some((clause) => JSON.stringify(clause) === JSON.stringify({ OR: [{ publisherId: null }, { publisher: { kycStatus: 'VERIFIED' } }] }));
const isUnverifiedPartition = (where: Where) =>
  (where.AND ?? []).some((clause) => JSON.stringify(clause) === JSON.stringify({ publisher: { kycStatus: { not: 'VERIFIED' } } }));

const row = (id: string, kycStatus: string | null) => ({
  id,
  publisherId: kycStatus === null ? null : `pub_${id}`,
  publisher: kycStatus === null ? null : { name: `Publisher ${id}`, kycStatus },
  photos: [],
  mediaType: null,
});

/** Stub the two partitions: `verified` and `unverified` are the rows each holds, in sort order. */
function stubPartitions(verified: ReturnType<typeof row>[], unverified: ReturnType<typeof row>[]) {
  prisma.listing.count.mockImplementation(async ({ where }: { where: Where }) =>
    isVerifiedPartition(where) ? verified.length : verified.length + unverified.length,
  );
  prisma.listing.findMany.mockImplementation(async ({ where, skip, take }: { where: Where; skip: number; take: number }) => {
    if (isVerifiedPartition(where)) return verified.slice(skip, skip + take);
    if (isUnverifiedPartition(where)) return unverified.slice(skip, skip + take);
    throw new Error('findMany without a partition');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findActive — verified first, the rest after, one page across both', () => {
  const verified = [row('v1', 'VERIFIED'), row('adx', null), row('v2', 'VERIFIED')];
  const unverified = [row('u1', 'PENDING'), row('u2', 'NEEDS_INFO'), row('u3', 'REJECTED'), row('u4', 'PENDING')];

  it('page 1 is the verified partition, then the unverified, in that order', async () => {
    stubPartitions(verified, unverified);
    const { items, total } = await repository.findActive({ sort: 'NEWEST' }, 1, 5);
    expect(items.map((item) => item.id)).toEqual(['v1', 'adx', 'v2', 'u1', 'u2']);
    expect(total).toBe(7);
  });

  it('page 2 continues the unverified from where page 1 left off — the offset moved past the verified count', async () => {
    stubPartitions(verified, unverified);
    const { items } = await repository.findActive({ sort: 'NEWEST' }, 2, 5);
    expect(items.map((item) => item.id)).toEqual(['u3', 'u4']);
    // Only the unverified partition was read for this page.
    const reads = prisma.listing.findMany.mock.calls.map(([args]) => args as { where: Where; skip: number; take: number });
    expect(reads).toHaveLength(1);
    expect(isUnverifiedPartition(reads[0]!.where)).toBe(true);
    expect(reads[0]).toMatchObject({ skip: 2, take: 5 });
  });

  it('a page entirely inside the verified reads only the verified', async () => {
    stubPartitions([row('v1', 'VERIFIED'), row('v2', 'VERIFIED'), row('v3', 'VERIFIED')], unverified);
    const { items } = await repository.findActive({ sort: 'NEWEST' }, 1, 2);
    expect(items.map((item) => item.id)).toEqual(['v1', 'v2']);
    const reads = prisma.listing.findMany.mock.calls.map(([args]) => args as { where: Where });
    expect(reads).toHaveLength(1);
    expect(isVerifiedPartition(reads[0]!.where)).toBe(true);
  });

  it('with nobody verified the list is the unverified alone, and nothing is read twice', async () => {
    stubPartitions([], unverified);
    const { items, total } = await repository.findActive({ sort: 'NEWEST' }, 1, 10);
    expect(items.map((item) => item.id)).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(total).toBe(4);
    expect(prisma.listing.findMany).toHaveBeenCalledTimes(1);
  });

  it('the partition is one more AND clause: q keeps the top-level OR and the sort is the same on both reads', async () => {
    stubPartitions(verified, unverified);
    await repository.findActive({ sort: 'PRICE_ASC', q: 'temple' }, 1, 5);
    const reads = prisma.listing.findMany.mock.calls.map(([args]) => args as { where: Where; orderBy: unknown });
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.where.OR?.[0]).toEqual({ title: { contains: 'temple', mode: 'insensitive' } });
      expect(read.orderBy).toEqual({ ratePerDay: 'asc' });
    }
    // And the whole-list count carries no partition.
    const counts = prisma.listing.count.mock.calls.map(([args]) => args as { where: Where });
    expect(counts.some((count) => !isVerifiedPartition(count.where) && !isUnverifiedPartition(count.where))).toBe(true);
  });
});

describe('the card says which', () => {
  const base = {
    id: 'lst_1',
    displayId: 'LST-0001',
    title: 'MG Road hoarding',
    category: 'OUTDOOR',
    subType: null,
    address: 'MG Road',
    city: 'Bengaluru',
    latitude: 12.9,
    longitude: 77.6,
    ratePerDay: '1000',
    pricingUnit: 'PER_DAY',
    basePrice: '1000',
    widthFt: null,
    heightFt: null,
    size: null,
    photos: [],
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
    mediaType: null,
  };
  it("verified, unverified, and ADX's own", () => {
    expect(toBrowseCard({ ...base, publisher: { name: 'A', kycStatus: 'VERIFIED' } } as never, null).publisherVerified).toBe(true);
    expect(toBrowseCard({ ...base, publisher: { name: 'B', kycStatus: 'PENDING' } } as never, null).publisherVerified).toBe(false);
    expect(toBrowseCard({ ...base, publisher: { name: 'C', kycStatus: 'REJECTED' } } as never, null).publisherVerified).toBe(false);
    expect(toBrowseCard({ ...base, publisher: null } as never, null).publisherVerified).toBe(true);
  });
});
