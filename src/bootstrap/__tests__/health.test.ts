import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { readyHandlerWith } from '../health';

function appWith(postgres: boolean, redis: boolean) {
  const app = express();
  app.get(
    '/ready',
    readyHandlerWith({
      postgres: async () => (postgres ? { ok: true, latencyMs: 4 } : { ok: false, error: 'connection refused' }),
      redis: async () => (redis ? { ok: true, latencyMs: 1 } : { ok: false, error: 'redis ping exceeded 3000ms' }),
    }),
  );
  return app;
}

describe('readiness probe', () => {
  it('answers 200 with both parts and the uptime when everything is reachable', async () => {
    const res = await request(appWith(true, true)).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { ok: true, postgres: { ok: true }, redis: { ok: true } },
    });
    expect(typeof res.body.data.uptime).toBe('number');
  });

  it('answers 503 naming the failing part', async () => {
    const res = await request(appWith(true, false)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.postgres.ok).toBe(true);
    expect(res.body.data.redis).toEqual({ ok: false, error: 'redis ping exceeded 3000ms' });
  });

  it('reports both when both are down rather than stopping at the first', async () => {
    const res = await request(appWith(false, false)).get('/ready');
    expect(res.status).toBe(503);
    expect(res.body.data.postgres.ok).toBe(false);
    expect(res.body.data.redis.ok).toBe(false);
  });
});
