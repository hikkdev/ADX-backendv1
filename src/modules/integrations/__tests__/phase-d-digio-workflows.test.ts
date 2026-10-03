import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase D (the owner, 1 Oct 2026) — the Digio card's twenty-five workflows.
 *
 * `GET /integrations` answers `kyc.workflows: [{ key, label, templateId,
 * source }]` — the id in force for each workflow and whether it is the
 * owner's default or an override; `PUT /integrations { section: 'kyc',
 * patch: { workflowTemplates } }` overrides ids by key — known keys only, a
 * `KTP…` id, merged over the stored overrides (blank keeps, null goes back
 * to the default) — and is named in the audit trail. The per-party template
 * names it replaces (`templateName`, `templates`) are gone from the read
 * and from the body, and are cleared off a row that still holds them.
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
import { DEFAULT_DIGIO_WORKFLOW_TEMPLATES, DIGIO_WORKFLOW_KEYS } from '../../../shared/integrations';
import { tokenFor } from '../../../shared/testing';
import { integrationsRouter } from '../integrations.routes';
import { patchSchemas } from '../integrations.schema';

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
const OVERRIDE = 'KTP2610019999999999OVERRIDE00001';
const put = (patch: Record<string, unknown>) => request(app()).put('/api/v1/integrations').set('Authorization', `Bearer ${admin}`).send({ section: 'kyc', patch });

type WorkflowRow = { key: string; label: string; templateId: string; source: string };

beforeEach(() => {
  vi.clearAllMocks();
  config.getIntegrationsConfig.mockResolvedValue({});
  config.updateIntegrationsConfig.mockResolvedValue({});
});

describe('GET /integrations — the Digio card', () => {
  it('lists the twenty-five workflows with the owner’s default ids, in the document’s order', async () => {
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const workflows = res.body.data.kyc.workflows as WorkflowRow[];
    expect(workflows.map((row) => row.key)).toEqual(DIGIO_WORKFLOW_KEYS);
    expect(workflows).toHaveLength(25);
    expect(workflows.every((row) => row.source === 'DEFAULT' && row.label.length > 0)).toBe(true);
    expect(workflows[0]).toEqual({ key: 'AGENT', label: 'Field Agent (sales agents too)', templateId: DEFAULT_DIGIO_WORKFLOW_TEMPLATES.AGENT, source: 'DEFAULT' });
    // The per-party template names are gone from the read.
    expect(res.body.data.kyc).not.toHaveProperty('templateName');
    expect(res.body.data.kyc).not.toHaveProperty('templates');
  });

  it('shows a stored override as OVERRIDE with its id, the rest DEFAULT', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ kyc: { workflowTemplates: { 'PUBLISHER.COMPANY': OVERRIDE } } });
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    const workflows = res.body.data.kyc.workflows as WorkflowRow[];
    expect(workflows.find((row) => row.key === 'PUBLISHER.COMPANY')).toMatchObject({ templateId: OVERRIDE, source: 'OVERRIDE' });
    expect(workflows.filter((row) => row.source === 'OVERRIDE')).toHaveLength(1);
  });
});

describe('PUT /integrations { section: kyc, patch: { workflowTemplates } }', () => {
  it('takes known keys only, a KTP… id trimmed, null to go back to the default, blank to keep', () => {
    const schema = patchSchemas.kyc;
    expect(schema.parse({ workflowTemplates: { AGENT: `  ${OVERRIDE} ` } })).toEqual({ workflowTemplates: { AGENT: OVERRIDE } });
    expect(schema.parse({ workflowTemplates: { AGENT: null, 'SPOT.MEDIA': '' } })).toEqual({ workflowTemplates: { AGENT: null, 'SPOT.MEDIA': '' } });
    expect(schema.safeParse({ workflowTemplates: { 'PUBLISHER.TRUST': OVERRIDE } }).success).toBe(false);
    expect(schema.safeParse({ workflowTemplates: { AGENT: 'ADX_AGENT_KYC' } }).success).toBe(false);
    expect(schema.safeParse({ workflowTemplates: { AGENT: 'ktp2610019999999999override00001' } }).success).toBe(false);
    expect(schema.safeParse({ workflowTemplates: { AGENT: `KTP${'A'.repeat(70)}` } }).success).toBe(false);
  });

  it('no longer takes the per-party template names', () => {
    const parsed = patchSchemas.kyc.parse({ templateName: 'ADX_KYC', templates: { PUBLISHER: 'ADX_PUBLISHER_KYC' }, kycProvider: 'DIGIO' });
    expect(parsed).toEqual({ kycProvider: 'DIGIO' });
  });

  it('merges over the stored overrides key by key, and audits the change', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ kyc: { workflowTemplates: { AGENT: OVERRIDE, 'PUBLISHER.COMPANY': OVERRIDE } } });
    const next = 'KTP2610018888888888OVERRIDE00002';
    const res = await put({ workflowTemplates: { AGENT: null, 'PUBLISHER.COMPANY': '', 'ADVERTISER.POLITICAL': next } });
    expect(res.status).toBe(200);
    // AGENT back to its default, PUBLISHER.COMPANY kept, ADVERTISER.POLITICAL added.
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('kyc', { workflowTemplates: { 'PUBLISHER.COMPANY': OVERRIDE, 'ADVERTISER.POLITICAL': next } });
    expect(audit.logActivity).toHaveBeenCalledWith(
      'adm_1',
      'KYC_WORKFLOW_TEMPLATES_CHANGED',
      expect.objectContaining({
        targetType: 'AppConfig',
        module: 'integrations',
        diff: { AGENT: { before: OVERRIDE, after: null }, 'ADVERTISER.POLITICAL': { before: null, after: next } },
      }),
    );
  });

  it('clears the superseded template names off a row that still holds them, on any KYC write', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ kyc: { clientId: 'digio-client-9876', templateName: 'ADX_KYC', templates: { PUBLISHER: 'ADX_PUBLISHER_KYC' } } });
    const res = await put({ kycProvider: 'MANUAL' });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('kyc', { kycProvider: 'MANUAL', templateName: null, templates: null });
  });

  it('refuses an unknown workflow key or a malformed id with 400, writing nothing', async () => {
    expect((await put({ workflowTemplates: { 'PUBLISHER.TRUST': OVERRIDE } })).status).toBe(400);
    expect((await put({ workflowTemplates: { AGENT: 'not-a-template-id' } })).status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });
});
