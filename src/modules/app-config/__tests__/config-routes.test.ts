import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Q33 — the `x-admin-secret` header is gone.
 *
 * Both writes that accepted it (PUT /config and PUT /app/status) are now
 * ordinary ADMIN routes, both leave an audit row, and a bad flow edit can be
 * undone: every PUT /config keeps the row it replaced under `main:previous`,
 * and POST /config/revert puts it back.
 */

const { repository, audit, settings } = vi.hoisted(() => ({
  repository: { find: vi.fn(), findByKey: vi.fn(), save: vi.fn(), saveByKey: vi.fn() },
  audit: { logActivity: vi.fn(), auditDiff: vi.fn(() => ({})) },
  settings: { getPlatformSettings: vi.fn(), updatePlatformSettings: vi.fn(), flattenSettings: vi.fn(() => ({})) },
}));

vi.mock('../prisma-app-config.repository', () => ({ prismaAppConfigRepository: repository }));
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../platform-settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform-settings')>();
  return { ...actual, ...settings };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { appStatusRouter, configRouter, platformSettingsRouter } from '../app-config.routes';
import { DEFAULT_APP_STATUS } from '../app-status';
import { DEFAULT_PLATFORM_SETTINGS } from '../platform-settings';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/config', configRouter);
  api.use('/app', appStatusRouter);
  api.use('/settings', platformSettingsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'admin-1');
const publisher = tokenFor(['PUBLISHER'], 'pub-1');
const flows = { enums: { a: [1] }, flows: { onboard: { screens: [] } } };

beforeEach(() => {
  vi.clearAllMocks();
  repository.find.mockResolvedValue({ key: 'main', value: flows, updatedAt: new Date() });
  repository.findByKey.mockResolvedValue(null);
  repository.save.mockImplementation(async (value: object) => ({ key: 'main', value }));
  repository.saveByKey.mockImplementation(async (key: string, value: object) => ({
    key,
    value,
    updatedAt: new Date('2026-09-12T00:00:00.000Z'),
  }));
  settings.getPlatformSettings.mockResolvedValue(DEFAULT_PLATFORM_SETTINGS);
  settings.updatePlatformSettings.mockResolvedValue({
    before: DEFAULT_PLATFORM_SETTINGS,
    after: { ...DEFAULT_PLATFORM_SETTINGS, marketplace: { minBookingDays: 7, maxMarketsPerCampaign: 3 } },
  });
});

describe('PUT /config', () => {
  it('refuses the retired header outright — no token, no write', async () => {
    const res = await request(app()).put('/api/v1/config').set('x-admin-secret', 'adx_admin_dev_secret').send(flows);
    expect(res.status).toBe(401);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('refuses a non-admin token', async () => {
    const res = await request(app()).put('/api/v1/config').set('Authorization', `Bearer ${publisher}`).send(flows);
    expect(res.status).toBe(403);
  });

  it('writes, keeps the replaced row as main:previous, and audits the keys that moved', async () => {
    const next = { enums: { a: [1] }, flows: { onboard: { screens: [{ key: 's1' }] } } };
    const res = await request(app()).put('/api/v1/config').set('Authorization', `Bearer ${admin}`).send(next);

    expect(res.status).toBe(200);
    expect(repository.saveByKey).toHaveBeenCalledWith('main:previous', flows);
    expect(repository.save).toHaveBeenCalledWith(next);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'APP_CONFIG_UPDATED',
      expect.objectContaining({ module: 'app-config', targetId: 'main', metadata: { changedKeys: ['flows'] } }),
    );
  });

  it('keeps the flow editor error envelope: a plain string, not a code object', async () => {
    const res = await request(app())
      .put('/api/v1/config')
      .set('Authorization', `Bearer ${admin}`)
      .send({ enums: {} });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, error: 'Missing required field: flows (object)' });
  });
});

describe('POST /config/revert', () => {
  it('puts the previous row back and makes the undone step the new previous', async () => {
    const previous = { enums: {}, flows: { onboard: { screens: [] } } };
    repository.findByKey.mockResolvedValue({ key: 'main:previous', value: previous });

    const res = await request(app()).post('/api/v1/config/revert').set('Authorization', `Bearer ${admin}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(previous);
    expect(repository.save).toHaveBeenCalledWith(previous);
    expect(repository.saveByKey).toHaveBeenCalledWith('main:previous', flows);
    expect(audit.logActivity).toHaveBeenCalledWith('admin-1', 'APP_CONFIG_REVERTED', expect.anything());
  });

  it('is a conflict when nothing has been replaced yet', async () => {
    repository.findByKey.mockResolvedValue(null);
    const res = await request(app()).post('/api/v1/config/revert').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(409);
  });
});

describe('PUT /app/status', () => {
  it('needs an ADMIN token and leaves a row', async () => {
    const anonymous = await request(app()).put('/api/v1/app/status').send(DEFAULT_APP_STATUS);
    expect(anonymous.status).toBe(401);

    const res = await request(app())
      .put('/api/v1/app/status')
      .set('Authorization', `Bearer ${admin}`)
      .send(DEFAULT_APP_STATUS);
    expect(res.status).toBe(200);
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'APP_STATUS_UPDATED',
      expect.objectContaining({ targetId: 'app-status' }),
    );
  });

  it('stays public to read — a maintenance window is when the token endpoint is down', async () => {
    const res = await request(app()).get('/api/v1/app/status');
    expect(res.status).toBe(200);
  });
});

describe('GET /app/limits', () => {
  it('needs a session and answers only the three wizard numbers off the platform settings', async () => {
    expect((await request(app()).get('/api/v1/app/limits')).status).toBe(401);
    settings.getPlatformSettings.mockResolvedValue({
      ...DEFAULT_PLATFORM_SETTINGS,
      marketplace: { ...DEFAULT_PLATFORM_SETTINGS.marketplace, minBookingDays: 3, maxMarketsPerCampaign: 5 },
      kyc: { ...DEFAULT_PLATFORM_SETTINGS.kyc, reviewSlaHours: 24 },
    });
    const res = await request(app()).get('/api/v1/app/limits').set('Authorization', `Bearer ${publisher}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ marketplace: { minBookingDays: 3, maxMarketsPerCampaign: 5 }, kyc: { reviewSlaHours: 24 } });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('/settings/platform', () => {
  it('is ADMIN-only both ways', async () => {
    expect((await request(app()).get('/api/v1/settings/platform')).status).toBe(401);
    expect(
      (await request(app()).get('/api/v1/settings/platform').set('Authorization', `Bearer ${publisher}`)).status,
    ).toBe(403);
  });

  it('reads the row and writes a patch, audited as PLATFORM_SETTINGS_UPDATED', async () => {
    const read = await request(app()).get('/api/v1/settings/platform').set('Authorization', `Bearer ${admin}`);
    expect(read.status).toBe(200);
    expect(read.body.data.kyc.reviewSlaHours).toBe(48);

    const write = await request(app())
      .put('/api/v1/settings/platform')
      .set('Authorization', `Bearer ${admin}`)
      .send({ marketplace: { minBookingDays: 7 } });

    expect(write.status).toBe(200);
    expect(write.body.data.marketplace.minBookingDays).toBe(7);
    expect(settings.updatePlatformSettings).toHaveBeenCalledWith({ marketplace: { minBookingDays: 7 } });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'PLATFORM_SETTINGS_UPDATED',
      expect.objectContaining({ module: 'app-config', targetId: 'platform' }),
    );
  });

  it('refuses an unknown section rather than storing it', async () => {
    const res = await request(app())
      .put('/api/v1/settings/platform')
      .set('Authorization', `Bearer ${admin}`)
      .send({ marketplaces: { minBookingDays: 7 } });
    expect(res.status).toBe(400);
    expect(settings.updatePlatformSettings).not.toHaveBeenCalled();
  });
});
