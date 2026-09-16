import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot E (Q98) — the HR tool as an integration section.
 *
 * What is pinned: the section is drawn with its API key masked and nothing
 * else hidden; Zoho People is the default provider; a link template without
 * `{externalId}` is refused; and a change of provider or portal is named in
 * the trail with its before and after, never the key.
 */
const { config, audit } = vi.hoisted(() => ({
  config: {
    getIntegrationsConfig: vi.fn(),
    updateIntegrationsConfig: vi.fn(),
  },
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
  config.getIntegrationsConfig.mockResolvedValue({});
  config.updateIntegrationsConfig.mockResolvedValue({});
});

describe('GET /integrations — the hrms section', () => {
  it('defaults to Zoho People with nothing configured', async () => {
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.hrms).toEqual({
      provider: 'ZOHO_PEOPLE',
      portalUrl: null,
      apiBaseUrl: null,
      apiKey: null,
      employeeLinkTemplate: null,
    });
  });

  it('masks the API key and nothing else', async () => {
    config.getIntegrationsConfig.mockResolvedValue({
      hrms: {
        provider: 'KEKA',
        portalUrl: 'https://adx.keka.com',
        apiBaseUrl: 'https://adx.keka.com/api/v1',
        apiKey: 'sk_live_abcdef1234',
        employeeLinkTemplate: 'https://adx.keka.com/#/people/{externalId}',
      },
    });
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.hrms).toMatchObject({
      provider: 'KEKA',
      portalUrl: 'https://adx.keka.com',
      apiKey: '••••1234',
      employeeLinkTemplate: 'https://adx.keka.com/#/people/{externalId}',
    });
    expect(JSON.stringify(res.body)).not.toContain('sk_live');
  });
});

describe('PUT /integrations { section: hrms }', () => {
  it('stores the patch and audits the link change with its before and after', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ hrms: { provider: 'ZOHO_PEOPLE' } });
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        section: 'hrms',
        patch: { provider: 'GREYTHR', portalUrl: 'https://adx.greythr.com', apiKey: 'k-1' },
      });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith(
      'hrms',
      expect.objectContaining({ provider: 'GREYTHR', portalUrl: 'https://adx.greythr.com' }),
    );
    const named = audit.logActivity.mock.calls.find((call) => call[1] === 'HRMS_CONFIG_UPDATED');
    expect(named).toBeDefined();
    const options = named![2] as { targetType: string; targetId: string; diff: Record<string, unknown>; metadata: Record<string, unknown> };
    expect(options.targetType).toBe('AppConfig');
    expect(options.targetId).toBe('integrations');
    expect(options.diff).toMatchObject({
      provider: { before: 'ZOHO_PEOPLE', after: 'GREYTHR' },
      portalUrl: { before: null, after: 'https://adx.greythr.com' },
    });
    expect(JSON.stringify({ diff: options.diff, metadata: options.metadata })).not.toContain('k-1');
  });

  it('refuses a link template that cannot name anybody', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'hrms', patch: { employeeLinkTemplate: 'https://people.zoho.in/adx/employees' } });
    expect(res.status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });

  it('refuses a provider it does not know', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'hrms', patch: { provider: 'WORKDAY' } });
    expect(res.status).toBe(400);
  });
});
