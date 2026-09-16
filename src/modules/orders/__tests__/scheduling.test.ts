import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where an agent is sent to collect the material.
 *
 * The meeting point is the address the publisher gave at sign-up. It used to be
 * a required field on the accept endpoint that no screen ever collected, so
 * every publisher acceptance answered 400 and the whole publisher lane was
 * unusable. These are the first tests the orders module has had, which is a
 * large part of why that survived.
 */

const { repository, notifyUser, notifyAdmins } = vi.hoisted(() => ({
  repository: {
    findWithPublisher: vi.fn(),
    update: vi.fn(),
  },
  notifyUser: vi.fn(),
  notifyAdmins: vi.fn(),
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));
vi.mock('../orders.notify', () => ({
  notifyUser,
  notifyAdmins,
  notifyAgent: vi.fn(),
  shortId: (id: string) => id.slice(0, 6),
}));
vi.mock('../../listings', () => ({
  getListingWithPublisher: vi.fn(),
  setListingAvailability: vi.fn(),
}));

import { meetingPointFor, publisherAcceptOrder } from '../scheduling/scheduling.service';

const publisher = (over: Record<string, unknown> = {}) => ({
  id: 'pub_1',
  userId: 'usr_pub',
  address: '14 Residency Road, Bengaluru 560025',
  city: 'Bengaluru',
  state: 'Karnataka',
  ...over,
});

const order = (over: Record<string, unknown> = {}) => ({
  id: 'ord_1',
  status: 'PENDING_PUBLISHER',
  advertiserId: 'usr_adv',
  listing: {
    id: 'lst_1',
    title: 'MG Road Digital Billboard',
    latitude: null,
    longitude: null,
    qrToken: null,
    agentCanInstall: true,
    publisher: publisher(),
  },
  ...over,
});

describe('the meeting point', () => {
  it('is the address the publisher gave at sign-up', () => {
    expect(meetingPointFor(publisher())).toBe('14 Residency Road, Bengaluru 560025');
  });

  /* A publisher who is somewhere else that day can say so, for that booking
     only — it does not change what they signed up with. */
  it('yields to an override for one booking', () => {
    expect(meetingPointFor(publisher(), 'Gate 2, Prestige Warehouse')).toBe(
      'Gate 2, Prestige Warehouse'
    );
  });

  it('ignores an override that is only whitespace', () => {
    expect(meetingPointFor(publisher(), '   ')).toBe('14 Residency Road, Bengaluru 560025');
  });

  /* Every publisher on the platform predates the address field, so city and
     state are what most of them have. Approximate beats nothing to route by. */
  it('falls back to city and state where no address was captured', () => {
    expect(meetingPointFor(publisher({ address: null }))).toBe('Bengaluru, Karnataka');
    expect(meetingPointFor(publisher({ address: null, state: null }))).toBe('Bengaluru');
  });

  it('refuses rather than inventing a place when there is nothing at all', () => {
    expect(() => meetingPointFor(publisher({ address: null, city: null, state: null }))).toThrow(
      'NO_MEETING_PLACE'
    );
    expect(() => meetingPointFor(null)).toThrow('NO_MEETING_PLACE');
  });
});

describe('accepting a booking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.findWithPublisher.mockResolvedValue(order());
    repository.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({
      id,
      ...patch,
    }));
    notifyUser.mockResolvedValue(undefined);
    notifyAdmins.mockResolvedValue(undefined);
  });

  /* The case that was broken: the app sends nothing, because no frame draws a
     field for it. */
  it('succeeds with no meeting place in the request', async () => {
    await publisherAcceptOrder('ord_1', 'usr_pub');

    expect(repository.update).toHaveBeenCalledWith('ord_1', {
      status: 'PENDING_PRINT',
      publisherAcceptedAt: expect.any(Date),
      meetingPlace: '14 Residency Road, Bengaluru 560025',
    });
  });

  it('records an override when one is sent', async () => {
    await publisherAcceptOrder('ord_1', 'usr_pub', 'Gate 2, Prestige Warehouse');
    expect(repository.update.mock.calls[0]![1].meetingPlace).toBe('Gate 2, Prestige Warehouse');
  });

  it('will not accept for somebody else\u2019s order', async () => {
    await expect(publisherAcceptOrder('ord_1', 'usr_someone_else')).rejects.toThrow(
      'NOT_YOUR_ORDER'
    );
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('will not accept an order that is not waiting on the publisher', async () => {
    repository.findWithPublisher.mockResolvedValue(order({ status: 'PENDING_PRINT' }));
    await expect(publisherAcceptOrder('ord_1', 'usr_pub')).rejects.toThrow('WRONG_STATUS');
    expect(repository.update).not.toHaveBeenCalled();
  });

  /* The status must not move when there is nowhere to send anybody. */
  it('leaves the order alone when the publisher has no address at all', async () => {
    repository.findWithPublisher.mockResolvedValue(
      order({
        listing: { ...order().listing, publisher: publisher({ address: null, city: null, state: null }) },
      })
    );
    await expect(publisherAcceptOrder('ord_1', 'usr_pub')).rejects.toThrow('NO_MEETING_PLACE');
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('tells the advertiser and ops that it was accepted', async () => {
    await publisherAcceptOrder('ord_1', 'usr_pub');
    expect(notifyUser).toHaveBeenCalledWith(
      'usr_adv',
      'Order accepted',
      expect.any(String),
      'ord_1'
    );
    expect(notifyAdmins).toHaveBeenCalled();
  });
});
