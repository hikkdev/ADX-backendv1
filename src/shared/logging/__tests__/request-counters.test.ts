import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G13-B: the hourly request / 5xx counters behind the region's error rate.
 * One hash field per UTC hour, both hashes bumped in one round trip; the
 * read sums the last 24 fields and prunes the rest.
 */

const redis = vi.hoisted(() => {
  const chain = { hincrby: vi.fn(), exec: vi.fn() };
  chain.hincrby.mockReturnValue(chain);
  return { multi: vi.fn(() => chain), chain, hgetall: vi.fn(), hdel: vi.fn() };
});

vi.mock('../../cache/redis', () => ({ redis }));

import { HOURLY_5XX_KEY, HOURLY_REQUESTS_KEY, hourKey, readRecentRequestCounts, recordRequestOutcome } from '../request-counters';

const NOW = new Date('2026-09-14T05:20:00Z');
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  redis.chain.hincrby.mockReturnValue(redis.chain);
  redis.chain.exec.mockResolvedValue([]);
  redis.hdel.mockResolvedValue(1);
});

describe('recordRequestOutcome', () => {
  it('counts every request in its hour, and a 5xx in the second hash too, in one round trip', async () => {
    recordRequestOutcome(200, NOW);
    expect(redis.chain.hincrby).toHaveBeenCalledTimes(1);
    expect(redis.chain.hincrby).toHaveBeenCalledWith(HOURLY_REQUESTS_KEY, hourKey(NOW), 1);
    recordRequestOutcome(503, NOW);
    expect(redis.chain.hincrby).toHaveBeenCalledWith(HOURLY_5XX_KEY, hourKey(NOW), 1);
    expect(redis.multi).toHaveBeenCalledTimes(2);
  });

  it('never throws when Redis is down', async () => {
    redis.chain.exec.mockRejectedValue(new Error('down'));
    expect(() => recordRequestOutcome(500, NOW)).not.toThrow();
    await Promise.resolve();
  });
});

describe('readRecentRequestCounts', () => {
  it('sums the last 24 hours, the current one included, and prunes older fields', async () => {
    const inWindow = hourKey(new Date(NOW.getTime() - 23 * HOUR));
    const outOfWindow = hourKey(new Date(NOW.getTime() - 24 * HOUR));
    redis.hgetall.mockImplementation(async (key: string) =>
      key === HOURLY_REQUESTS_KEY ? { [hourKey(NOW)]: '100', [inWindow]: '50', [outOfWindow]: '999' } : { [hourKey(NOW)]: '3', [outOfWindow]: '9' },
    );
    const counts = await readRecentRequestCounts(NOW);
    expect(counts).toEqual({ requests: 150, serverErrors: 3, hours: 24 });
    expect(redis.hdel).toHaveBeenCalledWith(HOURLY_REQUESTS_KEY, outOfWindow);
    expect(redis.hdel).toHaveBeenCalledWith(HOURLY_5XX_KEY, outOfWindow);
  });

  it('answers zeros when the hashes are unreadable', async () => {
    redis.hgetall.mockRejectedValue(new Error('down'));
    expect(await readRecentRequestCounts(NOW)).toEqual({ requests: 0, serverErrors: 0, hours: 24 });
  });
});
