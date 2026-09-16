import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E10-1 — the work tool as an integration section.
 *
 * `workTool { provider NONE | JIRA | TRELLO | ASANA | OTHER, portalUrl,
 * name? }` beside `hrms`: a link the console follows, nothing more. There is
 * no secret in it, so nothing is masked and the section is drawn as-is;
 * it is read and written through the same two routes as every other section.
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
  config.getIntegrationsConfig.mockResolvedValue({});
  config.updateIntegrationsConfig.mockResolvedValue({});
});

describe('GET /integrations — the workTool section', () => {
  it('defaults to NONE with nothing configured, beside hrms', async () => {
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.workTool).toEqual({ provider: 'NONE', portalUrl: null, name: null });
    expect(res.body.data.hrms).toBeDefined();
  });

  it('draws the section as-is — there is no secret in it', async () => {
    config.getIntegrationsConfig.mockResolvedValue({
      workTool: { provider: 'JIRA', portalUrl: 'https://adx.atlassian.net', name: 'ADX Jira' },
    });
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.workTool).toEqual({ provider: 'JIRA', portalUrl: 'https://adx.atlassian.net', name: 'ADX Jira' });
  });
});

describe('PUT /integrations { section: workTool }', () => {
  it('stores the patch through the existing route', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'workTool', patch: { provider: 'TRELLO', portalUrl: 'https://trello.com/b/adx', name: 'Ops board' } });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('workTool', {
      provider: 'TRELLO',
      portalUrl: 'https://trello.com/b/adx',
      name: 'Ops board',
    });
    expect(audit.logActivity).toHaveBeenCalledWith('adm_1', 'INTEGRATION_CONFIG_UPDATED', expect.anything(), {
      section: 'workTool',
      fields: ['provider', 'portalUrl', 'name'],
    });
  });

  it('refuses a provider it does not know and a portal that is not a URL', async () => {
    const bad = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'workTool', patch: { provider: 'LINEAR' } });
    expect(bad.status).toBe(400);
    const badUrl = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'workTool', patch: { portalUrl: 'not a url' } });
    expect(badUrl.status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });
});
