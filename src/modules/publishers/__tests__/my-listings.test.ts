import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 06 — Publisher · Listings · List (`4428:1741`).
 *
 * The hole this fills: a publisher could not list their own spots at all.
 * `GET /publishers/:publisherId/listings` runs `assertAgentOwnsPublisher`,
 * which resolves the CALLER's agent profile and refuses anyone who is not the
 * onboarding agent — so the publisher themselves got a 403, and so did ADMIN.
 * The only surface they could reach was `/publishers/me/dashboard`, which
 * returns five fields per spot: no rate, no photo, no address, no reason a
 * listing was sent back.
 *
 * The frame's chips are Available / Occupied / Inactive, which are not
 * `ListingStatus` values — occupancy is a live order on the spot. So the facet
 * is the shelf the publisher sees, and the counts label those three chips.
 */

const { repository, rateCards } = vi.hoisted(() => ({
  repository: { findByUserId: vi.fn(), findMyListings: vi.fn() },
  // E11-1: the rate-card badge on every row, as the admin table has it.
  rateCards: { belowFloorFlags: vi.fn(async () => ({})) },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));
vi.mock('../../rate-cards', () => rateCards);

import { getMyListings } from '../my-listings.service';
import { myListingsQuerySchema } from '../publishers.schema';

beforeEach(() => {
  vi.clearAllMocks();
  rateCards.belowFloorFlags.mockResolvedValue({});
  repository.findByUserId.mockResolvedValue({ id: 'pub_1' });
  repository.findMyListings.mockResolvedValue({
    items: [{ id: 'lst_1', title: 'MG Road Billboard', status: 'ACTIVE', occupied: false }],
    total: 4,
    counts: { AVAILABLE: 2, OCCUPIED: 1, INACTIVE: 1 },
  });
});

describe('the publisher listings query', () => {
  it('defaults to every shelf, newest first', () => {
    const parsed = myListingsQuerySchema.parse({});
    expect(parsed.shelf).toBeUndefined();
    expect(parsed.sort).toBe('NEWEST');
    expect(parsed.page).toBe(1);
  });

  it('takes the three chips the frame draws', () => {
    for (const shelf of ['AVAILABLE', 'OCCUPIED', 'INACTIVE']) {
      expect(myListingsQuerySchema.safeParse({ shelf }).success).toBe(true);
    }
    expect(myListingsQuerySchema.safeParse({ shelf: 'ARCHIVED' }).success).toBe(false);
  });

  it('caps the page', () => {
    expect(myListingsQuerySchema.safeParse({ pageSize: '900' }).success).toBe(false);
  });
});

describe('getMyListings', () => {
  it('resolves the publisher from the signed-in user rather than the URL', async () => {
    await getMyListings('usr_1', myListingsQuerySchema.parse({}));
    expect(repository.findByUserId).toHaveBeenCalledWith('usr_1');
    expect(repository.findMyListings).toHaveBeenCalledWith('pub_1', expect.anything());
  });

  it('answers a page with the three chip counts', async () => {
    const page = await getMyListings('usr_1', myListingsQuerySchema.parse({}));
    expect(page.total).toBe(4);
    expect(page.counts).toEqual({ AVAILABLE: 2, OCCUPIED: 1, INACTIVE: 1 });
    expect(page.items[0]).toMatchObject({ title: 'MG Road Billboard', occupied: false });
  });

  /** E11-1: the same chip the admin table draws, so the publisher sees what ops see. */
  it('stamps belowFloor on every row through rate-cards, false where the flags say nothing', async () => {
    repository.findMyListings.mockResolvedValue({
      items: [
        { id: 'lst_1', title: 'MG Road Billboard', status: 'ACTIVE', occupied: false },
        { id: 'lst_2', title: 'Brigade Road Kiosk', status: 'ACTIVE', occupied: true },
        { id: 'lst_3', title: 'Old spot', status: 'INACTIVE', occupied: false },
      ],
      total: 3,
      counts: { AVAILABLE: 1, OCCUPIED: 1, INACTIVE: 1 },
    });
    rateCards.belowFloorFlags.mockResolvedValue({ lst_1: true, lst_2: false });
    const page = await getMyListings('usr_1', myListingsQuerySchema.parse({}));
    expect(rateCards.belowFloorFlags).toHaveBeenCalledWith(['lst_1', 'lst_2', 'lst_3']);
    expect(page.items.map((row) => [row.id, row.belowFloor])).toEqual([
      ['lst_1', true],
      ['lst_2', false],
      ['lst_3', false],
    ]);
    // Nothing else on the row moved.
    expect(page.items[1]).toMatchObject({ title: 'Brigade Road Kiosk', occupied: true });
  });

  it('refuses a signed-in user who has no publisher account', async () => {
    repository.findByUserId.mockResolvedValue(null);
    await expect(getMyListings('usr_nobody', myListingsQuerySchema.parse({}))).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});
