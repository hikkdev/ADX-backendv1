import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The OpenStreetMap adapter of the maps seam — Z-B, with Nominatim, Photon
 * and OSRM stubbed and the Redis bucket faked.
 *
 * What is pinned: the four lookups against recorded fixtures (Nominatim
 * `/search` and `/reverse`, Photon `/api`, OSRM `/route/v1`) become the
 * seam's shapes; the public Nominatim policy is kept — the User-Agent and
 * the contact email travel on every call, the bucket grants ONE request a
 * second on the PUBLIC host and none of that on a host of ops' own; every
 * vendor status becomes the same ApiError vocabulary Google and Mapbox
 * speak (403 / 429 → 429 with the policy sentence, 400 → 400, network →
 * 502, 5xx → 502, empty → null); calls give up at 8 s; a two-wheeler route
 * is answered with the driving profile and says so.
 */

const { integrations, cache } = vi.hoisted(() => ({
  integrations: { getEffectiveMapsConfig: vi.fn(), isPublicNominatim: vi.fn() },
  cache: { redis: { set: vi.fn() } },
}));

vi.mock('../../integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integrations')>();
  return { ...actual, getEffectiveMapsConfig: integrations.getEffectiveMapsConfig };
});
vi.mock('../../cache/redis', () => cache);

import { resolveOsmConfig } from '../../integrations';
import {
  NOMINATIM_BUCKET_KEY,
  NOMINATIM_POLICY_SENTENCE,
  OSM_TIMEOUT_MS,
  autocompletePlaces,
  encodePolyline,
  geocodeAddress,
  placeDetails,
  reverseGeocode,
  routeDirections,
} from '../osm';

function stubOsm(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calledUrl = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => new URL(String(fetchMock.mock.calls[call]![0]));
const calledInit = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => fetchMock.mock.calls[call]![1] as RequestInit;

function osmSelected(osm: Record<string, unknown> = {}) {
  integrations.getEffectiveMapsConfig.mockResolvedValue({
    provider: 'OSM',
    osm: resolveOsmConfig({ contactEmail: 'maps@adx.example', ...osm }),
  });
}

/* Recorded fixtures — the shapes the public services answer, trimmed. */
const NOMINATIM_SEARCH = [
  {
    place_id: 123456,
    licence: 'Data (c) OpenStreetMap contributors, ODbL 1.0.',
    osm_type: 'way',
    osm_id: 987654,
    lat: '12.9758',
    lon: '77.6061',
    category: 'highway',
    type: 'primary',
    display_name: 'MG Road, Shivaji Nagar, Bengaluru, Bangalore North, Bengaluru Urban, Karnataka, 560001, India',
    name: 'MG Road',
    address: {
      road: 'MG Road',
      suburb: 'Shivaji Nagar',
      city: 'Bengaluru',
      county: 'Bangalore North',
      state_district: 'Bengaluru Urban',
      state: 'Karnataka',
      postcode: '560001',
      country: 'India',
      country_code: 'in',
    },
  },
];

const NOMINATIM_REVERSE = {
  place_id: 222,
  osm_type: 'node',
  osm_id: 4455,
  lat: '18.5204',
  lon: '73.8567',
  display_name: 'Shaniwar Wada, Shaniwar Peth, Pune, Pune City, Maharashtra, 411030, India',
  name: 'Shaniwar Wada',
  address: { tourism: 'Shaniwar Wada', suburb: 'Shaniwar Peth', town: 'Pune', state: 'Maharashtra', postcode: '411030', country_code: 'in' },
};

const PHOTON = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [77.6061, 12.9758] },
      properties: { osm_type: 'W', osm_id: 987654, osm_key: 'highway', name: 'MG Road', district: 'Shivaji Nagar', city: 'Bengaluru', state: 'Karnataka', postcode: '560001', countrycode: 'IN' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [73.8567, 18.5204] },
      properties: { osm_type: 'N', osm_id: 4455, name: 'MG Road Metro', city: 'Pune', state: 'Maharashtra', countrycode: 'IN' },
    },
    // A feature with no OSM id cannot be picked later; it is dropped.
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'Nowhere' } },
  ],
};

const OSRM = {
  code: 'Ok',
  routes: [
    {
      distance: 3412.7,
      duration: 512.3,
      geometry: { type: 'LineString', coordinates: [[77.6061, 12.9758], [77.61, 12.98], [77.62, 12.99]] },
      legs: [
        {
          steps: [
            { distance: 1200.4, duration: 180.2, name: 'MG Road', maneuver: { type: 'depart', modifier: 'right' }, geometry: { coordinates: [[77.6061, 12.9758], [77.61, 12.98]] } },
            { distance: 2212.3, duration: 332.1, name: 'Brigade Road', maneuver: { type: 'turn', modifier: 'left' }, geometry: { coordinates: [[77.61, 12.98], [77.62, 12.99]] } },
            { distance: 0, duration: 0, name: '', maneuver: { type: 'arrive' }, geometry: { coordinates: [[77.62, 12.99]] } },
          ],
        },
      ],
    },
  ],
  waypoints: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  cache.redis.set.mockResolvedValue('OK');
  osmSelected();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('geocoding an address (Nominatim /search)', () => {
  it('asks the public host with the policy headers and maps the first hit to the seam shape', async () => {
    const fetchMock = stubOsm(NOMINATIM_SEARCH);
    const place = await geocodeAddress('MG Road, Bengaluru');
    expect(place).toEqual({
      formattedAddress: 'MG Road, Shivaji Nagar, Bengaluru, Bangalore North, Bengaluru Urban, Karnataka, 560001, India',
      latitude: 12.9758,
      longitude: 77.6061,
      placeId: 'W987654',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
    });
    const url = calledUrl(fetchMock);
    expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(url.searchParams.get('q')).toBe('MG Road, Bengaluru');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('countrycodes')).toBe('in');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(url.searchParams.get('addressdetails')).toBe('1');
    expect(url.searchParams.get('email')).toBe('maps@adx.example');
    const init = calledInit(fetchMock);
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('ADX/1.0.0 (maps@adx.example)');
    expect((init.headers as Record<string, string>)['Accept-Language']).toBe('en');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(OSM_TIMEOUT_MS).toBe(8_000);
  });

  it('sends the User-Agent ops wrote when there is one', async () => {
    osmSelected({ userAgent: 'ADX Maps Bot/2 (ops@adx.example)' });
    const fetchMock = stubOsm(NOMINATIM_SEARCH);
    await geocodeAddress('MG Road');
    expect((calledInit(fetchMock).headers as Record<string, string>)['User-Agent']).toBe('ADX Maps Bot/2 (ops@adx.example)');
  });

  it('is null for an empty array — asked correctly, nothing there', async () => {
    stubOsm([]);
    expect(await geocodeAddress('nowhere at all')).toBeNull();
  });

  it('files a town under city and falls back to the district where that is all Nominatim knows', async () => {
    stubOsm([{ ...NOMINATIM_SEARCH[0], address: { town: 'Pune', state: 'Maharashtra' } }]);
    expect((await geocodeAddress('Pune'))?.city).toBe('Pune');
    stubOsm([{ ...NOMINATIM_SEARCH[0], address: { state_district: 'Bengaluru Urban', state: 'Karnataka' } }]);
    expect((await geocodeAddress('somewhere'))?.city).toBe('Bengaluru Urban');
  });

  it('goes to the Nominatim ops pointed at, base slash and all', async () => {
    osmSelected({ nominatimBaseUrl: 'https://nominatim.adx.internal/' });
    const fetchMock = stubOsm(NOMINATIM_SEARCH);
    await geocodeAddress('MG Road');
    expect(calledUrl(fetchMock).origin + calledUrl(fetchMock).pathname).toBe('https://nominatim.adx.internal/search');
  });
});

describe('reverse geocoding (Nominatim /reverse)', () => {
  it('maps the one object Nominatim answers', async () => {
    const fetchMock = stubOsm(NOMINATIM_REVERSE);
    const place = await reverseGeocode({ latitude: 18.5204, longitude: 73.8567 });
    expect(place).toMatchObject({ formattedAddress: expect.stringContaining('Shaniwar Wada'), latitude: 18.5204, longitude: 73.8567, placeId: 'N4455', city: 'Pune', state: 'Maharashtra', postalCode: '411030' });
    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe('/reverse');
    expect(url.searchParams.get('lat')).toBe('18.5204');
    expect(url.searchParams.get('lon')).toBe('73.8567');
  });

  it('is null for open sea (Nominatim answers 200 with an error field)', async () => {
    stubOsm({ error: 'Unable to geocode' });
    expect(await reverseGeocode({ latitude: 0, longitude: 0 })).toBeNull();
  });
});

describe('search as you type (Photon /api)', () => {
  it('asks Photon in English inside India, biased to `near`, and answers predictions without coordinates', async () => {
    const fetchMock = stubOsm(PHOTON);
    const predictions = await autocompletePlaces('MG Ro', { near: { latitude: 12.97, longitude: 77.6 }, sessionToken: 'ignored' });
    expect(predictions).toEqual([
      { placeId: 'W987654', description: 'MG Road, Shivaji Nagar, Bengaluru, Karnataka, 560001', mainText: 'MG Road', secondaryText: 'Shivaji Nagar, Bengaluru, Karnataka, 560001' },
      { placeId: 'N4455', description: 'MG Road Metro, Pune, Maharashtra', mainText: 'MG Road Metro', secondaryText: 'Pune, Maharashtra' },
    ]);
    expect(JSON.stringify(predictions)).not.toContain('77.6061');
    const url = calledUrl(fetchMock);
    expect(url.origin + url.pathname).toBe('https://photon.komoot.io/api');
    expect(url.searchParams.get('q')).toBe('MG Ro');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('bbox')).toBe('68.1,6.5,97.4,35.7');
    expect(url.searchParams.get('lat')).toBe('12.97');
    expect(url.searchParams.get('lon')).toBe('77.6');
    // Photon is not Nominatim: the bucket is not touched.
    expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('is an empty list, not an error, for nothing', async () => {
    stubOsm({ type: 'FeatureCollection', features: [] });
    expect(await autocompletePlaces('zzzz')).toEqual([]);
  });
});

describe('a chosen prediction (Nominatim /lookup)', () => {
  it('looks the OSM id up and answers the place with its name', async () => {
    const fetchMock = stubOsm(NOMINATIM_SEARCH);
    const place = await placeDetails('W987654', 'session-1');
    expect(place).toMatchObject({ placeId: 'W987654', name: 'MG Road', latitude: 12.9758, city: 'Bengaluru' });
    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe('/lookup');
    expect(url.searchParams.get('osm_ids')).toBe('W987654');
  });

  it('is null for a dead id, and for an id that is not an OSM id at all — without a call', async () => {
    stubOsm([]);
    expect(await placeDetails('N1')).toBeNull();
    const fetchMock = stubOsm([]);
    expect(await placeDetails('ChIJ-google-id')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('directions (OSRM /route/v1)', () => {
  it('asks for the full GeoJSON line with steps and answers the seam shape with a precision-5 polyline', async () => {
    const fetchMock = stubOsm(OSRM);
    const directions = await routeDirections({ latitude: 12.9758, longitude: 77.6061 }, { latitude: 12.99, longitude: 77.62 }, 'driving');
    expect(directions).toMatchObject({ distanceM: 3413, durationS: 512, mode: 'driving', modeUsed: 'driving', provider: 'OSM' });
    expect(directions!.polyline).toBe(encodePolyline([[77.6061, 12.9758], [77.61, 12.98], [77.62, 12.99]]));
    expect(directions!.steps).toEqual([
      { instruction: 'Head right onto MG Road', distanceM: 1200, durationS: 180, polyline: encodePolyline([[77.6061, 12.9758], [77.61, 12.98]]) },
      { instruction: 'Turn left onto Brigade Road', distanceM: 2212, durationS: 332, polyline: encodePolyline([[77.61, 12.98], [77.62, 12.99]]) },
      { instruction: 'Arrive', distanceM: 0, durationS: 0, polyline: encodePolyline([[77.62, 12.99]]) },
    ]);
    const url = calledUrl(fetchMock);
    expect(url.origin + url.pathname).toBe('https://router.project-osrm.org/route/v1/driving/77.6061,12.9758;77.62,12.99');
    expect(url.searchParams.get('overview')).toBe('full');
    expect(url.searchParams.get('geometries')).toBe('geojson');
    expect(url.searchParams.get('steps')).toBe('true');
    // OSRM is not Nominatim: the bucket is not touched.
    expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('encodes the way Google does, so the agent app keeps one decoder', () => {
    // Google's own worked example: (38.5, -120.2), (40.7, -120.95), (43.252, -126.453) → _p~iF~ps|U_ulLnnqC_mqNvxq`@
    expect(encodePolyline([[-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252]])).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('Q137: a two-wheeler route is answered with the driving profile and says so', async () => {
    const fetchMock = stubOsm(OSRM);
    const directions = await routeDirections({ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }, 'two_wheeler');
    expect(directions).toMatchObject({ mode: 'two_wheeler', modeUsed: 'driving' });
    expect(calledUrl(fetchMock).pathname).toContain('/route/v1/driving/');
  });

  it('is null when OSRM finds no route (HTTP 400 with the NoRoute code)', async () => {
    stubOsm({ code: 'NoRoute', message: 'Impossible route between points' }, false, 400);
    expect(await routeDirections({ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }, 'driving')).toBeNull();
  });

  it('is the caller’s 400 for a request OSRM rejects, and a 502 for a code it should not answer', async () => {
    stubOsm({ code: 'InvalidQuery', message: 'Query string malformed' }, false, 400);
    await expect(routeDirections({ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }, 'driving')).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
    stubOsm({ code: 'Weird' });
    await expect(routeDirections({ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }, 'driving')).rejects.toMatchObject({ statusCode: 502 });
  });

  it('goes to the router ops pointed at', async () => {
    osmSelected({ osrmBaseUrl: 'https://osrm.adx.internal' });
    const fetchMock = stubOsm(OSRM);
    await routeDirections({ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }, 'driving');
    expect(calledUrl(fetchMock).origin).toBe('https://osrm.adx.internal');
  });
});

describe('the public Nominatim bucket — one request a second', () => {
  it('takes the second’s token before calling the public host; the second call within the second is 429 without a call', async () => {
    const fetchMock = stubOsm(NOMINATIM_SEARCH);
    cache.redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await geocodeAddress('first');
    await expect(geocodeAddress('second')).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS', message: NOMINATIM_POLICY_SENTENCE });
    expect(cache.redis.set).toHaveBeenCalledTimes(2);
    expect(cache.redis.set).toHaveBeenCalledWith(NOMINATIM_BUCKET_KEY, '1', 'PX', 1000, 'NX');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('meters /reverse and /lookup the same way — they are the same host', async () => {
    stubOsm(NOMINATIM_REVERSE);
    cache.redis.set.mockResolvedValue(null);
    await expect(reverseGeocode({ latitude: 1, longitude: 2 })).rejects.toMatchObject({ statusCode: 429 });
    await expect(placeDetails('N1')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('is not applied to a Nominatim of ops’ own — both calls go through and Redis is never asked', async () => {
    osmSelected({ nominatimBaseUrl: 'https://nominatim.adx.internal' });
    const fetchMock = stubOsm(NOMINATIM_SEARCH);
    await geocodeAddress('first');
    await geocodeAddress('second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cache.redis.set).not.toHaveBeenCalled();
  });

  it('lets the call through when Redis is down — a lost token is not a lost lookup', async () => {
    cache.redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const fetchMock = stubOsm(NOMINATIM_SEARCH);
    expect(await geocodeAddress('MG Road')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the error vocabulary', () => {
  it('a 403 or 429 from Nominatim is 429 with the policy sentence — there is no key to refuse', async () => {
    stubOsm({ message: 'Access blocked' }, false, 403);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS', message: NOMINATIM_POLICY_SENTENCE });
    stubOsm({}, false, 429);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 429, code: 'TOO_MANY_REQUESTS' });
  });

  it('a 400 from the vendor is the caller’s 400', async () => {
    stubOsm({ message: 'Bad query' }, false, 400);
    await expect(geocodeAddress('')).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' });
  });

  it('a network failure (or the 8 s timeout firing) is 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }));
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 502, code: 'INTERNAL_ERROR' });
  });

  it('a 5xx is 502 — the vendor is down', async () => {
    stubOsm({}, false, 503);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 502 });
    stubOsm({}, false, 502);
    await expect(autocompletePlaces('MG')).rejects.toMatchObject({ statusCode: 502 });
  });

  it('never answers 503 INTEGRATION_NOT_CONFIGURED — OSM has no key to be missing', async () => {
    osmSelected({ contactEmail: undefined });
    stubOsm(NOMINATIM_SEARCH);
    await expect(geocodeAddress('MG Road')).resolves.not.toBeNull();
  });
});
