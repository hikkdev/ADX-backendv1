import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

/**
 * 28 Sep 2026 (Docker was not running): a request refused because Redis is
 * down — a sign-in limiter that fails closed, a lock — answers 503 with a
 * Retry-After the client can act on, not a 500, and is not counted as a
 * server error (that counter lives in Redis too).
 */
const { recordServerError, reportError } = vi.hoisted(() => ({ recordServerError: vi.fn(), reportError: vi.fn() }));
vi.mock('../error-sink', () => ({ reportError }));
vi.mock('../error-rate-alert', () => ({ recordServerError }));

import { RedisUnavailableError } from '../../cache/redis-outage';
import { errorHandler } from '../error-handler';

function app(err: unknown) {
  const instance = express();
  instance.get('/x', () => {
    throw err;
  });
  instance.use(errorHandler);
  return instance;
}

describe('a request refused while Redis is down', () => {
  it('is a 503 to retry in a minute, not a 500', async () => {
    const res = await request(app(new RedisUnavailableError())).get('/x');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'This is briefly unavailable — please try again in a minute.' });
  });

  it('is the same for ioredis giving up on a queued command', async () => {
    const gaveUp = Object.assign(new Error('Reached the max retries per request limit (which is 3).'), { name: 'MaxRetriesPerRequestError' });
    expect((await request(app(gaveUp)).get('/x')).status).toBe(503);
  });

  it('is not counted or reported as a server error', async () => {
    recordServerError.mockClear();
    reportError.mockClear();
    await request(app(new RedisUnavailableError())).get('/x');
    expect(recordServerError).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('leaves every other error a 500', async () => {
    expect((await request(app(new Error('boom'))).get('/x')).status).toBe(500);
  });
});
