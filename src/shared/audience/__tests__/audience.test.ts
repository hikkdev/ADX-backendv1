import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import geoiqFixture from './fixtures/geoiq-getvariables.json';
import aziraFixture from './fixtures/azira-catchment.json';

/**
 * The audience seam and its two adapters — G7 (Q109), the vendors stubbed
 * with the recorded fixtures; Y-B, both vendors at once.
 *
 * Pinned: nothing enabled answers 503 and never calls anybody; each adapter
 * answers 503 without a key and never spends one; the recorded answers
 * become the seam's shape; what a vendor does not document is null — GeoIQ
 * has no hourly panel, an unmapped GeoIQ field is null, a 23-hour Azira
 * profile is null; fractions are printed as percent and percent is left
 * alone; the radius every spot is asked about is the row's, so figures
 * compare. Y-B: both enabled vendors are asked in parallel and blended;
 * one vendor's 429 / 502 does not lose the other's answer; a vendor with
 * no credentials is skipped, not 503, unless none has any; the old
 * readers' `audienceVendorName` names the footfall primary.
 */

const { integrations } = vi.hoisted(() => ({
  integrations: { getEffectiveAudienceConfig: vi.fn() },
}));

vi.mock('../../integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integrations')>();
  return { ...actual, ...integrations };
});

import { DEFAULT_AUDIENCE_POLICY, resolveAudiencePolicy, resolveAudienceProviders } from '../../integrations';
import { AUDIENCE_TEST_POINT, audienceCatchment, audienceVendorName, audienceVendorsInForce, getAudienceProvider, testAudienceVendor } from '..';
import { geoiqCatchment } from '../geoiq';
import { aziraCatchment } from '../azira';
import { AUDIENCE_FIELD_PATTERN, AUDIENCE_PERIOD_PATTERN, periodBounds } from '../types';

function stubVendor(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** One fetch stub answering per host: GeoIQ's and Azira's bodies (or statuses) independently. */
function stubBothVendors(geoiq: { body: unknown; status?: number }, azira: { body: unknown; status?: number }) {
  const fetchMock = vi.fn(async (url: string) => {
    const pick = url.includes('geoiq') ? geoiq : azira;
    const status = pick.status ?? 200;
    return { ok: status < 400, status, json: async () => pick.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const GEOIQ_VARIABLES = {
  'footfall.daily': 'w_footfall_daily_avg',
  'age.18_24': 'w_pop_age_18_24_perc',
  'age.25_34': 'w_pop_age_25_34_perc',
  'age.35_44': 'w_pop_age_35_44_perc',
  'gender.male': 'w_pop_male_perc',
  'gender.female': 'w_pop_female_perc',
  'income.high': 'w_hh_income_high_perc',
  'income.mid': 'w_hh_income_mid_perc',
  'affinity.fitness': 'w_poi_gym_count',
};

const geoiqConfig = (over: Record<string, unknown> = {}) => ({
  provider: 'GEOIQ',
  providers: ['GEOIQ'],
  policy: DEFAULT_AUDIENCE_POLICY,
  geoiqApiKey: 'geoiq-key',
  geoiqBaseUrl: 'https://dataserving-in.geoiq.io/production/v1.0',
  geoiqVariables: GEOIQ_VARIABLES,
  catchmentRadiusM: 500,
  ...over,
});

const aziraConfig = (over: Record<string, unknown> = {}) => ({
  provider: 'AZIRA',
  providers: ['AZIRA'],
  policy: DEFAULT_AUDIENCE_POLICY,
  aziraApiKey: 'azira-key',
  aziraClientId: 'adx',
  aziraBaseUrl: 'https://api.azira.example/v1',
  geoiqVariables: {},
  catchmentRadiusM: 500,
  ...over,
});

/** Y-B: both enabled, both with credentials. */
const bothConfig = (over: Record<string, unknown> = {}) => ({
  ...geoiqConfig(),
  ...aziraConfig(),
  provider: 'AZIRA',
  providers: ['GEOIQ', 'AZIRA'],
  geoiqVariables: GEOIQ_VARIABLES,
  ...over,
});

const noneConfig = () => ({ provider: 'NONE', providers: [], policy: DEFAULT_AUDIENCE_POLICY, geoiqVariables: {}, catchmentRadiusM: 500 });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the seam', () => {
  it('nothing enabled answers 503 and never calls anybody', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(noneConfig());
    const fetchMock = stubVendor({});
    expect((await getAudienceProvider()).provider.name).toBe('NONE');
    expect(await audienceVendorsInForce()).toEqual([]);
    expect(await audienceVendorName()).toBe('NONE');
    await expect(audienceCatchment(12.97, 77.6, '2026-09')).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks the vendor in force about the radius on the row', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig({ catchmentRadiusM: 750 }));
    const fetchMock = stubVendor(geoiqFixture.response.body);
    const catchment = await audienceCatchment(12.9758, 77.6061, '2026-09');
    expect(catchment?.vendor).toBe('GEOIQ');
    expect(catchment?.vendors).toEqual(['GEOIQ']);
    expect(catchment?.provenance).toBe('PANEL');
    expect(catchment?.provenanceByField).toEqual({ footfall: 'GEOIQ', demographics: 'GEOIQ', affinities: 'GEOIQ' });
    expect(catchment?.agreement).toEqual({ footfall: null });
    expect(catchment?.radiusM).toBe(750);
    const [, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).radius).toBe(750);
  });

  describe('Y-B: both vendors at once', () => {
    it('asks both in parallel and answers the blend: Azira-first footfall averaged, GeoIQ-first demographics, the raw answers beside', async () => {
      integrations.getEffectiveAudienceConfig.mockResolvedValue(bothConfig());
      const fetchMock = stubBothVendors({ body: geoiqFixture.response.body }, { body: aziraFixture.response.body });
      const catchment = await audienceCatchment(12.9758, 77.6061, '2026-09');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(catchment?.vendors).toEqual(['GEOIQ', 'AZIRA']);
      // daily: (18421 + 21340) / 2; the hourly and weekday panels are Azira's alone (GeoIQ has none) — footfall is BLENDED.
      expect(catchment?.footfall.daily).toBe(Math.round((18421 + 21340) / 2));
      expect(catchment?.footfall.byWeekday).toEqual([13.2, 13, 13.4, 13.8, 15.1, 16.9, 14.6]);
      expect(catchment?.footfall.byHour).toHaveLength(24);
      expect(catchment?.provenanceByField).toEqual({ footfall: 'BLENDED', demographics: 'GEOIQ', affinities: 'GEOIQ' });
      expect(catchment?.demographics.ageBands).toEqual([
        { label: '18_24', share: 21 },
        { label: '25_34', share: 34 },
        { label: '35_44', share: 19 },
      ]);
      expect(catchment?.agreement.footfall).toBe(Math.round((1 - (21340 - 18421) / 21340) * 1000) / 1000);
      expect(catchment?.rawByVendor.GEOIQ?.footfall.daily).toBe(18421);
      expect(catchment?.rawByVendor.AZIRA?.footfall.daily).toBe(21340);
      // The legacy `vendor` names the footfall primary when the figure is blended.
      expect(catchment?.vendor).toBe('AZIRA');
      expect(await audienceVendorName()).toBe('AZIRA');
      expect(await audienceVendorsInForce()).toEqual(['GEOIQ', 'AZIRA']);
    });

    it('a 429 from one vendor does not lose the other one`s answer', async () => {
      integrations.getEffectiveAudienceConfig.mockResolvedValue(bothConfig());
      stubBothVendors({ body: geoiqFixture.response.body }, { body: { message: 'Too many' }, status: 429 });
      const catchment = await audienceCatchment(12.9758, 77.6061, '2026-09');
      expect(catchment?.vendors).toEqual(['GEOIQ']);
      expect(catchment?.footfall.daily).toBe(18421);
      expect(catchment?.provenanceByField.footfall).toBe('GEOIQ');
      expect(catchment?.agreement.footfall).toBeNull();
    });

    it('a vendor with no credentials is skipped, not 503 — unless none has any', async () => {
      integrations.getEffectiveAudienceConfig.mockResolvedValue(bothConfig({ aziraApiKey: '' }));
      const fetchMock = stubBothVendors({ body: geoiqFixture.response.body }, { body: {} });
      const catchment = await audienceCatchment(12.9758, 77.6061, '2026-09');
      expect(catchment?.vendors).toEqual(['GEOIQ']);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      integrations.getEffectiveAudienceConfig.mockResolvedValue(bothConfig({ aziraApiKey: '', geoiqApiKey: '' }));
      await expect(audienceCatchment(12.9758, 77.6061, '2026-09')).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces a vendor failure only when nobody answered; nothing anywhere is null', async () => {
      integrations.getEffectiveAudienceConfig.mockResolvedValue(bothConfig());
      stubBothVendors({ body: {}, status: 500 }, { body: {}, status: 429 });
      await expect(audienceCatchment(12.9758, 77.6061, '2026-09')).rejects.toMatchObject({ statusCode: expect.any(Number) });
      stubBothVendors({ body: { data: {} } }, { body: {} });
      expect(await audienceCatchment(12.9758, 77.6061, '2026-09')).toBeNull();
    });

    it('a legacy one-vendor row reads as a one-element set; a partial policy fills from the defaults', () => {
      expect(resolveAudienceProviders({ provider: 'GEOIQ' })).toEqual(['GEOIQ']);
      expect(resolveAudienceProviders({ provider: 'NONE' })).toEqual([]);
      expect(resolveAudienceProviders({ provider: 'GEOIQ', providers: ['AZIRA'] })).toEqual(['AZIRA']);
      expect(resolveAudienceProviders({ providers: ['AZIRA', 'GEOIQ', 'AZIRA'] })).toEqual(['GEOIQ', 'AZIRA']);
      expect(resolveAudienceProviders(undefined)).toEqual([]);
      expect(resolveAudiencePolicy({ footfall: { blend: 'PRIMARY' } })).toEqual({
        footfall: { primary: 'AZIRA', fallback: true, blend: 'PRIMARY' },
        demographics: { primary: 'GEOIQ', fallback: true },
        affinities: { primary: 'GEOIQ', fallback: true },
      });
    });
  });

  it('knows a period and its bounds', () => {
    expect(AUDIENCE_PERIOD_PATTERN.test('2026-09')).toBe(true);
    expect(AUDIENCE_PERIOD_PATTERN.test('2026-13')).toBe(false);
    expect(AUDIENCE_PERIOD_PATTERN.test('2026-9')).toBe(false);
    expect(periodBounds('2026-12')).toEqual({ start: new Date('2026-12-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') });
    for (const field of ['footfall.daily', 'age.18_24', 'gender.female', 'income.high', 'affinity.fitness']) {
      expect(AUDIENCE_FIELD_PATTERN.test(field), field).toBe(true);
    }
    expect(AUDIENCE_FIELD_PATTERN.test('footfall.hourly')).toBe(false);
  });
});

describe('GeoIQ', () => {
  it('answers 503 without a key, and without any mapped variable, touching nothing', async () => {
    const fetchMock = stubVendor(geoiqFixture.response.body);
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig({ geoiqApiKey: '' }));
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig({ geoiqVariables: {} }));
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the mapped variable ids with the key and reads the recorded answer into the seam shape', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig());
    const fetchMock = stubVendor(geoiqFixture.response.body);
    const catchment = await geoiqCatchment(12.9758, 77.6061, 500, '2026-09');

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(geoiqFixture.request.url);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('geoiq-key');
    expect(JSON.parse(String(init.body))).toEqual(geoiqFixture.request.body);

    expect(catchment).toMatchObject({
      footfall: { daily: 18421, byHour: null, byWeekday: null },
      demographics: {
        ageBands: [
          { label: '18_24', share: 21 },
          { label: '25_34', share: 34 },
          { label: '35_44', share: 19 },
        ],
        gender: [
          { label: 'male', share: 53 },
          { label: 'female', share: 47 },
        ],
        incomeBands: [
          { label: 'high', share: 38 },
          { label: 'mid', share: 44 },
        ],
        // A count, not a share: passed through as the catalogue defines it.
        affinities: [{ label: 'fitness', share: 12 }],
      },
      provenance: 'PANEL',
      vendor: 'GEOIQ',
      period: '2026-09',
      radiusM: 500,
    });
  });

  it('is null for a field the account has not mapped, never a guess', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(
      geoiqConfig({ geoiqVariables: { 'footfall.daily': 'w_footfall_daily_avg', 'gender.male': 'w_pop_male_perc', 'gender.female': 'w_pop_female_perc' } }),
    );
    stubVendor(geoiqFixture.response.body);
    const catchment = await geoiqCatchment(12.9758, 77.6061, 500, '2026-09');
    expect(catchment?.footfall.daily).toBe(18421);
    expect(catchment?.demographics.ageBands).toBeNull();
    expect(catchment?.demographics.incomeBands).toBeNull();
    expect(catchment?.demographics.affinities).toBeNull();
  });

  it('leaves percent alone and is null when the answer carries none of the ids', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig());
    stubVendor({ data: { w_pop_male_perc: 53, w_pop_female_perc: 47 } });
    expect((await geoiqCatchment(12.97, 77.6, 500, '2026-09'))?.demographics.gender).toEqual([
      { label: 'male', share: 53 },
      { label: 'female', share: 47 },
    ]);
    stubVendor({ data: {} });
    expect(await geoiqCatchment(12.97, 77.6, 500, '2026-09')).toBeNull();
  });

  it('a refused key is 503, the rate limit 429, GeoIQ down 502', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig());
    stubVendor({ message: 'Forbidden' }, false, 403);
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
    stubVendor({ message: 'Too many' }, false, 429);
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 429 });
    stubVendor({}, false, 500);
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('Azira', () => {
  it('answers 503 without a key or without a base URL — there is no public default host', async () => {
    const fetchMock = stubVendor(aziraFixture.response.body);
    integrations.getEffectiveAudienceConfig.mockResolvedValue(aziraConfig({ aziraApiKey: '' }));
    await expect(aziraCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
    integrations.getEffectiveAudienceConfig.mockResolvedValue(aziraConfig({ aziraBaseUrl: undefined }));
    await expect(aziraCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the circle and the month with the bearer key and the client id, and reads the recorded answer', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(aziraConfig());
    const fetchMock = stubVendor(aziraFixture.response.body);
    const catchment = await aziraCatchment(12.9758, 77.6061, 500, '2026-09');

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.azira.example/v1/insights/footfall');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer azira-key');
    expect(headers['X-Client-Id']).toBe('adx');
    expect(JSON.parse(String(init.body))).toEqual(aziraFixture.request.body);

    expect(catchment).toMatchObject({
      footfall: { daily: 21340, byWeekday: [13.2, 13, 13.4, 13.8, 15.1, 16.9, 14.6] },
      demographics: {
        ageBands: [
          { label: '18-24', share: 19 },
          { label: '25-34', share: 36 },
          { label: '35-44', share: 22 },
          { label: '45-54', share: 13 },
          { label: '55+', share: 10 },
        ],
        gender: [
          { label: 'male', share: 55 },
          { label: 'female', share: 45 },
        ],
        incomeBands: [
          { label: 'high', share: 31 },
          { label: 'mid', share: 49 },
          { label: 'low', share: 20 },
        ],
        affinities: [
          { label: 'Fitness', share: 27 },
          { label: 'Dining', share: 41 },
          { label: 'Shopping', share: 32 },
        ],
      },
      provenance: 'PANEL',
      vendor: 'AZIRA',
      period: '2026-09',
    });
    expect(catchment?.footfall.byHour).toHaveLength(24);
    expect(catchment?.footfall.byHour?.[8]).toBe(6.5);
  });

  it('marks what the answer does not carry as null — a short profile is null, not padded', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(aziraConfig());
    stubVendor({ footfall: { daily_average: 1200, hourly: new Array(23).fill(4) }, demographics: { gender: { male: 0.6, female: 0.4 } } });
    const catchment = await aziraCatchment(12.97, 77.6, 500, '2026-09');
    expect(catchment?.footfall).toEqual({ daily: 1200, byHour: null, byWeekday: null });
    expect(catchment?.demographics).toEqual({
      ageBands: null,
      gender: [
        { label: 'male', share: 60 },
        { label: 'female', share: 40 },
      ],
      incomeBands: null,
      affinities: null,
    });
    stubVendor({});
    expect(await aziraCatchment(12.97, 77.6, 500, '2026-09')).toBeNull();
  });

  it('a refused key is 503, the rate limit 429, Azira down 502', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(aziraConfig());
    stubVendor({ message: 'Unauthorized' }, false, 401);
    await expect(aziraCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 503 });
    stubVendor({}, false, 429);
    await expect(aziraCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 429 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(aziraCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 502 });
  });
});

/**
 * AC-B2 — GeoIQ made to actually work (the live probe of 16 Sep 2026).
 *
 * The public host in the old default (`dataserving.geoiq.io`) does not
 * resolve; GeoIQ's India Data API is `dataserving-in.geoiq.io`. Behind it
 * sits an API Gateway that answers HTTP 200 with the real status inside a
 * JSON STRING under `body` and a `statusCode` beside it — so the adapter
 * unwraps the envelope and the error table runs on the effective status.
 * The docs bound a call to a radius of 100–2000 m and 50 variables, so the
 * radius is clamped and the variables are chunked and merged.
 */
describe('AC-B2: GeoIQ — the India host, the gateway envelope, the call limits', () => {
  const GATEWAY_REFUSAL = {
    body: JSON.stringify({ status: 401, message: 'You are not authorized to access this API. Please contact GeoIQ Administrator for access.', data: null }),
    statusCode: 401,
  };

  it('defaults to the India serving host', async () => {
    const { GEOIQ_DEFAULT_BASE_URL } = await import('../../integrations');
    expect(GEOIQ_DEFAULT_BASE_URL).toBe('https://dataserving-in.geoiq.io/production/v1.0');
  });

  it('unwraps a 200-with-401 envelope into 503 INTEGRATION_NOT_CONFIGURED carrying GeoIQ`s own sentence', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig());
    stubVendor(GATEWAY_REFUSAL, true, 200);
    await expect(geoiqCatchment(12.9755, 77.6068, 500, '2026-09')).rejects.toMatchObject({
      statusCode: 503,
      code: 'INTEGRATION_NOT_CONFIGURED',
      message: expect.stringContaining('You are not authorized to access this API'),
    });
    await expect(geoiqCatchment(12.9755, 77.6068, 500, '2026-09')).rejects.toMatchObject({ message: expect.stringContaining('contact GeoIQ') });
  });

  it('unwraps a 200-with-data envelope into a catchment, and reads an inner 429 / 400 / 500 by the same table', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig());
    stubVendor({ body: JSON.stringify({ status: 200, data: geoiqFixture.response.body.data }), statusCode: 200 }, true, 200);
    const catchment = await geoiqCatchment(12.9758, 77.6061, 500, '2026-09');
    expect(catchment?.footfall.daily).toBe(18421);
    expect(catchment?.demographics.gender).toEqual([
      { label: 'male', share: 53 },
      { label: 'female', share: 47 },
    ]);

    stubVendor({ body: JSON.stringify({ status: 429, message: 'Too Many Requests' }), statusCode: 429 }, true, 200);
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 429 });
    stubVendor({ body: JSON.stringify({ status: 400, message: 'radius out of range' }), statusCode: 400 }, true, 200);
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 400, message: 'radius out of range' });
    stubVendor({ body: JSON.stringify({ status: 500, message: 'boom' }), statusCode: 500 }, true, 200);
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 502 });
    // A plain (un-enveloped) answer with a numeric `status` is read the same way.
    stubVendor({ status: 403, message: 'Forbidden' }, true, 200);
    await expect(geoiqCatchment(12.97, 77.6, 500, '2026-09')).rejects.toMatchObject({ statusCode: 503 });
  });

  it('clamps the radius to 100–2000 m and reports the circle it actually asked about', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig());
    const radiusSent = (fetchMock: ReturnType<typeof stubVendor>): number =>
      JSON.parse(String((fetchMock.mock.calls[0]! as unknown as [string, RequestInit])[1].body)).radius;

    let fetchMock = stubVendor(geoiqFixture.response.body);
    let catchment = await geoiqCatchment(12.97, 77.6, 50, '2026-09');
    expect(radiusSent(fetchMock)).toBe(100);
    expect(catchment?.radiusM).toBe(100);

    fetchMock = stubVendor(geoiqFixture.response.body);
    catchment = await geoiqCatchment(12.97, 77.6, 5_000, '2026-09');
    expect(radiusSent(fetchMock)).toBe(2000);
    expect(catchment?.radiusM).toBe(2000);

    fetchMock = stubVendor(geoiqFixture.response.body);
    catchment = await geoiqCatchment(12.97, 77.6, 750, '2026-09');
    expect(radiusSent(fetchMock)).toBe(750);
    expect(catchment?.radiusM).toBe(750);
  });

  it('asks at most 50 variables a call — chunks the rest and merges the answers', async () => {
    const variables: Record<string, string> = { 'footfall.daily': 'w_footfall_daily_avg' };
    for (let i = 0; i < 59; i += 1) variables['affinity.poi_' + i] = 'w_poi_' + i + '_count';
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig({ geoiqVariables: variables }));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const ids = String(JSON.parse(String(init.body)).variables).split(',');
      const data: Record<string, number> = {};
      ids.forEach((id, i) => {
        data[id] = id === 'w_footfall_daily_avg' ? 18420.6 : i + 1;
      });
      return { ok: true, status: 200, json: async () => ({ data, status: 200 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const catchment = await geoiqCatchment(12.97, 77.6, 500, '2026-09');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sizes = fetchMock.mock.calls.map(([, init]) => String(JSON.parse(String(init.body)).variables).split(',').length);
    expect(sizes).toEqual([50, 10]);
    expect(catchment?.footfall.daily).toBe(18421);
    expect(catchment?.demographics.affinities).toHaveLength(59);
    expect(catchment?.demographics.affinities?.map((a) => a.label)).toContain('poi_58');
  });

  it('a network failure is 502 and the key never appears in the error', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig({ geoiqApiKey: 'super-secret-geoiq-key' }));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND dataserving.geoiq.io'); }));
    const failure = await geoiqCatchment(12.97, 77.6, 500, '2026-09').catch((err: unknown) => err);
    expect(failure).toMatchObject({ statusCode: 502 });
    expect(JSON.stringify(failure)).not.toContain('super-secret');
    expect((failure as Error).message).not.toContain('super-secret');
  });
});

describe('AC-B2: the vendor test behind the card (testAudienceVendor)', () => {
  it('GeoIQ with no key: keyPresent false, nothing asked', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig({ geoiqApiKey: '', geoiqVariables: {} }));
    const fetchMock = stubVendor({});
    const verdict = await testAudienceVendor('GEOIQ');
    expect(verdict).toMatchObject({ vendor: 'GEOIQ', keyPresent: false, variablesMapped: 0, reachable: false, authorized: false, status: null });
    expect(verdict.message).toMatch(/no API key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GeoIQ with a key and no map asks the documented sample variable once, at MG Road, and reads the gateway refusal', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig({ geoiqVariables: {}, catchmentRadiusM: 5_000 }));
    const fetchMock = stubVendor(
      { body: JSON.stringify({ status: 401, message: 'You are not authorized to access this API. Please contact GeoIQ Administrator for access.', data: null }), statusCode: 401 },
      true,
      200,
    );
    const verdict = await testAudienceVendor('GEOIQ');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://dataserving-in.geoiq.io/production/v1.0/getvariables');
    expect(JSON.parse(String(init.body))).toEqual({ lat: AUDIENCE_TEST_POINT.lat, lng: AUDIENCE_TEST_POINT.lng, radius: 2000, variables: 'w_pop_tt' });
    expect(AUDIENCE_TEST_POINT).toEqual({ lat: 12.9755, lng: 77.6068, label: 'MG Road, Bengaluru' });
    expect(verdict).toMatchObject({ vendor: 'GEOIQ', keyPresent: true, variablesMapped: 0, reachable: true, authorized: false, status: 401 });
    expect(verdict.message).toContain('You are not authorized to access this API');
    expect(verdict.message).toContain('contact GeoIQ');
    expect(JSON.stringify(verdict)).not.toContain('geoiq-key');
  });

  it('GeoIQ success names the fields answered and missing and carries the daily footfall sample', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(
      geoiqConfig({ geoiqVariables: { 'footfall.daily': 'w_f', 'gender.male': 'w_m', 'gender.female': 'w_fe' } }),
    );
    stubVendor({ body: JSON.stringify({ status: 200, data: { w_f: 1234.4, w_m: 0.52 } }), statusCode: 200 });
    const verdict = await testAudienceVendor('GEOIQ');
    expect(verdict).toMatchObject({
      vendor: 'GEOIQ',
      keyPresent: true,
      variablesMapped: 3,
      reachable: true,
      authorized: true,
      status: 200,
      fieldsAnswered: ['footfall.daily', 'gender.male'],
      fieldsMissing: ['gender.female'],
      sample: { footfallDaily: 1234 },
    });
  });

  it('GeoIQ with a key and no map, answered: the message carries the sample value and says the map is still to do', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig({ geoiqVariables: {} }));
    stubVendor({ body: JSON.stringify({ status: 200, data: { w_pop_tt: 48213 } }), statusCode: 200 });
    const verdict = await testAudienceVendor('GEOIQ');
    expect(verdict).toMatchObject({ keyPresent: true, reachable: true, authorized: true, status: 200, variablesMapped: 0, fieldsAnswered: [], fieldsMissing: [] });
    expect(verdict.message).toContain('w_pop_tt');
    expect(verdict.message).toContain('48213');
    expect(verdict.sample.footfallDaily).toBeNull();
  });

  it('GeoIQ unreachable: reachable false, status null, a plain message — never a throw', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(geoiqConfig());
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND dataserving.geoiq.io'); }));
    const verdict = await testAudienceVendor('GEOIQ');
    expect(verdict).toMatchObject({ keyPresent: true, reachable: false, authorized: false, status: null, fieldsAnswered: [] });
    expect(verdict.message).toMatch(/could not be reached/i);
    expect(verdict.fieldsMissing).toHaveLength(Object.keys(GEOIQ_VARIABLES).length);
  });

  it('Azira with no configuration is a graceful verdict, not a 503; configured, it reads the recorded answer', async () => {
    integrations.getEffectiveAudienceConfig.mockResolvedValue(aziraConfig({ aziraBaseUrl: undefined }));
    const fetchMock = stubVendor(aziraFixture.response.body);
    const absent = await testAudienceVendor('AZIRA');
    expect(absent).toMatchObject({ vendor: 'AZIRA', keyPresent: true, reachable: false, authorized: false, status: null });
    expect(absent.message).toMatch(/base URL/i);
    expect(fetchMock).not.toHaveBeenCalled();

    integrations.getEffectiveAudienceConfig.mockResolvedValue(aziraConfig());
    const ok = await testAudienceVendor('AZIRA');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ok).toMatchObject({ vendor: 'AZIRA', keyPresent: true, reachable: true, authorized: true, status: 200, sample: { footfallDaily: 21340 } });
    expect(ok.fieldsAnswered).toEqual(expect.arrayContaining(['footfall.daily', 'footfall.byHour', 'footfall.byWeekday', 'age', 'gender', 'income', 'affinity']));
    expect(ok.fieldsMissing).toEqual([]);

    stubVendor({ message: 'Unauthorized' }, false, 401);
    const refused = await testAudienceVendor('AZIRA');
    expect(refused).toMatchObject({ reachable: true, authorized: false, status: 401 });
    expect(JSON.stringify(refused)).not.toContain('azira-key');
  });
});
