import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G10 (the Lot G verifier's first major on slots): the slot count and the
 * order insert are one act. The repository runs both inside one Prisma
 * transaction whose FIRST statement takes a per-listing advisory lock —
 * `pg_advisory_xact_lock(hashtext(listingId))` — released with the
 * transaction, so two placements on the same listing queue at the lock and
 * the second counts the first's row. The campaigns repository takes the same
 * lock, on the same key, around its reservation write. These cases drive the
 * repository against a fake transaction client so the order of statements is
 * the thing under test; the real lock is exercised by the verifier's
 * read-only probe.
 */

const { prisma, tx } = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    order: { findMany: vi.fn(), create: vi.fn() },
    campaignSpot: { groupBy: vi.fn() },
  };
  return { tx, prisma: { $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) } };
});

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaOrdersRepository as repository } from '../prisma-orders.repository';

const window = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-14T00:00:00Z') };
const calls = () => [...tx.$executeRaw.mock.invocationCallOrder, ...tx.order.findMany.mock.invocationCallOrder, ...tx.order.create.mock.invocationCallOrder];

beforeEach(() => {
  vi.clearAllMocks();
  tx.$executeRaw.mockResolvedValue(1);
  tx.order.findMany.mockResolvedValue([{ listingId: 'lst_1', campaignSpot: { quantity: 2 } }]);
  tx.campaignSpot.groupBy.mockResolvedValue([{ listingId: 'lst_1', _sum: { quantity: 1 } }]);
  tx.order.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'ord_1', ...data }));
});

describe('placeUnderListingLock', () => {
  it('takes pg_advisory_xact_lock(hashtext(listingId)) as the first statement of the transaction, then counts and inserts on it', async () => {
    const placed = await repository.placeUnderListingLock('lst_1', async (locked) => {
      const held = await locked.slotsHeld(window, { excludeCampaignId: 'cmp_9' });
      expect(held).toBe(3);
      return locked.create({ advertiserId: 'usr_adv', listingId: 'lst_1', startDate: window.from, endDate: window.to });
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    // A tagged template: the SQL text names the lock and the listing id rides as a parameter.
    const [strings, ...values] = tx.$executeRaw.mock.calls[0]!;
    expect(strings.join('?')).toMatch(/SELECT pg_advisory_xact_lock\(hashtext\(\?\)\)/);
    expect(values).toEqual(['lst_1']);
    // Lock first, then the count, then the insert — all on the transaction client.
    const [lockAt] = tx.$executeRaw.mock.invocationCallOrder;
    expect(Math.min(...calls())).toBe(lockAt);
    expect(tx.order.findMany.mock.invocationCallOrder[0]!).toBeLessThan(tx.order.create.mock.invocationCallOrder[0]!);
    expect(tx.order.findMany.mock.calls[0]![0].where.listingId).toEqual({ in: ['lst_1'] });
    expect(tx.campaignSpot.groupBy.mock.calls[0]![0].where).toMatchObject({ campaignId: { not: 'cmp_9' } });
    expect(placed).toMatchObject({ id: 'ord_1', status: 'PENDING_PUBLISHER', listingId: 'lst_1' });
  });

  it('writes the instant-acceptance stamps through the locked insert the way create does', async () => {
    const at = new Date('2026-09-14T10:00:00Z');
    await repository.placeUnderListingLock('lst_1', (locked) => locked.create({ advertiserId: 'usr_adv', listingId: 'lst_1' }, { at, meetingPlace: 'Mumbai, MH' }));
    expect(tx.order.create.mock.calls[0]![0].data).toMatchObject({ status: 'PENDING_PRINT', publisherAcceptedAt: at, autoAcceptedAt: at, meetingPlace: 'Mumbai, MH', publisherTimerExpiry: null });
  });

  it('lets a refusal inside the callback roll the transaction back — nothing is inserted', async () => {
    await expect(
      repository.placeUnderListingLock('lst_1', async () => {
        throw new Error('LISTING_NOT_AVAILABLE');
      }),
    ).rejects.toThrow('LISTING_NOT_AVAILABLE');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.order.create).not.toHaveBeenCalled();
  });
});
