import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 01's publisher home — the greeting, the gauge, the map.
 *
 * What is pinned: occupancy counts only live spots and only bookings whose
 * flight covers now, and has no value at all while nothing is live; the
 * greeting follows the Indian clock; a user with no publisher record is
 * told to register.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findByUserId: vi.fn(), findDashboard: vi.fn() },
}));

vi.mock('../prisma-publishers.repository', () => ({ prismaPublishersRepository: repository }));

import { getMyDashboard, greetingFor, occupancyOf } from '../dashboard.service';

const spot = (id: string, status: string, occupied: boolean) => ({ id, title: id, status, latitude: 12.9, longitude: 77.6, occupied, booking: null });

beforeEach(() => {
  vi.clearAllMocks();
  repository.findByUserId.mockResolvedValue({ id: 'pub_1', name: 'Ravi' });
  repository.findDashboard.mockResolvedValue({
    listings: [spot('a', 'ACTIVE', true), spot('b', 'ACTIVE', false), spot('c', 'ACTIVE', true), spot('d', 'DRAFT', false)],
    awaiting: 2,
  });
});

describe('occupancy', () => {
  it('is the share of live spots a booking covers today; a draft does not count either way', () => {
    expect(occupancyOf([spot('a', 'ACTIVE', true), spot('b', 'ACTIVE', false), spot('c', 'ACTIVE', true), spot('d', 'DRAFT', true)])).toEqual({ rate: 67, occupied: 2, live: 3 });
  });

  it('has no value while nothing is live, rather than printing zero', () => {
    expect(occupancyOf([spot('d', 'DRAFT', false), spot('e', 'PENDING_REVIEW', false)])).toEqual({ rate: null, occupied: 0, live: 0 });
  });
});

describe('the greeting', () => {
  it('follows the Indian clock', () => {
    expect(greetingFor(new Date('2026-09-10T03:30:00.000Z'))).toBe('Good morning'); // 09:00 IST
    expect(greetingFor(new Date('2026-09-10T08:30:00.000Z'))).toBe('Good afternoon'); // 14:00 IST
    expect(greetingFor(new Date('2026-09-10T14:30:00.000Z'))).toBe('Good evening'); // 20:00 IST
  });
});

describe('the home', () => {
  it('is computed for the publisher behind the login, for now', async () => {
    const now = new Date('2026-09-10T03:30:00.000Z');
    const home = await getMyDashboard('usr_1', now);
    expect(repository.findDashboard).toHaveBeenCalledWith('pub_1', now);
    expect(home).toMatchObject({ name: 'Ravi', greeting: 'Good morning', occupancy: { rate: 67, occupied: 2, live: 3 }, awaiting: 2 });
    expect(home.listings).toHaveLength(4);
  });

  it('is refused without a publisher record', async () => {
    repository.findByUserId.mockResolvedValue(null);
    await expect(getMyDashboard('usr_x')).rejects.toMatchObject({ statusCode: 404 });
  });
});
