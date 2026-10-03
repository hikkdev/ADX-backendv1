import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Order fraud screening (2 Oct 2026) — the nightly re-screen job.
 *
 * Pinned: every tick records its heartbeat; the tick runs under a Redis lock
 * and a day key (Indian time), so the re-screen runs once a day however
 * many ticks and processes there are; with Redis away the tick is skipped
 * rather than run unlocked; and a failing run is reported, not thrown.
 */

const { redis, fraud, heartbeat, errors } = vi.hoisted(() => ({
  redis: { set: vi.fn() },
  fraud: { runOrderRescreen: vi.fn() },
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
vi.mock('../../modules/fraud', () => fraud);
vi.mock('../../shared/jobs', () => heartbeat);
vi.mock('../../shared/errors', () => errors);

import { istDay, orderRiskRescreenTick } from '../order-risk-rescreen.job';

const NOW = new Date('2026-10-02T20:00:00Z'); // 01:30 IST on 3 Oct

beforeEach(() => {
  vi.clearAllMocks();
  fraud.runOrderRescreen.mockResolvedValue({ scanned: 3, flagged: 1, held: 0, failed: 0, skipped: false });
});

describe('the nightly order re-screen', () => {
  it('keys the day in Indian time', () => {
    expect(istDay(NOW)).toBe('2026-10-03');
    expect(istDay(new Date('2026-10-02T18:29:00Z'))).toBe('2026-10-02');
  });

  it('runs once a day, under the tick lock and the day key, with its heartbeat', async () => {
    redis.set.mockResolvedValue('OK');
    await orderRiskRescreenTick(NOW);
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledWith('order-risk-rescreen', NOW);
    expect(redis.set).toHaveBeenNthCalledWith(1, 'lock:order-risk-rescreen-tick', '1', 'PX', expect.any(Number), 'NX');
    expect(redis.set).toHaveBeenNthCalledWith(2, 'lock:order-risk-rescreen:2026-10-03', '1', 'EX', expect.any(Number), 'NX');
    expect(fraud.runOrderRescreen).toHaveBeenCalledWith(NOW);
  });

  it('does nothing when another tick holds the lock or the day already ran', async () => {
    redis.set.mockResolvedValueOnce(null);
    await orderRiskRescreenTick(NOW);
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await orderRiskRescreenTick(NOW);
    expect(fraud.runOrderRescreen).not.toHaveBeenCalled();
    expect(heartbeat.recordHeartbeat).toHaveBeenCalledTimes(2);
  });

  it('skips the tick when Redis is away rather than run unlocked', async () => {
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    await orderRiskRescreenTick(NOW);
    expect(fraud.runOrderRescreen).not.toHaveBeenCalled();
  });

  it('reports a failing run and does not throw', async () => {
    redis.set.mockResolvedValue('OK');
    fraud.runOrderRescreen.mockRejectedValue(new Error('boom'));
    await expect(orderRiskRescreenTick(NOW)).resolves.toBeUndefined();
    expect(errors.reportError).toHaveBeenCalledWith(expect.any(Error), { tag: 'orderRiskRescreenJob' });
  });
});
