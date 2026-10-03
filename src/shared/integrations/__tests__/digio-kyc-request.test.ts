import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 30 Sep 2026: the KYC request as Digio's sandbox answered it — without a
 * workflow Digio refuses ("Either of Template Name or Template Id is
 * mandatory"); without `generate_access_token` it gives back no token; and
 * the person verifies on Digio's gateway, never on the API host.
 *
 * Phase D (1 Oct 2026): the workflow is named by `template_id` — the id of
 * one of the twenty-five the owner built, picked by the caller's workflow
 * key, an override from the settings winning over the default. The owner's
 * templates are in Digio PRODUCTION, so `fetch` is mocked throughout: no
 * test here (or anywhere) may reach Digio. Timeouts, network failures, 5xx
 * and 429 are an outage (503 PROVIDER_ERROR); any other refusal is 502
 * KYC_PROVIDER_REFUSED with Digio's status and code, and the log carries
 * nothing of the person.
 */
const { env, kycConfig, logger } = vi.hoisted(() => ({
  env: { NODE_ENV: 'production', BASE_URL: 'https://adx-backendv1.onrender.com', DIGIO_ESIGN_GATEWAY_URL: 'https://app.digio.in' } as Record<string, string>,
  kycConfig: {
    clientId: 'client',
    clientSecret: 'secret',
    baseUrl: 'https://api.digio.in',
    kycProvider: 'DIGIO',
    workflowTemplates: {} as Record<string, string>,
    gatewayUrl: 'https://app.digio.in',
  },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../config/env', () => ({ env }));
vi.mock('../integration-config', () => ({ getEffectiveKycConfig: vi.fn(async () => kycConfig) }));
vi.mock('../../logging', () => ({ logger }));

import { DIGIO_KYC_TIMEOUT_MS, requestDigioKyc, type DigioKycRequest } from '../digio-client';
import { DEFAULT_DIGIO_WORKFLOW_TEMPLATES } from '../digio-workflows';

const request: DigioKycRequest = {
  party: 'PUBLISHER',
  workflowKey: 'PUBLISHER.INDIVIDUAL',
  referenceId: 'PUB_ref_1',
  customerName: 'Asha Rao',
  customerEmail: 'asha@example.com',
  customerMobile: '+919000000001',
};

let fetchMock: ReturnType<typeof vi.fn>;
const bodyOf = (call: number) => JSON.parse(String((fetchMock.mock.calls[call] as [string, RequestInit])[1].body)) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  kycConfig.workflowTemplates = {};
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'KID2609301200', customer_identifier: 'asha@example.com', access_token: { id: 'GWT_token_1', entity_id: 'KID2609301200', valid_till: '2026-10-01 12:00:00' } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a Digio KYC request', () => {
  it('names the workflow by template_id and asks for the access token, on the API host', async () => {
    await requestDigioKyc(request);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.digio.in/client/kyc/v2/request/with_template');
    const body = bodyOf(0);
    expect(body).toEqual({
      customer_identifier: 'asha@example.com',
      customer_name: 'Asha Rao',
      reference_id: 'PUB_ref_1',
      template_id: 'KTP261001040743600LJTDRKKQJX52I7',
      notify_customer: true,
      generate_access_token: true,
      callback_url: 'https://adx-backendv1.onrender.com/api/v1/webhooks/digio',
    });
    // The field Digio recognises — never the camel-cased one, nor the old name.
    expect(body).not.toHaveProperty('templateId');
    expect(body).not.toHaveProperty('template_name');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('client:secret').toString('base64')}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the person to Digio's gateway with the token — not the API host or the dashboard", async () => {
    const session = await requestDigioKyc(request);
    expect(session).toMatchObject({ kycId: 'KID2609301200', accessToken: 'GWT_token_1', validTill: '2026-10-01 12:00:00', mock: false });
    expect(session.sdkUrl).toMatch(/^https:\/\/app\.digio\.in\/#\/gateway\/login\/KID2609301200\/[a-z0-9]+\/asha%40example\.com\?token_id=GWT_token_1$/);
  });

  it('identifies the customer by mobile when there is no email, and leaves the callback out without BASE_URL', async () => {
    const base = env.BASE_URL;
    env.BASE_URL = '';
    try {
      await requestDigioKyc({ ...request, customerEmail: '' });
    } finally {
      env.BASE_URL = base!;
    }
    expect(bodyOf(0)).toMatchObject({ customer_identifier: '+919000000001' });
    expect(bodyOf(0)).not.toHaveProperty('callback_url');
  });

  it("names each workflow's own default id", async () => {
    for (const key of ['AGENT', 'ADVERTISER.POLITICAL', 'PRINT_PARTNER.LLP_PARTNERSHIP', 'EMPLOYEE.INTERN_CONTRACT'] as const) {
      await requestDigioKyc({ ...request, workflowKey: key });
    }
    expect(fetchMock.mock.calls.map((_, i) => bodyOf(i)['template_id'])).toEqual([
      DEFAULT_DIGIO_WORKFLOW_TEMPLATES.AGENT,
      DEFAULT_DIGIO_WORKFLOW_TEMPLATES['ADVERTISER.POLITICAL'],
      DEFAULT_DIGIO_WORKFLOW_TEMPLATES['PRINT_PARTNER.LLP_PARTNERSHIP'],
      DEFAULT_DIGIO_WORKFLOW_TEMPLATES['EMPLOYEE.INTERN_CONTRACT'],
    ]);
  });

  it('names an override from the settings over the default, for that workflow only', async () => {
    kycConfig.workflowTemplates = { 'PUBLISHER.INDIVIDUAL': 'KTP2610019999999999OVERRIDE00001' };
    await requestDigioKyc(request);
    await requestDigioKyc({ ...request, workflowKey: 'PUBLISHER.COMPANY' });
    expect(bodyOf(0)['template_id']).toBe('KTP2610019999999999OVERRIDE00001');
    expect(bodyOf(1)['template_id']).toBe(DEFAULT_DIGIO_WORKFLOW_TEMPLATES['PUBLISHER.COMPANY']);
  });

  it('refuses NO_TEMPLATE before asking Digio when no workflow was chosen', async () => {
    await expect(requestDigioKyc({ ...request, workflowKey: null })).rejects.toMatchObject({ statusCode: 503, code: 'KYC_PROVIDER_UNAVAILABLE', details: { reason: 'NO_TEMPLATE' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still opens a page when Digio gives back no token', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 'KID2609301201' }), { status: 200 }));
    const session = await requestDigioKyc(request);
    expect(session.accessToken).toBe('');
    expect(session.sdkUrl).toMatch(/^https:\/\/app\.digio\.in\/#\/gateway\/login\/KID2609301201\/[a-z0-9]+\/asha%40example\.com$/);
  });
});

describe('when Digio does not answer well', () => {
  const outage = { statusCode: 503, code: 'KYC_PROVIDER_UNAVAILABLE', details: { provider: 'DIGIO', reason: 'PROVIDER_ERROR' } };

  it('gives up after fifteen seconds and answers 503 PROVIDER_ERROR', async () => {
    expect(DIGIO_KYC_TIMEOUT_MS).toBe(15_000);
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    await expect(requestDigioKyc(request)).rejects.toMatchObject(outage);
  });

  it('reads a network failure as an outage too', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(requestDigioKyc(request)).rejects.toMatchObject(outage);
  });

  it('reads a 5xx and a 429 as an outage', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'INTERNAL', message: 'Down' }), { status: 502 }));
    await expect(requestDigioKyc(request)).rejects.toMatchObject(outage);
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429 }));
    await expect(requestDigioKyc(request)).rejects.toMatchObject(outage);
  });

  it("answers a template Digio does not know (404) as 502 KYC_PROVIDER_REFUSED with Digio's status and code", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'TEMPLATE_NOT_FOUND', message: 'No template for Asha Rao asha@example.com' }), { status: 404 }));
    await expect(requestDigioKyc(request)).rejects.toMatchObject({ statusCode: 502, code: 'KYC_PROVIDER_REFUSED', details: { status: 404, code: 'TEMPLATE_NOT_FOUND' } });
  });

  it('answers any other 4xx the same way, with a null code when Digio gave none', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Unauthorised', { status: 401 }));
    await expect(requestDigioKyc(request)).rejects.toMatchObject({ statusCode: 502, code: 'KYC_PROVIDER_REFUSED', details: { status: 401, code: null } });
  });

  it('logs the status and the code, never what the body said about the person', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'BAD_REQUEST', message: 'Asha Rao asha@example.com +919000000001' }), { status: 400 }));
    await expect(requestDigioKyc(request)).rejects.toMatchObject({ code: 'KYC_PROVIDER_REFUSED' });
    const logged = JSON.stringify([...logger.error.mock.calls, ...logger.warn.mock.calls, ...logger.info.mock.calls]);
    expect(logged).toContain('BAD_REQUEST');
    expect(logged).toContain('400');
    expect(logged).not.toContain('Asha');
    expect(logged).not.toContain('asha@example.com');
    expect(logged).not.toContain('9000000001');
  });
});
