import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Order fraud screening (2 Oct 2026) — "when it runs", on the order's side.
 *
 * Pinned: placing an order tells the screening port, in the background;
 * the money behind orders being taken tells it again; and the screening
 * never throws into the order flow — a port that fails (or is not there)
 * costs a log line, the order stands.
 */

const { repository, notify, listings, flags, identifiers } = vi.hoisted(() => ({
  repository: { create: vi.fn(), slotsHeld: vi.fn(), placeUnderListingLock: vi.fn(), findCompletedExpiredForListing: vi.fn() },
  notify: { notifyUser: vi.fn(), notifyAdmins: vi.fn(), notifyAgent: vi.fn(), shortId: (id: string) => id.slice(-6).toUpperCase() },
  listings: { getListingWithPublisher: vi.fn(), setListingAvailability: vi.fn() },
  flags: { isFeatureEnabled: vi.fn(async () => false) },
  identifiers: { allocateIdentifier: vi.fn(async () => 'BKG-0210-2601') },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => notify);
vi.mock('../../listings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../listings')>();
  return { ...listings, windowFor: actual.windowFor };
});
vi.mock('../../feature-flags', () => ({
  ...flags,
  requireFeature: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireFeatureWhen: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../identifiers', () => identifiers);

import { placeOrder } from '../placement/placement.service';
import { announceOrdersPaid, registerOrderScreeningPort, resetOrderScreeningPort } from '../screening.port';
import type { PlacementLock } from '../orders.repository';

const port = { orderPlaced: vi.fn(), ordersPaid: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  registerOrderScreeningPort(port);
  port.orderPlaced.mockResolvedValue(undefined);
  port.ordersPaid.mockResolvedValue(undefined);
  listings.getListingWithPublisher.mockResolvedValue({
    id: 'lst_1',
    title: 'MG Road screen',
    status: 'ACTIVE',
    availableNow: true,
    instantBooking: false,
    slotsTotal: 1,
    publisherId: 'pub_1',
    publisher: { id: 'pub_1', userId: 'usr_pub', agentId: null, address: 'x', city: 'Mumbai', state: 'MH' },
  });
  repository.slotsHeld.mockResolvedValue(0);
  repository.create.mockResolvedValue({ id: 'ord_new', status: 'PENDING_PUBLISHER' });
  repository.placeUnderListingLock.mockImplementation(async (_id: string, run: (locked: PlacementLock) => Promise<unknown>) => run({ slotsHeld: repository.slotsHeld, create: repository.create }));
  notify.notifyUser.mockResolvedValue(undefined);
});

afterEach(() => resetOrderScreeningPort());

describe('the screening port', () => {
  it('is told of every order placed, in the background', async () => {
    const order = await placeOrder({ advertiserId: 'usr_adv', listingId: 'lst_1' });
    expect(order).toMatchObject({ id: 'ord_new' });
    await vi.waitFor(() => expect(port.orderPlaced).toHaveBeenCalledWith('ord_new'));
  });

  it('leaves an order raised for a campaign to the paid announcement, which follows with the spot linked', async () => {
    await placeOrder({ advertiserId: 'usr_adv', listingId: 'lst_1', forCampaignId: 'cmp_1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(port.orderPlaced).not.toHaveBeenCalled();
  });

  it('never fails the placement when the screening fails', async () => {
    port.orderPlaced.mockRejectedValue(new Error('scoring blew up'));
    await expect(placeOrder({ advertiserId: 'usr_adv', listingId: 'lst_1' })).resolves.toMatchObject({ id: 'ord_new' });
    await vi.waitFor(() => expect(port.orderPlaced).toHaveBeenCalled());
  });

  it('is told when the money behind orders is taken — distinct ids, blanks dropped, a failure swallowed', async () => {
    port.ordersPaid.mockRejectedValue(new Error('down'));
    expect(() => announceOrdersPaid(['ord_1', null, 'ord_2', 'ord_1', undefined])).not.toThrow();
    await vi.waitFor(() => expect(port.ordersPaid).toHaveBeenCalledWith(['ord_1', 'ord_2']));
    announceOrdersPaid([null]);
    expect(port.ordersPaid).toHaveBeenCalledTimes(1);
  });

  it('unregistered, placement goes on as before', async () => {
    resetOrderScreeningPort();
    await expect(placeOrder({ advertiserId: 'usr_adv', listingId: 'lst_1' })).resolves.toMatchObject({ id: 'ord_new' });
    expect(port.orderPlaced).not.toHaveBeenCalled();
  });
});
