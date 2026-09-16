import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cache } = vi.hoisted(() => ({
  cache: { redis: { hset: vi.fn(), hgetall: vi.fn() } },
}));
vi.mock('../../cache', () => cache);

import { HEARTBEAT_KEY, JOB_NAMES, readHeartbeats, recordHeartbeat } from '../heartbeat';

describe('job heartbeats', () => {
  beforeEach(() => {
    cache.redis.hset.mockReset().mockResolvedValue(1);
    cache.redis.hgetall.mockReset().mockResolvedValue({});
  });

  it('records the tick under the job name without awaiting it', () => {
    recordHeartbeat('kyc-purge', new Date('2026-09-12T02:00:00Z'));
    expect(cache.redis.hset).toHaveBeenCalledWith(HEARTBEAT_KEY, 'kyc-purge', '2026-09-12T02:00:00.000Z');
  });

  it('swallows a Redis failure — a heartbeat is never a reason to fail a tick', async () => {
    cache.redis.hset.mockRejectedValue(new Error('down'));
    expect(() => recordHeartbeat('retention')).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it('lists every known job, null when it has never ticked, and any stranger after them', async () => {
    cache.redis.hgetall.mockResolvedValue({ 'kyc-purge': '2026-09-12T02:00:00.000Z', 'some-new-job': '2026-09-12T03:00:00.000Z' });
    const rows = await readHeartbeats();
    expect(rows.slice(0, JOB_NAMES.length).map((r) => r.job)).toEqual([...JOB_NAMES]);
    expect(rows.find((r) => r.job === 'kyc-purge')?.lastTickAt).toBe('2026-09-12T02:00:00.000Z');
    expect(rows.find((r) => r.job === 'retention')?.lastTickAt).toBeNull();
    expect(rows[rows.length - 1]).toEqual({ job: 'some-new-job', lastTickAt: '2026-09-12T03:00:00.000Z' });
  });
});
