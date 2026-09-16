import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hourly city wind-down job — Lot V.
 *
 * Pinned: the tick heartbeats, takes the tick lock, acts as the system
 * user (an admin when there is none), hands the work to geo's
 * `runCityWindDown`, releases the lock, and logs rather than throws when
 * the sweep fails. No day key: a city withdrawn at noon is down by one.
 */

const { redis, jobs, geo, users, logging } = vi.hoisted(() => ({
  redis: { redis: { set: vi.fn(), del: vi.fn() } },
  jobs: { recordHeartbeat: vi.fn() },
  geo: { runCityWindDown: vi.fn() },
  users: { systemUserId: vi.fn(), listAdminUserIds: vi.fn() },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/jobs', () => jobs);
vi.mock('../../../shared/logging', () => logging);
vi.mock('../../../shared/errors', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('../../geo', () => geo);
vi.mock('../../users', () => users);

import { cityWindDownTick } from '../../../jobs/city-winddown.job';

const NOW = new Date('2026-09-15T12:30:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  redis.redis.set.mockResolvedValue('OK');
  redis.redis.del.mockResolvedValue(1);
  users.systemUserId.mockResolvedValue('sys_1');
  users.listAdminUserIds.mockResolvedValue(['admin_1']);
  geo.runCityWindDown.mockResolvedValue([{ city: 'bengaluru', listingsUnpublished: 3, listingsFailed: 0, publishersTold: 2, leadsClosed: 1, agentsTold: 2 }]);
});

describe('the city wind-down tick', () => {
  it('heartbeats, locks, runs the wind-down as the system user, logs the cities and releases the lock', async () => {
    await cityWindDownTick(NOW);
    expect(jobs.recordHeartbeat).toHaveBeenCalledWith('city-winddown', NOW);
    expect(redis.redis.set).toHaveBeenCalledWith('lock:city-winddown-tick', '1', 'PX', 50 * 60 * 1000, 'NX');
    expect(geo.runCityWindDown).toHaveBeenCalledWith('sys_1', NOW);
    expect(logging.logger.info).toHaveBeenCalledWith('Cities wound down', expect.objectContaining({ cities: [expect.objectContaining({ city: 'bengaluru' })] }));
    expect(redis.redis.del).toHaveBeenCalledWith('lock:city-winddown-tick');
  });

  it('does nothing when another instance holds the lock', async () => {
    redis.redis.set.mockResolvedValueOnce(null);
    await cityWindDownTick(NOW);
    expect(geo.runCityWindDown).not.toHaveBeenCalled();
    expect(jobs.recordHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('falls back to an admin when there is no system user, and skips when there is neither', async () => {
    users.systemUserId.mockResolvedValue(null);
    await cityWindDownTick(NOW);
    expect(geo.runCityWindDown).toHaveBeenCalledWith('admin_1', NOW);

    users.listAdminUserIds.mockResolvedValue([]);
    await cityWindDownTick(NOW);
    expect(geo.runCityWindDown).toHaveBeenCalledTimes(1);
    expect(logging.logger.warn).toHaveBeenCalled();
  });

  it('stays quiet when nothing was due, and logs rather than throws when the sweep fails', async () => {
    geo.runCityWindDown.mockResolvedValueOnce([]);
    await cityWindDownTick(NOW);
    expect(logging.logger.info).not.toHaveBeenCalled();

    geo.runCityWindDown.mockRejectedValueOnce(new Error('db away'));
    await expect(cityWindDownTick(NOW)).resolves.toBeUndefined();
    expect(logging.logger.error).toHaveBeenCalledWith('cityWindDownJob tick failed', expect.objectContaining({ tag: 'cityWindDownJob' }));
    expect(redis.redis.del).toHaveBeenCalledTimes(2);
  });
});
