import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G10 (the Lot G verifier's two majors on slots), the campaigns side.
 *
 * `holdReservations` is checkout's reservation write: the 24-hour hold the
 * clash check reads as booked. It runs in one transaction that first takes
 * the same per-listing advisory lock placement takes —
 * `pg_advisory_xact_lock(hashtext(listingId))`, one per distinct listing in
 * a fixed order — then counts the holds again under the lock, each spot's
 * `quantity` against the listing's `slotsTotal`, and writes the hold only
 * when every spot still fits; otherwise it throws `SlotClashError` naming
 * the listings and nothing is written. `clashingListingIds` answers the same
 * arithmetic without a lock for the review screen and the matcher: a spot
 * of quantity three clashes when fewer than three are left.
 */

const { prisma, tx } = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    campaign: { findUnique: vi.fn() },
    campaignSpot: { findMany: vi.fn(), updateMany: vi.fn() },
    // BD-1: the third hold the count reads.
    listingBlockedDate: { findMany: vi.fn(async () => []) },
    order: { findMany: vi.fn() },
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
      listing: { findMany: vi.fn() },
      order: { findMany: vi.fn() },
      campaignSpot: { findMany: vi.fn() },
      listingBlockedDate: { findMany: vi.fn(async () => []) },
    },
  };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { SlotClashError } from '../campaigns.repository';
import { prismaCampaignsRepository as repository } from '../prisma-campaigns.repository';

const from = new Date('2026-04-01T00:00:00Z');
const to = new Date('2026-04-14T00:00:00Z');
const until = new Date('2026-03-21T10:00:00Z');

let ownSpots: unknown[] = [];
let otherReservations: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  tx.$executeRaw.mockResolvedValue(1);
  tx.campaign.findUnique.mockResolvedValue({ startDate: from, endDate: to });
  ownSpots = [
    { id: 'spt_1', listingId: 'lst_b', quantity: 3, startDate: null, endDate: null, listing: { slotsTotal: 6 } },
    { id: 'spt_2', listingId: 'lst_a', quantity: 1, startDate: null, endDate: null, listing: { slotsTotal: 1 } },
  ];
  otherReservations = [{ listingId: 'lst_b', quantity: 1, startDate: null, endDate: null }];
  // AV-1: the same table answers two reads — the campaign's own spots (their select carries `id`) and the count's live reservations.
  tx.campaignSpot.findMany.mockImplementation(async (args: { select?: { id?: boolean } }) => (args?.select?.id ? ownSpots : otherReservations));
  tx.order.findMany.mockResolvedValue([{ listingId: 'lst_b', campaignSpot: { quantity: 2 } }]);
  tx.campaignSpot.updateMany.mockResolvedValue({ count: 2 });
});

describe('holdReservations', () => {
  it('locks every listing of the campaign first, in id order, then counts under the lock and writes the hold', async () => {
    await expect(repository.holdReservations('cmp_1', until)).resolves.toBe(2);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // One lock per distinct listing, sorted, before anything else on the transaction.
    const locks = tx.$executeRaw.mock.calls.map(([strings, ...values]) => ({ sql: strings.join('?'), values }));
    expect(locks).toEqual([
      { sql: expect.stringMatching(/pg_advisory_xact_lock\(hashtext\(\?\)\)/), values: ['lst_a'] },
      { sql: expect.stringMatching(/pg_advisory_xact_lock\(hashtext\(\?\)\)/), values: ['lst_b'] },
    ]);
    const firstLock = tx.$executeRaw.mock.invocationCallOrder[0]!;
    expect(tx.campaignSpot.findMany.mock.invocationCallOrder[0]!).toBeLessThan(firstLock);
    expect(tx.order.findMany.mock.invocationCallOrder[0]!).toBeGreaterThan(tx.$executeRaw.mock.invocationCallOrder[1]!);
    expect(tx.campaignSpot.updateMany.mock.invocationCallOrder[0]!).toBeGreaterThan(tx.order.findMany.mock.invocationCallOrder[0]!);

    // The count leaves this campaign's own reservations out, over the campaign's flight.
    const countCall = tx.campaignSpot.findMany.mock.calls.find(([args]) => !(args as { select?: { id?: boolean } }).select?.id)!;
    expect((countCall[0] as { where: unknown }).where).toMatchObject({ campaignId: { not: 'cmp_1' } });
    expect(tx.campaignSpot.updateMany).toHaveBeenCalledWith({ where: { campaignId: 'cmp_1', status: 'RESERVED' }, data: { reservedUntil: until } });
  });

  it('refuses with SlotClashError, writing nothing, when a spot no longer fits — quantity against slotsTotal', async () => {
    // lst_b: 6 slots, 2 + 1 held, spot wants 3 → fits (6). Make it 4 held: 4 + 3 > 6.
    tx.order.findMany.mockResolvedValue([{ listingId: 'lst_b', campaignSpot: { quantity: 3 } }]);
    await expect(repository.holdReservations('cmp_1', until)).rejects.toBeInstanceOf(SlotClashError);
    await expect(repository.holdReservations('cmp_1', until)).rejects.toMatchObject({ listingIds: ['lst_b'] });
    expect(tx.campaignSpot.updateMany).not.toHaveBeenCalled();
  });

  it('holds nothing, and locks nothing, for a campaign with no reserved spot', async () => {
    ownSpots = [];
    await expect(repository.holdReservations('cmp_1', until)).resolves.toBe(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.campaignSpot.updateMany).not.toHaveBeenCalled();
  });
});

describe('clashingListingIds', () => {
  beforeEach(() => {
    prisma.listing.findMany.mockResolvedValue([
      { id: 'lst_a', slotsTotal: 1 },
      { id: 'lst_b', slotsTotal: 6 },
    ]);
    prisma.order.findMany.mockResolvedValue([{ listingId: 'lst_b', campaignSpot: { quantity: 4 } }]);
    prisma.campaignSpot.findMany.mockResolvedValue([]);
  });

  it('answers by quantity: three wanted on a loop with two left clashes, one wanted does not', async () => {
    await expect(repository.clashingListingIds([{ listingId: 'lst_b', quantity: 3 }], from, to)).resolves.toEqual(['lst_b']);
    await expect(repository.clashingListingIds([{ listingId: 'lst_b', quantity: 2 }], from, to)).resolves.toEqual([]);
    // A bare id asks for one slot, the way the matcher asks.
    await expect(repository.clashingListingIds(['lst_a', 'lst_b'], from, to)).resolves.toEqual([]);
  });
});
