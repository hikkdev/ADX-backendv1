import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G10 (the Lot G verifier's second major on slots): a campaign spot's
 * quantity is priced per slot, so it must hold that many slots. The count
 * behind browse's `slotsLeft`, checkout's clash check and placement's refusal
 * is one function over any Prisma client — the repository's own or a
 * transaction holding the listing's lock — and it sums quantities: the
 * campaign spot behind each running order (one when there is none) and the
 * live reservations' `quantity`.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    order: { findMany: vi.fn() },
    campaignSpot: { groupBy: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaListingsRepository as repository, slotsHeldWith } from '../prisma-listings.repository';

const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-14T00:00:00Z') };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.order.findMany.mockResolvedValue([
    { listingId: 'lst_1', campaignSpot: { quantity: 3 } },
    { listingId: 'lst_1', campaignSpot: null },
  ]);
  prisma.campaignSpot.groupBy.mockResolvedValue([{ listingId: 'lst_1', _sum: { quantity: 2 } }]);
});

describe('slotsHeld', () => {
  it('sums the quantities behind the running orders and the live reservations', async () => {
    const held = await repository.slotsHeld(['lst_1', 'lst_2'], window, { excludeCampaignId: 'cmp_9' });
    expect(held.get('lst_1')).toBe(6);
    expect(held.has('lst_2')).toBe(false);

    const [orderArgs] = prisma.order.findMany.mock.calls[0]!;
    expect(orderArgs.where.listingId).toEqual({ in: ['lst_1', 'lst_2'] });
    expect(orderArgs.select).toEqual({ listingId: true, campaignSpot: { select: { quantity: true } } });
    const [spotArgs] = prisma.campaignSpot.groupBy.mock.calls[0]!;
    expect(spotArgs.by).toEqual(['listingId']);
    expect(spotArgs._sum).toEqual({ quantity: true });
    expect(spotArgs.where).toMatchObject({ listingId: { in: ['lst_1', 'lst_2'] }, status: 'RESERVED', campaignId: { not: 'cmp_9' } });
  });

  it('runs on whatever client it is handed — a transaction holding the listing lock counts the same way', async () => {
    const tx = {
      order: { findMany: vi.fn(async () => [{ listingId: 'lst_1', campaignSpot: { quantity: 5 } }]) },
      campaignSpot: { groupBy: vi.fn(async () => []) },
    };
    const held = await slotsHeldWith(tx as never, ['lst_1'], window);
    expect(held.get('lst_1')).toBe(5);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('answers an empty map for no listings without a query', async () => {
    expect((await repository.slotsHeld([], window)).size).toBe(0);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });
});
