import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /settings/system-health/ops — Lot E. One read that says whether the
 * housekeeping is happening: the last dump, the last drill, what retention
 * has flagged, and whether every job is ticking.
 */

const { appConfig, storage, heartbeat, repository } = vi.hoisted(() => ({
  appConfig: { getConfigObject: vi.fn() },
  storage: { listPrivateFiles: vi.fn() },
  heartbeat: { readHeartbeats: vi.fn() },
  // G11-2: the status page's subscribers, counted on the same read.
  repository: { subscriberCounts: vi.fn() },
}));

vi.mock('../../app-config', () => appConfig);
vi.mock('../../../shared/storage', () => storage);
vi.mock('../../../shared/jobs', () => heartbeat);
vi.mock('../prisma-ops.repository', () => ({ prismaOpsRepository: repository }));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { opsRouter } from '../ops.routes';
import { ERASURE_DUE_KEY, LAST_DRILL_KEY, RETENTION_DUE_KEY } from '../ops.keys';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/settings/system-health', opsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const NOW = new Date('2026-10-02T09:00:00Z');
// Signed after the clock is pinned, or a fifteen-minute token minted today has expired by then.
let admin = '';
let agent = '';

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  admin = tokenFor(['ADMIN'], 'admin-1');
  agent = tokenFor(['AGENT_PUBLISHER'], 'agent-1');
  storage.listPrivateFiles.mockResolvedValue([
    { storageKey: 'r2:private/backups/2026-09-30T02-00-00Z.dump.enc', name: '2026-09-30T02-00-00Z.dump.enc', size: 100, lastModified: null },
    { storageKey: 'r2:private/backups/2026-10-01T02-00-00Z.dump.enc', name: '2026-10-01T02-00-00Z.dump.enc', size: 200, lastModified: null },
    { storageKey: 'r2:private/backups/README', name: 'README', size: 1, lastModified: null },
  ]);
  appConfig.getConfigObject.mockImplementation(async (key: string) => {
    if (key === LAST_DRILL_KEY) return { ranAt: '2026-10-01T03:00:00.000Z', status: 'PASSED', dump: { name: '2026-10-01T02-00-00Z.dump.enc', size: 200 }, durationMs: 4200, ledger: { unbalanced: 0, drift: 0, healthy: true }, warnings: null, error: null };
    if (key === RETENTION_DUE_KEY) return { generatedAt: '2026-10-02T02:00:00.000Z', count: 2, items: [{ erasureId: 'a' }, { erasureId: 'b' }] };
    if (key === ERASURE_DUE_KEY) return { notified: { ers_1: '2026-10-01T02:00:00.000Z' } };
    return null;
  });
  heartbeat.readHeartbeats.mockResolvedValue([
    { job: 'kyc-purge', lastTickAt: '2026-10-02T08:30:00.000Z' },
    { job: 'retention', lastTickAt: '2026-10-01T02:00:00.000Z' },
    { job: 'restore-drill', lastTickAt: null },
  ]);
  repository.subscriberCounts.mockResolvedValue({ confirmed: 4, pending: 1 });
});

afterEach(() => vi.useRealTimers());

describe('GET /settings/system-health/ops', () => {
  it('is ADMIN-only', async () => {
    await request(app()).get('/api/v1/settings/system-health/ops').expect(401);
    await request(app()).get('/api/v1/settings/system-health/ops').set('Authorization', `Bearer ${agent}`).expect(403);
  });

  it('answers the four questions from storage, the two rows and the heartbeats', async () => {
    const res = await request(app()).get('/api/v1/settings/system-health/ops').set('Authorization', `Bearer ${admin}`).expect(200);
    const data = res.body.data;

    expect(storage.listPrivateFiles).toHaveBeenCalledWith('backups');
    expect(data.backup).toEqual({
      last: { name: '2026-10-01T02-00-00Z.dump.enc', takenAt: '2026-10-01T02:00:00.000Z', size: 200 },
      count: 2,
      ageHours: 31,
      stale: true,
      rotationDays: 35,
    });
    expect(data.drill).toEqual(expect.objectContaining({ status: 'PASSED', ranAt: '2026-10-01T03:00:00.000Z' }));
    expect(data.retention).toEqual({ dueCount: 2, generatedAt: '2026-10-02T02:00:00.000Z', erasureOverdue: 1 });
    expect(data.jobs).toEqual([
      { job: 'kyc-purge', lastTickAt: '2026-10-02T08:30:00.000Z', staleMinutes: 30, stale: false },
      { job: 'retention', lastTickAt: '2026-10-01T02:00:00.000Z', staleMinutes: 1860, stale: true },
      { job: 'restore-drill', lastTickAt: null, staleMinutes: null, stale: true },
    ]);
    expect(data.targets).toEqual({ rpoHours: 1, rtoHours: 4 });
    // G11-2: who is on the status page's list — confirmed by link, or still waiting on the mail.
    expect(data.subscribers).toEqual({ confirmed: 4, pending: 1 });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is honest about nothing having happened yet', async () => {
    storage.listPrivateFiles.mockResolvedValue([]);
    appConfig.getConfigObject.mockResolvedValue(null);
    heartbeat.readHeartbeats.mockResolvedValue([]);
    repository.subscriberCounts.mockResolvedValue({ confirmed: 0, pending: 0 });
    const res = await request(app()).get('/api/v1/settings/system-health/ops').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(res.body.data.backup).toEqual({ last: null, count: 0, ageHours: null, stale: true, rotationDays: 35 });
    expect(res.body.data.drill).toBeNull();
    expect(res.body.data.retention).toEqual({ dueCount: 0, generatedAt: null, erasureOverdue: 0 });
    expect(res.body.data.jobs).toEqual([]);
    expect(res.body.data.subscribers).toEqual({ confirmed: 0, pending: 0 });
  });

  it('still answers when storage cannot be listed, naming the failure', async () => {
    storage.listPrivateFiles.mockRejectedValue(new Error('R2 is down'));
    const res = await request(app()).get('/api/v1/settings/system-health/ops').set('Authorization', `Bearer ${admin}`).expect(200);
    expect(res.body.data.backup).toEqual({ last: null, count: 0, ageHours: null, stale: true, rotationDays: 35, error: 'R2 is down' });
  });
});
