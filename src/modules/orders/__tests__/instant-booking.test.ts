import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot D (Q6/Q105) — instant booking at placement.
 *
 * What is pinned: a spot the publisher opted in, with the flag on, is
 * accepted for them the moment it is placed — PENDING_PRINT, both accept
 * stamps at the same instant, no publisher timer, the meeting place off the
 * publisher's record — and the same three parties hear about it as after a
 * manual accept. With the flag off, or with nowhere to send the agent, the
 * order waits for the publisher exactly as before. Who installs is still
 * asked afterwards: nothing here writes `installBy`.
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

const listing = (over: Record<string, unknown> = {}) => ({
  id: 'lst_1',
  title: 'MG Road hoarding',
  status: 'ACTIVE',
  availableNow: true,
  instantBooking: true,
  publisherId: 'pub_1',
  publisher: { id: 'pub_1', userId: 'usr_pub', agentId: null, address: '12 Hill Road', city: 'Mumbai', state: 'MH' },
  ...over,
});

const order = { advertiserId: 'usr_adv', listingId: 'lst_1', campaignName: 'Monsoon' };

beforeEach(() => {
  vi.clearAllMocks();
  listings.getListingWithPublisher.mockResolvedValue(listing());
  // Lot G: a static wall with its one slot free. G10: the count and the
  // insert run under the listing lock — the fake hands the service both.
  repository.slotsHeld.mockResolvedValue(0);
  repository.placeUnderListingLock.mockImplementation(async (_listingId: string, run: (locked: unknown) => Promise<unknown>) =>
    run({ slotsHeld: repository.slotsHeld, create: repository.create }),
  );
  flags.isFeatureEnabled.mockResolvedValue(true);
  repository.create.mockImplementation(async (data: unknown, accepted?: unknown) => ({ id: 'ord_000001', ...(data as object), accepted }));
  notify.notifyUser.mockResolvedValue(undefined);
  notify.notifyAdmins.mockResolvedValue(undefined);
});

describe('an instant spot', () => {
  it('is accepted for the publisher at placement, with the meeting place off their record', async () => {
    const placed = await placeOrder(order);
    expect(flags.isFeatureEnabled).toHaveBeenCalledWith('instant-booking', 'pub_1');
    expect(repository.create).toHaveBeenCalledTimes(1);
    const [, accepted] = repository.create.mock.calls[0]!;
    expect(accepted).toMatchObject({ meetingPlace: '12 Hill Road' });
    expect(accepted.at).toBeInstanceOf(Date);
    expect(placed.id).toBe('ord_000001');
  });

  it('tells the publisher, the advertiser and ops — the accept fan-out, plus the publisher who did not tap', async () => {
    await placeOrder(order);
    await new Promise((resolve) => setImmediate(resolve));
    const titles = notify.notifyUser.mock.calls.map((call) => [call[0], call[1]]);
    expect(titles).toContainEqual(['usr_pub', 'Booking accepted for you']);
    expect(titles).toContainEqual(['usr_adv', 'Order accepted']);
    expect(notify.notifyAdmins).toHaveBeenCalledWith('Order ready for print', expect.stringContaining('000001'), 'ord_000001');
    // Not the "new order request" a manual spot sends: there is nothing to answer.
    expect(titles).not.toContainEqual(['usr_pub', 'New order request']);
  });

  it('falls back to the city and state when there is no street address', async () => {
    listings.getListingWithPublisher.mockResolvedValue(listing({ publisher: { id: 'pub_1', userId: 'usr_pub', agentId: null, address: null, city: 'Mumbai', state: 'MH' } }));
    await placeOrder(order);
    expect(repository.create.mock.calls[0]![1]).toMatchObject({ meetingPlace: 'Mumbai, MH' });
  });
});

describe('the ordinary path', () => {
  it('waits for the publisher when the spot is not instant', async () => {
    listings.getListingWithPublisher.mockResolvedValue(listing({ instantBooking: false }));
    await placeOrder(order);
    expect(flags.isFeatureEnabled).not.toHaveBeenCalled();
    expect(repository.create.mock.calls[0]![1]).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(notify.notifyUser).toHaveBeenCalledWith('usr_pub', 'New order request', expect.any(String), 'ord_000001');
  });

  it('waits for the publisher when ops have the flag off, whatever the spot says', async () => {
    flags.isFeatureEnabled.mockResolvedValue(false);
    await placeOrder(order);
    expect(repository.create.mock.calls[0]![1]).toBeUndefined();
  });

  it('waits for the publisher when there is nowhere to send the agent', async () => {
    listings.getListingWithPublisher.mockResolvedValue(listing({ publisher: { id: 'pub_1', userId: 'usr_pub', agentId: null, address: null, city: null, state: null } }));
    await placeOrder(order);
    expect(repository.create.mock.calls[0]![1]).toBeUndefined();
  });
});
