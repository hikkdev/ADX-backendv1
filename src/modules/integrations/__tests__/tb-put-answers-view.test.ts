import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T-B — a write answers the same view its read answers.
 *
 * `PUT /integrations` keeps its `{ message }` envelope and, beside it, carries
 * the same masked config `GET /integrations` answers (re-read after the
 * write), so the AI and KYC screens update their local state from the
 * answer without a second read. Secrets are masked by the one mapper.
 */
const { config, audit } = vi.hoisted(() => ({
  config: { getIntegrationsConfig: vi.fn(), updateIntegrationsConfig: vi.fn() },
  audit: { logActivity: vi.fn() },
}));

vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...config };
});
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
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
  config.updateIntegrationsConfig.mockResolvedValue({});
});

describe('PUT /integrations answers the GET view beside its message', () => {
  it('carries the freshly stored ai section, masked the way the GET masks it', async () => {
    config.getIntegrationsConfig
      .mockResolvedValueOnce({ ai: { provider: 'anthropic', enabled: false } })
      .mockResolvedValueOnce({ ai: { provider: 'anthropic', apiKey: 'sk-ant-abcd1234', enabled: true, model: 'claude-sonnet-4' } });
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'ai', patch: { apiKey: 'sk-ant-abcd1234', enabled: true, model: 'claude-sonnet-4' } });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('ai configuration updated');
    expect(res.body.data.ai).toMatchObject({ provider: 'anthropic', apiKey: '••••1234', enabled: true, model: 'claude-sonnet-4' });
    expect(res.body.data.kyc).toBeDefined();
    expect(res.body.data.infra).toBeDefined();
  });

  it('carries the kyc section for the digio alias, with the provider just switched', async () => {
    config.getIntegrationsConfig
      .mockResolvedValueOnce({ kyc: { kycProvider: 'DIGIO' } })
      .mockResolvedValueOnce({ kyc: { kycProvider: 'MANUAL', clientId: 'digio-client-9876' } });
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'digio', patch: { kycProvider: 'MANUAL' } });
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('kyc configuration updated');
    expect(res.body.data.kyc).toMatchObject({ kycProvider: 'MANUAL', clientId: '••••9876' });
    // the raw client id never leaves the server, on the write any more than on the read
    expect(JSON.stringify(res.body)).not.toContain('digio-client-9876');
  });
});
