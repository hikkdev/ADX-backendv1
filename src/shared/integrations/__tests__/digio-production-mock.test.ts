import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 28 Sep 2026 (the production env audit): with Digio unconfigured, development
 * hands out a mock session so the flow can be walked; production must refuse
 * instead — a mock session there would stand in for a real identity check.
 * Phase D: the mock still needs a workflow, so development sees the refusal
 * production would give a request with none.
 */
const { env, kycConfig } = vi.hoisted(() => ({ env: { NODE_ENV: 'development', BASE_URL: '' } as Record<string, string>, kycConfig: { baseUrl: 'https://ext.digio.in:444', gatewayUrl: 'https://ext-gateway.digio.in' } }));
vi.mock('../../../config/env', () => ({ env }));
vi.mock('../integration-config', () => ({ getEffectiveKycConfig: vi.fn(async () => kycConfig) }));

import { requestDigioKyc, type DigioKycRequest } from '../digio-client';

const request: DigioKycRequest = { party: 'PUBLISHER', workflowKey: 'PUBLISHER.INDIVIDUAL', referenceId: 'ref_1', customerName: 'Asha Rao', customerEmail: 'asha@example.com', customerMobile: '+919000000001' };

describe('an unconfigured Digio', () => {
  afterEach(() => {
    env.NODE_ENV = 'development';
  });

  it('gives development a mock session to walk the flow with', async () => {
    const session = await requestDigioKyc(request);
    expect(session).toMatchObject({ kycId: 'digio_mock_ref_1', mock: true });
  });

  it('refuses in production — never a mock session', async () => {
    env.NODE_ENV = 'production';
    await expect(requestDigioKyc(request)).rejects.toMatchObject({ statusCode: 503, code: 'KYC_PROVIDER_UNAVAILABLE' });
  });

  it('refuses NO_TEMPLATE in development too when no workflow was chosen', async () => {
    await expect(requestDigioKyc({ ...request, workflowKey: null })).rejects.toMatchObject({ statusCode: 503, details: { reason: 'NO_TEMPLATE' } });
  });
});
