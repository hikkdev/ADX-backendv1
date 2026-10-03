import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { RedisUnavailableError, isRedisOutage, orSkipWhenRedisDown, redisKnownDown } from '../redis-outage';

const named = (name: string, message: string, stack?: string) => Object.assign(new Error(message), { name, ...(stack ? { stack } : {}) });

describe('a Redis outage', () => {
  it('is exactly the two ioredis give-up failures', () => {
    expect(isRedisOutage(named('MaxRetriesPerRequestError', 'Reached the max retries per request limit (which is 3).'))).toBe(true);
    expect(isRedisOutage(named('Error', 'Connection is closed.', 'Error: Connection is closed.\n    at close (node_modules/ioredis/built/redis/event_handler.js:184:25)'))).toBe(true);
  });

  it('is nothing else — a database error, a bug, a closed socket that is not Redis, a non-error', () => {
    expect(isRedisOutage(new Error("Can't reach database server"))).toBe(false);
    expect(isRedisOutage(new TypeError('x is undefined'))).toBe(false);
    expect(isRedisOutage(named('Error', 'Connection is closed.', 'Error: Connection is closed.\n    at somewhere/else.js:1:1'))).toBe(false);
    expect(isRedisOutage('Connection is closed.')).toBe(false);
    expect(isRedisOutage(undefined)).toBe(false);
  });
});

describe("a job's lock while Redis is away", () => {
  it('answers null (the tick is skipped) instead of throwing, and passes a real answer through', async () => {
    await expect(orSkipWhenRedisDown(Promise.reject(named('MaxRetriesPerRequestError', 'limit')), 'test')).resolves.toBeNull();
    await expect(orSkipWhenRedisDown(Promise.resolve('OK'), 'test')).resolves.toBe('OK');
  });
});

describe('failing fast while Redis is down (28 Sep 2026)', () => {
  it('counts the fail-fast error as an outage', () => {
    expect(isRedisOutage(new RedisUnavailableError())).toBe(true);
    expect(new RedisUnavailableError().message).toBe('Redis is unavailable');
  });

  it('knows the connection is down only once it is lost, never while it first connects', () => {
    for (const status of ['reconnecting', 'close', 'end']) expect(redisKnownDown(status)).toBe(true);
    for (const status of ['wait', 'connecting', 'connect', 'ready']) expect(redisKnownDown(status)).toBe(false);
  });
});
