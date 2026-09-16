import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The daily package-renewal sweep job — Lot J2 (6).
 *
 * What is pinned: the tick heartbeats, takes the tick lock, runs once per
 * Indian day (the day key), hands the two duties to packages'
 * `runPackageRenewals`, and logs rather than throws when that fails. Lot K
 * (B2): the day key is written after a successful sweep, not before it — a
 * sweep that throws is retried on the next hourly tick the same day.
 */

const { redis, jobs, packages, logging } = vi.hoisted(() => ({
  redis: { redis: { set: vi.fn(), get: vi.fn(), hset: vi.fn() } },
  jobs: { recordHeartbeat: vi.fn() },
  packages: { runPackageRenewals: vi.fn() },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/jobs', () => jobs);
vi.mock('../../../shared/logging', () => logging);
vi.mock('../../../shared/errors', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('../../packages', () => packages);

import { packageRenewalTick } from '../../../jobs/package-renewal.job';

const NOW = new Date('2026-09-14T21:30:00Z'); // 03:00 IST on the 15th

beforeEach(() => {
  vi.clearAllMocks();
  redis.redis.set.mockResolvedValue('OK');
  redis.redis.get.mockResolvedValue(null);
  packages.runPackageRenewals.mockResolvedValue({ expiringNotified: 2, renewed: 1, renewalsFailed: 0 });
});

describe('the package renewal tick', () => {
  it('heartbeats, locks the tick, checks the Indian day, runs the sweep once, and only then writes the day key', async () => {
    await packageRenewalTick(NOW);
    expect(jobs.recordHeartbeat).toHaveBeenCalledWith('package-renewal', NOW);
    expect(redis.redis.set).toHaveBeenNthCalledWith(1, 'lock:package-renewal-tick', '1', 'PX', 50 * 60 * 1000, 'NX');
    expect(redis.redis.get).toHaveBeenCalledWith('lock:package-renewal:2026-09-15');
    expect(packages.runPackageRenewals).toHaveBeenCalledWith(NOW);
    expect(redis.redis.set).toHaveBeenNthCalledWith(2, 'lock:package-renewal:2026-09-15', '1', 'EX', 36 * 60 * 60);
    // The day key lands after the sweep returned, never before it ran.
    expect(packages.runPackageRenewals.mock.invocationCallOrder[0]!).toBeLessThan(redis.redis.set.mock.invocationCallOrder[1]!);
    expect(logging.logger.info).toHaveBeenCalledWith('Package renewals swept', expect.objectContaining({ expiringNotified: 2, renewed: 1, renewalsFailed: 0 }));
  });

  it('does nothing when another instance holds the tick, or the day has already run', async () => {
    redis.redis.set.mockResolvedValueOnce(null);
    await packageRenewalTick(NOW);
    expect(packages.runPackageRenewals).not.toHaveBeenCalled();
    expect(redis.redis.get).not.toHaveBeenCalled();

    redis.redis.get.mockResolvedValueOnce('1');
    await packageRenewalTick(NOW);
    expect(packages.runPackageRenewals).not.toHaveBeenCalled();
    expect(redis.redis.set).toHaveBeenCalledTimes(2); // the tick lock, twice; never the day key
    expect(jobs.recordHeartbeat).toHaveBeenCalledTimes(2);
  });

  /* Lot K (B2) */
  it('a sweep that throws leaves no day key, is logged rather than thrown, and is retried on the next hourly tick the same day', async () => {
    packages.runPackageRenewals.mockRejectedValueOnce(new Error('db away'));
    await expect(packageRenewalTick(NOW)).resolves.toBeUndefined();
    expect(logging.logger.error).toHaveBeenCalledWith('packageRenewalJob tick failed', expect.objectContaining({ tag: 'packageRenewalJob' }));
    expect(redis.redis.set).toHaveBeenCalledTimes(1);
    expect(redis.redis.set).not.toHaveBeenCalledWith('lock:package-renewal:2026-09-15', expect.anything(), expect.anything(), expect.anything());

    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    await packageRenewalTick(later);
    expect(packages.runPackageRenewals).toHaveBeenCalledTimes(2);
    expect(packages.runPackageRenewals).toHaveBeenLastCalledWith(later);
    expect(redis.redis.set).toHaveBeenLastCalledWith('lock:package-renewal:2026-09-15', '1', 'EX', 36 * 60 * 60);
  });
});
