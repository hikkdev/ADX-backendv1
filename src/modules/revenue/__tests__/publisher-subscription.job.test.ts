import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily publisher-subscription sweep job — Lot J (B1).
 *
 * What is pinned: the tick heartbeats, takes the tick lock, runs once per
 * Indian day (the day key), hands the three duties to revenue's
 * `runPublisherSubscriptionSweep`, and logs rather than throws when that
 * fails. Lot K (B2): the day key is written after a successful sweep, not
 * before it — a sweep that throws is retried on the next hourly tick the
 * same day.
 */

const { redis, jobs, revenue, logging } = vi.hoisted(() => ({
  redis: { redis: { set: vi.fn(), get: vi.fn(), hset: vi.fn() } },
  jobs: { recordHeartbeat: vi.fn() },
  revenue: { runPublisherSubscriptionSweep: vi.fn() },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/jobs', () => jobs);
vi.mock('../../../shared/logging', () => logging);
vi.mock('../../../shared/errors', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('../../revenue', () => revenue);

import { publisherSubscriptionTick } from '../../../jobs/publisher-subscription.job';

const NOW = new Date('2026-09-14T21:30:00Z'); // 03:00 IST on the 15th

beforeEach(() => {
  vi.clearAllMocks();
  redis.redis.set.mockResolvedValue('OK');
  redis.redis.get.mockResolvedValue(null);
  revenue.runPublisherSubscriptionSweep.mockResolvedValue({ expiringNotified: 2, endedNotified: 1, ordersExpired: 3 });
});

describe('the publisher subscription tick', () => {
  it('heartbeats, locks the tick, checks the Indian day, runs the sweep once, and only then writes the day key', async () => {
    await publisherSubscriptionTick(NOW);
    expect(jobs.recordHeartbeat).toHaveBeenCalledWith('publisher-subscription', NOW);
    expect(redis.redis.set).toHaveBeenNthCalledWith(1, 'lock:publisher-subscription-tick', '1', 'PX', 50 * 60 * 1000, 'NX');
    expect(redis.redis.get).toHaveBeenCalledWith('lock:publisher-subscription:2026-09-15');
    expect(revenue.runPublisherSubscriptionSweep).toHaveBeenCalledWith(NOW);
    expect(redis.redis.set).toHaveBeenNthCalledWith(2, 'lock:publisher-subscription:2026-09-15', '1', 'EX', 36 * 60 * 60);
    // The day key lands after the sweep returned, never before it ran.
    expect(revenue.runPublisherSubscriptionSweep.mock.invocationCallOrder[0]!).toBeLessThan(redis.redis.set.mock.invocationCallOrder[1]!);
    expect(logging.logger.info).toHaveBeenCalledWith('Publisher subscriptions swept', expect.objectContaining({ expiringNotified: 2, endedNotified: 1, ordersExpired: 3 }));
  });

  it('does nothing when another instance holds the tick, or the day has already run', async () => {
    redis.redis.set.mockResolvedValueOnce(null);
    await publisherSubscriptionTick(NOW);
    expect(revenue.runPublisherSubscriptionSweep).not.toHaveBeenCalled();
    expect(redis.redis.get).not.toHaveBeenCalled();

    redis.redis.get.mockResolvedValueOnce('1');
    await publisherSubscriptionTick(NOW);
    expect(revenue.runPublisherSubscriptionSweep).not.toHaveBeenCalled();
    expect(redis.redis.set).toHaveBeenCalledTimes(2); // the tick lock, twice; never the day key
    expect(jobs.recordHeartbeat).toHaveBeenCalledTimes(2);
  });

  /* Lot K (B2) */
  it('a sweep that throws leaves no day key, is logged rather than thrown, and is retried on the next hourly tick the same day', async () => {
    revenue.runPublisherSubscriptionSweep.mockRejectedValueOnce(new Error('db away'));
    await expect(publisherSubscriptionTick(NOW)).resolves.toBeUndefined();
    expect(logging.logger.error).toHaveBeenCalledWith('publisherSubscriptionJob tick failed', expect.objectContaining({ tag: 'publisherSubscriptionJob' }));
    expect(redis.redis.set).toHaveBeenCalledTimes(1);
    expect(redis.redis.set).not.toHaveBeenCalledWith('lock:publisher-subscription:2026-09-15', expect.anything(), expect.anything(), expect.anything());

    // An hour later, same Indian day: the tick lock has lapsed, the day key was never written, the sweep runs and the key lands.
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await publisherSubscriptionTick(later);
    expect(revenue.runPublisherSubscriptionSweep).toHaveBeenCalledTimes(2);
    expect(revenue.runPublisherSubscriptionSweep).toHaveBeenLastCalledWith(later);
    expect(redis.redis.set).toHaveBeenLastCalledWith('lock:publisher-subscription:2026-09-15', '1', 'EX', 36 * 60 * 60);
  });
});
