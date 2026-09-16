import express, { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * AC-B2 — GeoIQ made to actually work: the two routes behind the audience card.
 *
 * Pinned: `POST /integrations/audience/test` asks the vendor ONCE at a fixed
 * point (MG Road, Bengaluru) with the mapped variables — or the documented
 * sample `w_pop_tt` when none are mapped, so the KEY can be tested before
 * the map exists — and answers a plain verdict the card prints; a vendor's
 * refusal, a missing key or a dead host is a verdict, never a 5xx; the call
 * is ADMIN + `settings.edit` and audited `INTEGRATION_TESTED` with the
 * vendor and the verdict, never the key. `GET /integrations/audience/fields`
 * is the field catalogue the console draws the variable map from. The PUT
 * refuses a `geoiqVariables` key off the seam, 400, naming it.
 */
const { config, audit } = vi.hoisted(() => ({
  config: { getIntegrationsConfig: vi.fn(), updateIntegrationsConfig: vi.fn(), getEffectiveAudienceConfig: vi.fn() },
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

import { signAccessToken } from '../../../shared/auth';
import { DEFAULT_AUDIENCE_POLICY, GEOIQ_DEFAULT_BASE_URL } from '../../../shared/integrations';
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

const SECRET = 'geoiq-live-key-ABCD1234';
const GATEWAY_REFUSAL = {
  body: JSON.stringify({ status: 401, message: 'You are not authorized to access this API. Please contact GeoIQ Administrator for access.', data: null }),
  statusCode: 401,
};

const audience = (over: Record<string, unknown> = {}) => ({
  provider: 'GEOIQ',
  providers: ['GEOIQ'],
  policy: DEFAULT_AUDIENCE_POLICY,
  geoiqApiKey: SECRET,
  geoiqBaseUrl: GEOIQ_DEFAULT_BASE_URL,
  geoiqVariables: {},
  aziraApiKey: undefined,
  aziraBaseUrl: undefined,
  catchmentRadiusM: 500,
  ...over,
});

function stubVendor(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const testCall = (body: object, token = admin) =>
  request(app()).post('/api/v1/integrations/audience/test').set('Authorization', `Bearer ${token}`).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  config.getIntegrationsConfig.mockResolvedValue({});
  config.updateIntegrationsConfig.mockResolvedValue({});
  config.getEffectiveAudienceConfig.mockResolvedValue(audience());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /integrations/audience/test', () => {
  it('is ADMIN + settings.edit: a publisher and a view-only admin are refused, nothing is asked', async () => {
    const fetchMock = stubVendor({});
    expect((await testCall({ vendor: 'GEOIQ' }, publisher)).status).toBe(403);
    expect((await testCall({ vendor: 'GEOIQ' }, viewer)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('refuses a vendor off the seam, 400', async () => {
    const res = await testCall({ vendor: 'NEAR' });
    expect(res.status).toBe(400);
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('no key: a verdict with keyPresent false, nothing asked, audited without a key', async () => {
    config.getEffectiveAudienceConfig.mockResolvedValue(audience({ geoiqApiKey: undefined }));
    const fetchMock = stubVendor({});
    const res = await testCall({ vendor: 'GEOIQ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      vendor: 'GEOIQ',
      keyPresent: false,
      variablesMapped: 0,
      reachable: false,
      authorized: false,
      status: null,
      fieldsAnswered: [],
      fieldsMissing: [],
    });
    expect(res.body.data.message).toMatch(/no API key/i);
    expect(fetchMock).not.toHaveBeenCalled();
    const tested = audit.logActivity.mock.calls.find((call) => call[1] === 'INTEGRATION_TESTED');
    expect(tested).toBeDefined();
    expect(tested![2]).toMatchObject({ targetType: 'AppConfig', targetId: 'integrations', module: 'integrations' });
    expect(tested![2].metadata).toMatchObject({ vendor: 'GEOIQ', verdict: expect.objectContaining({ keyPresent: false, reachable: false }) });
  });

  it('the gateway envelope refusing the key: 200 with authorized false and GeoIQ`s sentence — the key nowhere in the answer or the trail', async () => {
    const fetchMock = stubVendor(GATEWAY_REFUSAL, true, 200);
    const res = await testCall({ vendor: 'GEOIQ' });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://dataserving-in.geoiq.io/production/v1.0/getvariables');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(SECRET);
    // No variables mapped: the documented sample variable, at MG Road, the row's radius.
    expect(JSON.parse(String(init.body))).toEqual({ lat: 12.9755, lng: 77.6068, radius: 500, variables: 'w_pop_tt' });
    expect(res.body.data).toMatchObject({ vendor: 'GEOIQ', keyPresent: true, variablesMapped: 0, reachable: true, authorized: false, status: 401 });
    expect(res.body.data.message).toContain('You are not authorized to access this API');
    expect(res.body.data.message).toContain('contact GeoIQ');
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain('ABCD1234');
    const tested = audit.logActivity.mock.calls.find((call) => call[1] === 'INTEGRATION_TESTED');
    expect(tested).toBeDefined();
    expect(tested![2].metadata).toMatchObject({ vendor: 'GEOIQ', verdict: expect.objectContaining({ authorized: false, status: 401 }) });
    expect(JSON.stringify({ metadata: tested![2].metadata, diff: tested![2].diff })).not.toContain('ABCD1234');
  });

  it('success: the mapped variables are asked with the radius clamped to GeoIQ`s 2000 m, the fields answered and missing are named, the footfall sample carried', async () => {
    config.getEffectiveAudienceConfig.mockResolvedValue(
      audience({ geoiqVariables: { 'footfall.daily': 'w_f', 'gender.male': 'w_m', 'gender.female': 'w_fe', 'age.18_24': 'w_a1' }, catchmentRadiusM: 3_000 }),
    );
    const fetchMock = stubVendor({ body: JSON.stringify({ status: 200, data: { w_f: 1234.4, w_m: 0.52, w_a1: 0.2 } }), statusCode: 200 });
    const res = await testCall({ vendor: 'GEOIQ' });
    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent.radius).toBe(2000);
    expect(sent.variables.split(',').sort()).toEqual(['w_a1', 'w_f', 'w_fe', 'w_m']);
    expect(res.body.data).toMatchObject({
      vendor: 'GEOIQ',
      keyPresent: true,
      variablesMapped: 4,
      reachable: true,
      authorized: true,
      status: 200,
      fieldsAnswered: ['footfall.daily', 'gender.male', 'age.18_24'],
      fieldsMissing: ['gender.female'],
      sample: { footfallDaily: 1234 },
    });
  });

  it('a dead host is a verdict too: reachable false, status null, never a 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND dataserving.geoiq.io'); }));
    const res = await testCall({ vendor: 'GEOIQ' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ vendor: 'GEOIQ', keyPresent: true, reachable: false, authorized: false, status: null });
    expect(res.body.data.message).toMatch(/could not be reached/i);
    expect(res.text).not.toContain(SECRET);
  });

  it('Azira without its configuration skips gracefully', async () => {
    const fetchMock = stubVendor({});
    const res = await testCall({ vendor: 'AZIRA' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ vendor: 'AZIRA', keyPresent: false, reachable: false, authorized: false, status: null });
    expect(res.body.data.message).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(audit.logActivity.mock.calls.find((call) => call[1] === 'INTEGRATION_TESTED')![2].metadata).toMatchObject({ vendor: 'AZIRA' });
  });
});

describe('GET /integrations/audience/fields', () => {
  it('draws the catalogue: footfall.daily required, the age and income bands, the three genders, affinity free-form', async () => {
    const res = await request(app()).get('/api/v1/integrations/audience/fields').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const { fields, groups, pattern } = res.body.data;
    expect(fields).toContainEqual({ field: 'footfall.daily', group: 'footfall', label: 'Daily footfall', required: true });
    const byGroup = (group: string) => fields.filter((f: { group: string }) => f.group === group).map((f: { field: string }) => f.field);
    expect(byGroup('age')).toEqual(['age.18_24', 'age.25_34', 'age.35_44', 'age.45_54', 'age.55_plus']);
    expect(byGroup('gender')).toEqual(['gender.male', 'gender.female', 'gender.other']);
    expect(byGroup('income')).toEqual(['income.low', 'income.mid', 'income.high', 'income.affluent']);
    expect(fields.filter((f: { required: boolean }) => f.required).map((f: { field: string }) => f.field)).toEqual(['footfall.daily']);
    expect(groups.find((g: { group: string }) => g.group === 'affinity')).toMatchObject({ freeForm: true, pattern: 'affinity.<name>' });
    expect(groups.map((g: { group: string }) => g.group)).toEqual(['footfall', 'age', 'gender', 'income', 'affinity']);
    expect(new RegExp(pattern, 'i').test('affinity.fitness')).toBe(true);
    expect(new RegExp(pattern, 'i').test('footfall.hourly')).toBe(false);
  });

  it('is ADMIN only', async () => {
    expect((await request(app()).get('/api/v1/integrations/audience/fields').set('Authorization', `Bearer ${publisher}`)).status).toBe(403);
    expect((await request(app()).get('/api/v1/integrations/audience/fields')).status).toBe(401);
  });
});

describe('PUT /integrations { section: audience } — the variable map', () => {
  it('refuses a key off the seam, 400, naming it; a map of seam fields is written', async () => {
    const bad = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'audience', patch: { geoiqVariables: { 'footfall.daily': 'w_pop_tt', 'footfall.hourly': 'w_x', 'retail.spend': 'w_y' } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(bad.body)).toContain('footfall.hourly');
    expect(JSON.stringify(bad.body)).toContain('retail.spend');
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();

    const ok = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'audience', patch: { geoiqVariables: { 'footfall.daily': 'w_pop_tt', 'age.55_plus': 'w_age_55', 'affinity.dining': 'w_rest' } } });
    expect(ok.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('audience', {
      geoiqVariables: { 'footfall.daily': 'w_pop_tt', 'age.55_plus': 'w_age_55', 'affinity.dining': 'w_rest' },
    });
  });
});
