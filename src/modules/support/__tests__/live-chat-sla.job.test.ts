import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot I — the minute sweep's job wrapper.
 *
 * What is pinned: the tick heartbeats whether or not it wins the lock, takes
 * a Redis lock shorter than the interval so a dead tick cannot hold the next
 * one out, hands the work to the module's `sweepLiveChats`, and logs rather
 * than throws when that fails.
 */

const { redis, jobs, support, logging } = vi.hoisted(() => ({
  redis: { redis: { set: vi.fn(), hset: vi.fn() } },
  jobs: { recordHeartbeat: vi.fn() },
  support: { sweepLiveChats: vi.fn() },
  logging: { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

vi.mock('../../../shared/cache', () => redis);
vi.mock('../../../shared/jobs', () => jobs);
vi.mock('../../../shared/logging', () => logging);
vi.mock('../../../shared/errors', () => ({ reportError: vi.fn(async () => undefined) }));
vi.mock('../../support', () => support);

import { liveChatSlaTick } from '../../../jobs/live-chat-sla.job';

const NOW = new Date('2026-09-14T06:30:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  redis.redis.set.mockResolvedValue('OK');
  support.sweepLiveChats.mockResolvedValue({ breached: [], converted: [] });
});

describe('the live-chat SLA tick', () => {
  it('heartbeats, takes the tick lock, and sweeps once', async () => {
    await liveChatSlaTick(NOW);
    expect(jobs.recordHeartbeat).toHaveBeenCalledWith('live-chat-sla', NOW);
    expect(redis.redis.set).toHaveBeenCalledWith('lock:live-chat-sla-tick', '1', 'PX', 50 * 1000, 'NX');
    expect(support.sweepLiveChats).toHaveBeenCalledWith(NOW);
  });

  it('heartbeats but does not sweep when another instance holds the lock', async () => {
    redis.redis.set.mockResolvedValue(null);
    await liveChatSlaTick(NOW);
    expect(jobs.recordHeartbeat).toHaveBeenCalled();
    expect(support.sweepLiveChats).not.toHaveBeenCalled();
  });

  it('logs a failed sweep rather than throwing out of the interval', async () => {
    support.sweepLiveChats.mockRejectedValue(new Error('database down'));
    await expect(liveChatSlaTick(NOW)).resolves.toBeUndefined();
    expect(logging.logger.error).toHaveBeenCalled();
  });

  it('says what it did only when it did something', async () => {
    await liveChatSlaTick(NOW);
    expect(logging.logger.info).not.toHaveBeenCalled();

    support.sweepLiveChats.mockResolvedValue({ breached: ['tkt_1'], converted: [] });
    await liveChatSlaTick(NOW);
    expect(logging.logger.info).toHaveBeenCalledWith('Live chats swept', expect.objectContaining({ breached: 1, converted: 0 }));
  });
});
