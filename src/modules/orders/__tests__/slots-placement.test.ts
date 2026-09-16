import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot G (Q116/136) — slots at placement; G10 — the count and the insert
 * are one act.
 *
 * What is pinned: an order is refused with LISTING_NOT_AVAILABLE only when
 * the listing has no slot left over the order's own flight (today, when it
 * has none) — a six-slot screen with five orders on it takes a sixth; the
 * count and the insert run inside `placeUnderListingLock`, the repository's
 * per-listing advisory lock, so two placements racing for the last slot are
 * serialised and the second reads the first's insert (the Lot G verifier's
 * first major); a placement of `quantity` slots is refused when fewer are
 * left (its second); the campaign the order is raised for is left out of
 * the count, so a campaign's own reservation never blocks its own order; a
 * loop whose `availableNow` flag is off but which the count says has room
 * is freed and booked; a static wall with its flag off still goes through
 * the old finished-campaign check.
 */

const { repository, notify, listings, flags } = vi.hoisted(() => ({
  repository: { create: vi.fn(), slotsHeld: vi.fn(), placeUnderListingLock: vi.fn(), findCompletedExpiredForListing: vi.fn() },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (id: string) => id.slice(-6).toUpperCase() },
  listings: { getListingWithPublisher: vi.fn(), setListingAvailability: vi.fn() },
  flags: { isFeatureEnabled: vi.fn() },
}));

/** G10: the kill switches on the routers pass in these tests; the flag itself is pinned through isFeatureEnabled. */
const passThroughFeatureGates = vi.hoisted(() => () => ({
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', async (importOriginal) => {
  // The window arithmetic is pure and stays real; the reads are the fakes above.
  const actual = await importOriginal<typeof import('../../listings')>();
  return { ...listings, windowFor: actual.windowFor };
});
vi.mock('../../feature-flags', () => ({ ...flags, ...passThroughFeatureGates() }));

import { placeOrder } from '../placement/placement.service';
import type { PlacementLock } from '../orders.repository';

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'MG Road digital screen',
  status: 'ACTIVE',
  availableNow: true,
  instantBooking: false,
  slotsTotal: 6,
  publisherId: 'pub_1',
  publisher: { id: 'pub_1', userId: 'usr_pub', agentId: null, address: '12 Hill Road', city: 'Mumbai', state: 'MH' },
  ...over,
});

const from = new Date('2026-10-01T00:00:00Z');
const to = new Date('2026-10-14T00:00:00Z');
const order = { advertiserId: 'usr_adv', listingId: 'lst_1', campaignName: 'Monsoon', startDate: from, endDate: to };

/** The fake lock: hands the service the count and the insert, both "under the lock". */
function lockPassesThrough() {
  repository.placeUnderListingLock.mockImplementation(async (_listingId: string, run: (locked: PlacementLock) => Promise<unknown>) =>
    run({ slotsHeld: repository.slotsHeld, create: repository.create }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listings.getListingWithPublisher.mockResolvedValue(listing());
  listings.setListingAvailability.mockResolvedValue(undefined);
  flags.isFeatureEnabled.mockResolvedValue(false);
  repository.slotsHeld.mockResolvedValue(0);
  lockPassesThrough();
  repository.create.mockImplementation(async (data: unknown) => ({ id: 'ord_000001', ...(data as object) }));
  repository.findCompletedExpiredForListing.mockResolvedValue(null);
  notify.notifyUser.mockResolvedValue(undefined);
});

describe('placing against a loop', () => {
  it('counts the slots held over the flight under the listing lock and books when one is left', async () => {
    repository.slotsHeld.mockResolvedValue(5);
    const placed = await placeOrder(order);
    expect(repository.placeUnderListingLock).toHaveBeenCalledWith('lst_1', expect.any(Function));
    expect(repository.slotsHeld).toHaveBeenCalledWith({ from, to }, {});
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(placed.id).toBe('ord_000001');
  });

  it('refuses when no slot is left, before anything is written', async () => {
    repository.slotsHeld.mockResolvedValue(6);
    await expect(placeOrder(order)).rejects.toThrow('LISTING_NOT_AVAILABLE');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('G10: a placement of several slots is refused when fewer are left, and takes them when they are', async () => {
    repository.slotsHeld.mockResolvedValue(4);
    await expect(placeOrder({ ...order, quantity: 3 })).rejects.toThrow('LISTING_NOT_AVAILABLE');
    expect(repository.create).not.toHaveBeenCalled();

    await placeOrder({ ...order, quantity: 2 });
    expect(repository.create).toHaveBeenCalledTimes(1);
    // The quantity is the campaign spot's, never a column on the order.
    expect(repository.create.mock.calls[0]![0]).not.toHaveProperty('quantity');
  });

  it('leaves the campaign the order is raised for out of the count', async () => {
    await placeOrder({ ...order, forCampaignId: 'cmp_9' });
    expect(repository.slotsHeld).toHaveBeenCalledWith({ from, to }, { excludeCampaignId: 'cmp_9' });
    // The hint never reaches the row.
    const [data] = repository.create.mock.calls[0]!;
    expect(data).not.toHaveProperty('forCampaignId');
  });

  it('asks over today when the order has no dates', async () => {
    const { startDate: _s, endDate: _e, ...undated } = order;
    await placeOrder(undated);
    const [window] = repository.slotsHeld.mock.calls[0]!;
    expect(window.from.toISOString()).toMatch(/T00:00:00\.000Z$/);
    expect(window.to.getTime() - window.from.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('frees a loop whose flag is off when the count says there is room', async () => {
    listings.getListingWithPublisher.mockResolvedValue(listing({ availableNow: false }));
    await placeOrder(order);
    expect(listings.setListingAvailability).toHaveBeenCalledWith('lst_1', true);
    expect(repository.findCompletedExpiredForListing).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledTimes(1);
  });
});

describe('two placements racing for the last slot (G10)', () => {
  it('are serialised by the listing lock: the second reads the first insert and is refused', async () => {
    listings.getListingWithPublisher.mockResolvedValue(listing({ slotsTotal: 1 }));

    // A fake repository whose count answers "one left" to anyone who asks
    // outside the lock — and, inside it, reflects what the lock has admitted.
    let inserted = 0;
    let chain: Promise<unknown> = Promise.resolve();
    const entered: string[] = [];
    repository.placeUnderListingLock.mockImplementation((listingId: string, run: (locked: PlacementLock) => Promise<unknown>) => {
      const turn = chain.then(async () => {
        entered.push(listingId);
        return run({
          slotsHeld: async () => inserted,
          create: async (data) => {
            inserted += 1;
            return { id: `ord_${inserted}`, ...data } as never;
          },
        });
      });
      chain = turn.catch(() => undefined);
      return turn;
    });

    const [first, second] = await Promise.allSettled([placeOrder(order), placeOrder({ ...order, advertiserId: 'usr_other' })]);
    expect(first).toMatchObject({ status: 'fulfilled', value: { id: 'ord_1' } });
    expect(second).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'LISTING_NOT_AVAILABLE' }) });
    expect(inserted).toBe(1);
    // Both went through the lock path, one after the other.
    expect(entered).toEqual(['lst_1', 'lst_1']);
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe('placing against a static wall', () => {
  it('reads 1 slot, and is refused when it is held', async () => {
    listings.getListingWithPublisher.mockResolvedValue(listing({ slotsTotal: 1 }));
    repository.slotsHeld.mockResolvedValue(1);
    await expect(placeOrder(order)).rejects.toThrow('LISTING_NOT_AVAILABLE');
    expect(repository.slotsHeld).toHaveBeenCalledWith({ from, to }, {});
  });

  it('with its flag off still asks the old question — a finished campaign frees it, nothing else does', async () => {
    listings.getListingWithPublisher.mockResolvedValue(listing({ slotsTotal: 1, availableNow: false }));
    await expect(placeOrder(order)).rejects.toThrow('LISTING_NOT_AVAILABLE');
    repository.findCompletedExpiredForListing.mockResolvedValue({ id: 'ord_old' });
    await placeOrder(order);
    expect(listings.setListingAvailability).toHaveBeenCalledWith('lst_1', true);
  });
});
