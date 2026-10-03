import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

/**
 * FM-1 — `formSubmitLimiter`: ten answers per ten minutes per IP, counted
 * in Redis (the suite runs against the local container). The address is
 * fresh per run, through a trusted forwarding header, so one run's
 * counter never spends the next run's budget.
 */

import { formSubmitLimiter } from '../rate-limit';

function app() {
  const instance = express();
  instance.set('trust proxy', 1);
  instance.post('/answer', formSubmitLimiter, (_req, res) => {
    res.json({ ok: true });
  });
  return instance;
}

const freshIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

describe('formSubmitLimiter', () => {
  it('takes ten answers from one address, refuses the eleventh, and keeps another address whole', async () => {
    const instance = app();
    const ip = freshIp();
    for (let i = 0; i < 10; i += 1) {
      const res = await request(instance).post('/answer').set('X-Forwarded-For', ip).send({});
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit-limit']).toBe('10');
    }
    const refused = await request(instance).post('/answer').set('X-Forwarded-For', ip).send({});
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many answers from this connection. Please try again later.' } });
    const other = await request(instance).post('/answer').set('X-Forwarded-For', freshIp()).send({});
    expect(other.status).toBe(200);
  });
});
