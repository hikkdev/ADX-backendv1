import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * QR-1 — the QR engine card: the routes behind it.
 *
 * Pinned: the masked GET answers `qrEngine` with the key masked, the host,
 * the short origin and the style as-is, and `hostsDynamic` true only under
 * GENQR with credentials; the PUT is strict, merges the style sub-object
 * (blank keeps, null clears), and a change of provider is audited
 * `QR_ENGINE_CHANGED` with before/after and never the key;
 * `POST /integrations/qr-engine/test` is ADMIN + `settings.edit`, reads
 * `/api/v1/me` once on the stored key and answers a verdict — a refused
 * key, a dead host and a key short of scopes are 200 with the sentence,
 * never a 5xx, never the key — audited `INTEGRATION_TESTED`.
 */
const { config, audit, redis } = vi.hoisted(() => ({
  config: { getIntegrationsConfig: vi.fn(), updateIntegrationsConfig: vi.fn(), getEffectiveQrEngineConfig: vi.fn() },
  audit: { logActivity: vi.fn() },
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

vi.mock('../../../shared/integrations/integration-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations/integration-config')>();
  return { ...actual, ...config };
});
vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...audit };
});
vi.mock('../../../shared/cache/redis', () => ({ redis }));

import { signAccessToken } from '../../../shared/auth';
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
const viewer = signAccessToken('adm_2', ['ADMIN'], undefined, { perms: ['settings.view'] });
const publisher = tokenFor(['PUBLISHER'], 'pub_1');

const KEY = 'gqr_LIVE_SECRET_KEY_9876';

const row = (qrEngine: Record<string, unknown> | undefined = undefined) => ({
  ...(qrEngine === undefined ? {} : { qrEngine }),
});

const genqrRow = (over: Record<string, unknown> = {}) => ({
  provider: 'GENQR',
  baseUrl: 'https://genqr.example',
  apiKey: KEY,
  shortBaseUrl: 'https://go.adx.example',
  style: { foregroundColor: '#213333', dotStyle: 'rounded', frameCaption: 'Scan me' },
  ...over,
});

const get = (token = admin) => request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${token}`);
const put = (body: object, token = admin) => request(app()).put('/api/v1/integrations').set('Authorization', `Bearer ${token}`).send(body);
const test = (token = admin) => request(app()).post('/api/v1/integrations/qr-engine/test').set('Authorization', `Bearer ${token}`).send({});

beforeEach(() => {
  vi.clearAllMocks();
  config.getIntegrationsConfig.mockResolvedValue(row());
  config.updateIntegrationsConfig.mockResolvedValue({});
  config.getEffectiveQrEngineConfig.mockImplementation(async () => {
    const cfg = (await config.getIntegrationsConfig()) as { qrEngine?: Record<string, unknown> };
    const r = cfg.qrEngine ?? {};
    return { provider: r.provider ?? 'LOCAL', baseUrl: r.baseUrl, apiKey: r.apiKey, shortBaseUrl: r.shortBaseUrl, style: r.style ?? {} };
  });
  redis.get.mockResolvedValue(null);
  redis.set.mockResolvedValue('OK');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /integrations → qrEngine', () => {
  it('is LOCAL with nothing stored and hosts nothing', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.data.qrEngine).toEqual({ provider: 'LOCAL', baseUrl: null, apiKey: null, shortBaseUrl: null, style: {}, hostsDynamic: false });
  });

  it('masks the key and draws the rest as-is; hostsDynamic only under GENQR with credentials', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow()));
    const res = await get();
    expect(res.status).toBe(200);
    const view = res.body.data.qrEngine;
    expect(view.provider).toBe('GENQR');
    expect(view.baseUrl).toBe('https://genqr.example');
    expect(view.shortBaseUrl).toBe('https://go.adx.example');
    expect(view.style).toEqual({ foregroundColor: '#213333', dotStyle: 'rounded', frameCaption: 'Scan me' });
    expect(view.hostsDynamic).toBe(true);
    expect(view.apiKey).not.toBe(KEY);
    expect(JSON.stringify(res.body)).not.toContain(KEY);

    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow({ apiKey: undefined })));
    expect((await get()).body.data.qrEngine.hostsDynamic).toBe(false);
    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow({ provider: 'LOCAL' })));
    expect((await get()).body.data.qrEngine.hostsDynamic).toBe(false);
  });
});

describe('PUT /integrations { section: "qrEngine" }', () => {
  it('is strict: a stray key, a bad provider, a bad colour and a non-https logo are 400 and nothing is written', async () => {
    expect((await put({ section: 'qrEngine', patch: { provider: 'GENQR', nonsense: 1 } })).status).toBe(400);
    expect((await put({ section: 'qrEngine', patch: { provider: 'ZXING' } })).status).toBe(400);
    expect((await put({ section: 'qrEngine', patch: { style: { foregroundColor: 'teal' } } })).status).toBe(400);
    expect((await put({ section: 'qrEngine', patch: { style: { logoUrl: 'http://evil.example/x.png' } } })).status).toBe(400);
    expect((await put({ section: 'qrEngine', patch: { style: { frameStyle: 'ornate' } } })).status).toBe(400);
    expect((await put({ section: 'qrEngine', patch: { baseUrl: 'genqr.example' } })).status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });

  it('writes the switch, the host, the key and the short origin, and audits the provider change without the key', async () => {
    const res = await put({ section: 'qrEngine', patch: { provider: 'GENQR', baseUrl: 'https://genqr.example/', apiKey: KEY, shortBaseUrl: 'https://go.adx.example' } });
    expect(res.status).toBe(200);
    const [section, patch] = config.updateIntegrationsConfig.mock.calls[0]!;
    expect(section).toBe('qrEngine');
    expect(patch).toMatchObject({ provider: 'GENQR', baseUrl: 'https://genqr.example/', apiKey: KEY, shortBaseUrl: 'https://go.adx.example' });

    const changed = audit.logActivity.mock.calls.find((call) => call[1] === 'QR_ENGINE_CHANGED');
    expect(changed).toBeDefined();
    const { req: _req, ...recorded } = changed![2] as { req: unknown; diff: unknown; metadata: unknown };
    expect(JSON.stringify(recorded)).not.toContain(KEY);
    expect(JSON.stringify(recorded)).toContain('LOCAL');
    expect(JSON.stringify(recorded)).toContain('GENQR');
  });

  it('does not audit a provider change when the provider did not change', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow()));
    const res = await put({ section: 'qrEngine', patch: { provider: 'GENQR', shortBaseUrl: 'https://go2.adx.example' } });
    expect(res.status).toBe(200);
    expect(audit.logActivity.mock.calls.find((call) => call[1] === 'QR_ENGINE_CHANGED')).toBeUndefined();
  });

  it('merges the style over the stored one: a field sent keeps the rest, null clears one', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow()));
    const res = await put({ section: 'qrEngine', patch: { style: { frameStyle: 'label-below', frameCaption: null, backgroundColor: '' } } });
    expect(res.status).toBe(200);
    const [, patch] = config.updateIntegrationsConfig.mock.calls[0]!;
    expect((patch as { style: unknown }).style).toEqual({ foregroundColor: '#213333', dotStyle: 'rounded', frameStyle: 'label-below' });
  });

  it('clearing the short origin with null is allowed', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow()));
    const res = await put({ section: 'qrEngine', patch: { shortBaseUrl: null } });
    expect(res.status).toBe(200);
    const [, patch] = config.updateIntegrationsConfig.mock.calls[0]!;
    expect((patch as { shortBaseUrl: unknown }).shortBaseUrl).toBeNull();
  });
});

describe('POST /integrations/qr-engine/test', () => {
  it('is ADMIN + settings.edit: a publisher and a view-only admin are refused, nothing is called', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await test(publisher)).status).toBe(403);
    expect((await test(viewer)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('under LOCAL says codes are drawn locally, calls nobody, and is audited', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await test();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ engine: 'LOCAL', configured: true, reachable: true, account: null });
    expect(fetchMock).not.toHaveBeenCalled();
    const tested = audit.logActivity.mock.calls.find((call) => call[1] === 'INTEGRATION_TESTED');
    expect(tested![2]).toMatchObject({ metadata: { section: 'qrEngine', engine: 'LOCAL' } });
  });

  it('under GENQR reads /api/v1/me once with the stored key and prints the account, the missing scopes and the base mismatch — never the key', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow()));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ email: 'ops@adx.example', plan: { id: 'enterprise', name: 'Enterprise', apiAccessEnabled: true }, scope: 'qrcodes:read,qrcodes:write,analytics:read', redirectBase: 'https://genqr.example' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await test();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://genqr.example/api/v1/me');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(res.body.data).toMatchObject({
      engine: 'GENQR',
      configured: true,
      reachable: true,
      authorized: true,
      status: 200,
      account: { email: 'ops@adx.example', plan: 'Enterprise', apiAccess: true },
      scopesMissing: ['render'],
      shortBaseMatches: false,
    });
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    const tested = audit.logActivity.mock.calls.find((call) => call[1] === 'INTEGRATION_TESTED');
    expect(tested![2]).toMatchObject({ metadata: { section: 'qrEngine', engine: 'GENQR', verdict: { authorized: true, scopesMissing: ['render'], shortBaseMatches: false } } });
    const { req: _req, ...recorded } = tested![2] as { req: unknown; metadata: unknown };
    expect(JSON.stringify(recorded)).not.toContain(KEY);
  });

  it('a refused key and a dead host are verdicts, 200, never a 5xx', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow()));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({ error: 'Invalid or revoked API key.' }) })));
    let res = await test();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reachable: true, authorized: false, status: 401 });
    expect(res.body.data.message).toContain('Invalid or revoked API key.');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND genqr.example'); }));
    res = await test();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reachable: false, authorized: false });
    expect(res.body.data.message).toContain('ENOTFOUND');
  });

  it('with the switch on GENQR but no key, says so without a call', async () => {
    config.getIntegrationsConfig.mockResolvedValue(row(genqrRow({ apiKey: undefined })));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await test();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ engine: 'GENQR', configured: false, reachable: false, message: 'No GenQR API key is set.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
