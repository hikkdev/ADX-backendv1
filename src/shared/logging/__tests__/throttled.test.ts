import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger';
import { errorThrottled, resetThrottleForTests, warnThrottled } from '../throttled';

/**
 * 28 Sep 2026: one line a minute per warning during an outage, and how many
 * were held back. The real logger is watched, not replaced: the test setup
 * loads the Redis client, which loads this module before any mock could.
 */
describe('throttled logging', () => {
  beforeEach(() => {
    resetThrottleForTests();
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes the first, holds the rest for a minute, then says how many it held', () => {
    warnThrottled('Request latency not recorded', { reason: 'down' }, 0);
    for (let i = 1; i <= 40; i += 1) warnThrottled('Request latency not recorded', { reason: 'down' }, i * 1000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    warnThrottled('Request latency not recorded', { reason: 'down' }, 61_000);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenLastCalledWith('Request latency not recorded', { reason: 'down', repeatedSinceLast: 40 });
  });

  it('never lets one warning hide another', () => {
    warnThrottled('Request latency not recorded', undefined, 0);
    warnThrottled('Request outcome not counted', undefined, 0);
    errorThrottled('Redis connection error', { err: 'x' }, 0);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
