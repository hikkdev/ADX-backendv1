import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The media repository's two reads for ad artwork (28 Sep 2026).
 *
 * `list` cuts by owner: `adx` is a picture with no advertiser, `advertisers`
 * one with any, `all` leaves the column alone, and a named advertiser is
 * narrower than all three. `openAdBookings` reads `AdBooking` — a table
 * `promotions` owns — narrowly, by artwork id, for the bookings that are
 * not ENDED / REJECTED / CANCELLED, so `media` never imports `promotions`.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    mediaAsset: { findMany: vi.fn() },
    adBooking: { findMany: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaMediaRepository as repository } from '../prisma-media.repository';

const whereOf = () => {
  const calls = prisma.mediaAsset.findMany.mock.calls;
  return calls[calls.length - 1]![0].where as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.mediaAsset.findMany.mockResolvedValue([]);
  prisma.adBooking.findMany.mockResolvedValue([]);
});

describe('list, by owner', () => {
  it("adx is ADX's own pictures — no advertiser", async () => {
    await repository.list({ owner: 'adx', limit: 200 });
    expect(whereOf()).toEqual({ archivedAt: null, ownerAdvertiserId: null });
  });

  it("advertisers is the ad artwork — any advertiser", async () => {
    await repository.list({ owner: 'advertisers', archived: true, limit: 200 });
    expect(whereOf()).toEqual({ archivedAt: { not: null }, ownerAdvertiserId: { not: null } });
  });

  it('all, or no owner, leaves the column alone', async () => {
    await repository.list({ owner: 'all', limit: 200 });
    expect(whereOf()).not.toHaveProperty('ownerAdvertiserId');
    await repository.list({ limit: 200 });
    expect(whereOf()).not.toHaveProperty('ownerAdvertiserId');
  });

  it('a named advertiser is narrower than the owner and wins', async () => {
    await repository.list({ owner: 'adx', ownerAdvertiserId: 'adv_1', limit: 200 });
    expect(whereOf()).toMatchObject({ ownerAdvertiserId: 'adv_1' });
  });

  it('keeps the other filters beside it, newest first', async () => {
    await repository.list({ owner: 'adx', tag: 'festive', specs: ['TILE'], limit: 20 });
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith({
      where: { archivedAt: null, tags: { has: 'festive' }, spec: { in: ['TILE'] }, ownerAdvertiserId: null },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  });
});

describe('openAdBookings', () => {
  it('reads the bookings that name the artwork and are not ENDED, REJECTED or CANCELLED — three columns', async () => {
    prisma.adBooking.findMany.mockResolvedValue([{ id: 'adb_1', displayId: 'ADB-2809-2601', status: 'SCHEDULED' }]);
    await expect(repository.openAdBookings('med_ad')).resolves.toEqual([{ id: 'adb_1', displayId: 'ADB-2809-2601', status: 'SCHEDULED' }]);
    expect(prisma.adBooking.findMany).toHaveBeenCalledWith({
      where: { mediaId: 'med_ad', status: { notIn: ['ENDED', 'REJECTED', 'CANCELLED'] } },
      select: { id: true, displayId: true, status: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
  });
});
