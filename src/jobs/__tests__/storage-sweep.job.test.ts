import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ST-3 (28 Sep 2026) — the weekly storage sweep job.
 *
 * What is pinned: the sweep's week begins Monday 03:00 IST; the hourly tick
 * runs the sweep once per week (the week key), as the scheduled trigger,
 * under the system user; with Redis away the tick is skipped rather than
 * run unlocked; and a failing sweep is reported, not thrown.
 */

const { redis, uploads, users, heartbeat, errors } = vi.hoisted(() => ({
  redis: { set: vi.fn() },
  uploads: { runStorageSweepExclusive: vi.fn() },
  users: { systemUserId: vi.fn(), listAdminUserIds: vi.fn() },
  heartbeat: { recordHeartbeat: vi.fn() },
  errors: { reportError: vi.fn() },
}));

vi.mock('../../shared/cache', () => ({
  redis,
  orSkipWhenRedisDown: async <T>(call: Promise<T>) => {
    try {
      return await call;
    } catch {
      return null;
    }
  },
}));
vi.mock('../../modules/uploads', () => uploads);
vi.mock('../../modules/users', () => users);
vi.mock('../../shared/jobs', () => heartbeat);
vi.mock('../../shared/errors', () => errors);

import { storageSweepTick, sweepWeekKey } from '../storage-sweep.job';

const RUN = {
  trigger: 'SCHEDULE',
  startedAt: '2026-10-05T00:00:00.000Z',
  durationMs: 5,
  mark: { checked: 3, marked: 1, cleared: 0, unreferenced: 1, byPurpose: {}, protectedUnreferenced: {}, rowsRead: 9 },
  removal: { removed: 0, removedBytes: 0, held: 'OFF', keptWithoutStorageKey: 0, failed: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  users.systemUserId.mockResolvedValue('usr_system');
  users.listAdminUserIds.mockResolvedValue(['usr_admin']);
  uploads.runStorageSweepExclusive.mockResolvedValue(RUN);
});

describe('the sweep week', () => {
  it('begins Monday 03:00 IST', () => {
    // Monday 5 Oct 2026, 02:59 IST = Sunday 21:29 UTC — still the week of Monday 28 Sep.
    expect(sweepWeekKey(new Date('2026-10-04T21:29:00.000Z'))).toBe('2026-09-28');
    // Monday 5 Oct 2026, 03:00 IST = Sunday 21:30 UTC — the new week.
    expect(sweepWeekKey(new Date('2026-10-04T21:30:00.000Z'))).toBe('2026-10-05');
    expect(sweepWeekKey(new Date('2026-10-11T12:00:00.000Z'))).toBe('2026-10-05');
  });
});

describe('the tick', () => {
  it('runs the scheduled sweep once a week, under the system user', async () => {
    redis.set.mockResolvedValue('OK');
    await storageSweepTick(new Date('2026-10-05T04:00:00.000Z'));
    expect(uploads.runStorageSweepExclusive).toHaveBeenCalledWith({ now: new Date('2026-10-05T04:00:00.000Z'), trigger: 'SCHEDULE', actorUserId: 'usr_system' });
    expect(redis.set).toHaveBeenCalledWith('lock:storage-sweep:2026-10-05', '1', 'EX', expect.any(Number), 'NX');
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith('storage-sweep', expect.any(Date));
  });

  it('does nothing when the week has already run', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await storageSweepTick(new Date('2026-10-06T04:00:00.000Z'));
    expect(uploads.runStorageSweepExclusive).not.toHaveBeenCalled();
  });

  it('falls back to an admin when there is no system user', async () => {
    redis.set.mockResolvedValue('OK');
    users.systemUserId.mockResolvedValue(null);
    await storageSweepTick(new Date('2026-10-05T04:00:00.000Z'));
    expect(uploads.runStorageSweepExclusive).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: 'usr_admin' }));
  });

  it('skips the tick while Redis is away', async () => {
    redis.set.mockRejectedValue(new Error('Connection is closed.'));
    await storageSweepTick(new Date('2026-10-05T04:00:00.000Z'));
    expect(uploads.runStorageSweepExclusive).not.toHaveBeenCalled();
  });

  it('reports a failing sweep and does not throw', async () => {
    redis.set.mockResolvedValue('OK');
    uploads.runStorageSweepExclusive.mockRejectedValue(new Error('relation does not exist'));
    await expect(storageSweepTick(new Date('2026-10-05T04:00:00.000Z'))).resolves.toBeUndefined();
    expect(errors.reportError).toHaveBeenCalled();
  });
});
