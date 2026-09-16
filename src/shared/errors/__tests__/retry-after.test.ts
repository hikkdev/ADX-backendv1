import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

/**
 * E6: a refusal that says when to come back carries it as a header too.
 * Generic over any ApiError whose `details.retryAfter` is seconds — the KYC
 * provider's 503 today — so no route has to remember the header.
 */
vi.mock('../error-sink', () => ({ reportError: vi.fn() }));
vi.mock('../error-rate-alert', () => ({ recordServerError: vi.fn() }));

import { ApiError } from '../api-error';
import { errorHandler, retryAfterSeconds } from '../error-handler';

function app(err: unknown) {
  const instance = express();
  instance.get('/x', () => {
    throw err;
  });
  instance.use(errorHandler);
  return instance;
}

describe('Retry-After', () => {
  it('is set from details.retryAfter, in whole seconds', async () => {
    const res = await request(app(new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'Digio is down', { provider: 'DEGRADED', retryAfter: 300 }))).get('/x');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('300');
    expect(res.body.error.details.retryAfter).toBe(300);
  });

  it('is absent when the details carry nothing usable', async () => {
    const plain = await request(app(new ApiError(503, 'KYC_PROVIDER_UNAVAILABLE', 'no'))).get('/x');
    expect(plain.headers['retry-after']).toBeUndefined();
    const junk = await request(app(new ApiError(409, 'CONFLICT', 'slow down', { retryAfter: 'soon' }))).get('/x');
    expect(junk.headers['retry-after']).toBeUndefined();
  });

  it('rounds up and refuses negatives', () => {
    expect(retryAfterSeconds({ retryAfter: 0.2 })).toBe(1);
    expect(retryAfterSeconds({ retryAfter: -5 })).toBeNull();
    expect(retryAfterSeconds(null)).toBeNull();
  });
});
