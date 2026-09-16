import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E6: GET /settings/system-health/history — the heartbeats and the 30-day
 * 5xx series, for the graphs beside the lights.
 */
const { heartbeat, errors } = vi.hoisted(() => ({
  heartbeat: { readHeartbeats: vi.fn() },
  errors: { readDailyServerErrors: vi.fn(), DAILY_5XX_HISTORY_DAYS: 30 },
}));

vi.mock('../../../shared/jobs', () => heartbeat);
vi.mock('../../../shared/errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/errors')>();
  return { ...actual, ...errors };
});
vi.mock('../../app-config', () => ({ getConfigObject: vi.fn() }));
vi.mock('../../../shared/storage', () => ({ listPrivateFiles: vi.fn() }));
// Lot G (Q130): the per-service sample series beside the 5xx one.
vi.mock('../prisma-ops.repository', () => ({ prismaOpsRepository: { dailyHealth: vi.fn().mockResolvedValue([{ service: 'API', date: '2026-09-12', okPct: 100, p95Ms: 90 }]) } }));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { opsRouter } from '../ops.routes';

function app() {
  const instance = express();
  const api = Router();
  api.use('/settings/system-health', opsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const NOW = new Date('2026-09-12T09:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  heartbeat.readHeartbeats.mockResolvedValue([
    { job: 'kyc-purge', lastTickAt: new Date(NOW.getTime() - 5 * 60_000).toISOString() },
    { job: 'restore-drill', lastTickAt: null },
  ]);
  errors.readDailyServerErrors.mockResolvedValue([
    { day: '2026-09-11', count: 3 },
    { day: '2026-09-12', count: 1 },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /settings/system-health/history', () => {
  it('is ADMIN only', async () => {
    const res = await request(app()).get('/api/v1/settings/system-health/history').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'pub-1')}`);
    expect(res.status).toBe(403);
  });

  it('carries every job with its staleness and the 5xx series oldest first', async () => {
    const res = await request(app()).get('/api/v1/settings/system-health/history').set('Authorization', `Bearer ${tokenFor(['ADMIN'], 'adm-1')}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.jobs).toEqual([
      { job: 'kyc-purge', lastTickAt: expect.any(String), staleMinutes: 5, stale: false },
      { job: 'restore-drill', lastTickAt: null, staleMinutes: null, stale: true },
    ]);
    expect(res.body.data.serverErrors).toEqual({
      days: 30,
      series: [{ day: '2026-09-11', count: 3 }, { day: '2026-09-12', count: 1 }],
      total: 4,
      source: 'redis',
    });
    expect(errors.readDailyServerErrors).toHaveBeenCalledWith(expect.any(Date), 30);
    // Lot G (Q130): per service, thirty Indian days of the five-minute samples.
    expect(res.body.data.sampleDays).toBe(30);
    expect(Object.keys(res.body.data.services)).toEqual(['API', 'POSTGRES', 'REDIS', 'STORAGE', 'JOBS']);
    expect(res.body.data.services.API.days).toHaveLength(30);
    expect(res.body.data.services.API.days.at(-1)).toEqual({ date: '2026-09-12', okPct: 100, p95Ms: 90 });
    expect(res.body.data.services.REDIS.days.at(-1)).toEqual({ date: '2026-09-12', okPct: null, p95Ms: null });
  });
});
