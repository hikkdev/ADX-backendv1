import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G11-2 — is push configured? `GET /integrations` carries
 * `push: { configured, reason? }` from `shared/push`'s `readServiceAccount`,
 * the same read the FCM sender makes before every send. The service account
 * JSON itself is never a field of the response: not masked, not summarised
 * — a Firebase key has no "last four" worth showing.
 */
const { config, audit, push } = vi.hoisted(() => ({
  config: { getIntegrationsConfig: vi.fn(), updateIntegrationsConfig: vi.fn() },
  audit: { logActivity: vi.fn() },
  push: { readServiceAccount: vi.fn() },
}));

vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...config };
});
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../../../shared/push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/push')>();
  return { ...actual, ...push };
});

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { integrationsRouter } from '../integrations.routes';

function app() {
  const instance = express();
  instance.use(express.json());
  const api = Router();
  api.use('/integrations', integrationsRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const admin = tokenFor(['ADMIN'], 'adm_1');

beforeEach(() => {
  vi.clearAllMocks();
  config.getIntegrationsConfig.mockResolvedValue({});
  config.updateIntegrationsConfig.mockResolvedValue({});
});

describe('GET /integrations — the push section', () => {
  it('says push is configured when the service account reads, and carries nothing of the key', async () => {
    push.readServiceAccount.mockReturnValue({ account: { project_id: 'adx', client_email: 'x@adx.iam', private_key: 'PEM' }, reason: null });
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.push).toEqual({ configured: true });
    expect(JSON.stringify(res.body)).not.toContain('PEM');
    expect(JSON.stringify(res.body)).not.toContain('x@adx.iam');
  });

  it('names the reason when it is not: unset, or set but unreadable', async () => {
    push.readServiceAccount.mockReturnValue({ account: null, reason: 'FCM_NOT_CONFIGURED' });
    let res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.push).toEqual({ configured: false, reason: 'FCM_NOT_CONFIGURED' });

    push.readServiceAccount.mockReturnValue({ account: null, reason: 'FCM_MISCONFIGURED' });
    res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.push).toEqual({ configured: false, reason: 'FCM_MISCONFIGURED' });
  });

  it('is not a section the screen can write', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'push', patch: { serviceAccountJson: '{}' } });
    expect(res.status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });
});
