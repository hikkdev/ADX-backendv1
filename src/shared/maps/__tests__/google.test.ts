import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Google adapter of the maps seam (G7 — moved here from
 * `modules/geo/__tests__/geo.test.ts` with the client), with Google stubbed.
 *
 * What is pinned: that no key answers 503 without touching the network; that
 * Google's status vocabulary becomes ApiErrors a screen can act on; that
 * address components become the city / state / postcode the listing wants;
 * and that a search's session token travels on every call, which is the
 * difference between one bill per search and one per keystroke.
 */

const { integrations } = vi.hoisted(() => ({
  integrations: { getEffectiveMapsConfig: vi.fn() },
}));

vi.mock('../../integrations', () => integrations);

import { autocompletePlaces, geocodeAddress, placeDetails, reverseGeocode, routeDirections } from '../google';

function stubGoogle(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calledUrl = (fetchMock: ReturnType<typeof vi.fn>) =>
  new URL(String(fetchMock.mock.calls[0]![0]));

const BENGALURU = {
  status: 'OK',
  results: [
    {
      formatted_address: '12, MG Road, Bengaluru, Karnataka 560001, India',
      place_id: 'ChIJbengaluru',
      geometry: { location: { lat: 12.9758, lng: 77.6061 } },
      address_components: [
        { long_name: '12', short_name: '12', types: ['street_number'] },
        { long_name: 'MG Road', short_name: 'MG Rd', types: ['route'] },
        { long_name: 'Bengaluru', short_name: 'Bengaluru', types: ['locality', 'political'] },
        { long_name: 'Bengaluru Urban', short_name: 'Bengaluru Urban', types: ['administrative_area_level_2', 'political'] },
        { long_name: 'Karnataka', short_name: 'KA', types: ['administrative_area_level_1', 'political'] },
        { long_name: '560001', short_name: '560001', types: ['postal_code'] },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'GOOGLE', googleServerKey: 'server-key' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('with no key', () => {
  it('answers 503 and never calls Google', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'GOOGLE', googleServerKey: '' });
    const fetchMock = stubGoogle(BENGALURU);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({
      statusCode: 503,
      code: 'INTEGRATION_NOT_CONFIGURED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('geocoding an address', () => {
  it('turns Google components into the fields a listing wants', async () => {
    const fetchMock = stubGoogle(BENGALURU);
    const place = await geocodeAddress('12 MG Road Bengaluru');
    expect(place).toEqual({
      formattedAddress: '12, MG Road, Bengaluru, Karnataka 560001, India',
      latitude: 12.9758,
      longitude: 77.6061,
      placeId: 'ChIJbengaluru',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
    });
    const url = calledUrl(fetchMock);
    expect(url.searchParams.get('key')).toBe('server-key');
    expect(url.searchParams.get('region')).toBe('in');
  });

  /* Google files some Indian addresses under the district with no locality. */
  it('falls back to the district when there is no locality', async () => {
    const result = structuredClone(BENGALURU);
    result.results[0]!.address_components = result.results[0]!.address_components.filter(
      (c) => !c.types.includes('locality'),
    );
    stubGoogle(result);
    expect((await geocodeAddress('somewhere'))?.city).toBe('Bengaluru Urban');
  });

  it('is null, not an error, when nothing matches', async () => {
    stubGoogle({ status: 'ZERO_RESULTS', results: [] });
    expect(await geocodeAddress('zzzz')).toBeNull();
  });

  it('prefers the integrations row over the environment key', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'GOOGLE', googleServerKey: 'from-the-console' });
    const fetchMock = stubGoogle(BENGALURU);
    await geocodeAddress('MG Road');
    expect(calledUrl(fetchMock).searchParams.get('key')).toBe('from-the-console');
  });
});

describe('what Google says goes wrong', () => {
  it('quota is 429', async () => {
    stubGoogle({ status: 'OVER_QUERY_LIMIT', results: [] });
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('a refused key is the same 503 as no key', async () => {
    stubGoogle({ status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.', results: [] });
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({
      statusCode: 503,
      code: 'INTEGRATION_NOT_CONFIGURED',
    });
  });

  it('a malformed request is the caller`s 400', async () => {
    stubGoogle({ status: 'INVALID_REQUEST', error_message: 'Missing address', results: [] });
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('Google being down is a 502, not a 500', async () => {
    stubGoogle({}, false, 503);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 502 });
  });

  it('an unreachable Google is a 502 too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('reverse geocoding', () => {
  it('sends the point as latlng', async () => {
    const fetchMock = stubGoogle(BENGALURU);
    const place = await reverseGeocode({ latitude: 12.9758, longitude: 77.6061 });
    expect(place?.city).toBe('Bengaluru');
    expect(calledUrl(fetchMock).searchParams.get('latlng')).toBe('12.9758,77.6061');
  });
});

describe('place search', () => {
  it('is India-only and carries the session token on the search and the pick', async () => {
    const fetchMock = stubGoogle({
      status: 'OK',
      predictions: [
        {
          place_id: 'ChIJgym',
          description: 'FitZone Gym, Koramangala, Bengaluru',
          structured_formatting: { main_text: 'FitZone Gym', secondary_text: 'Koramangala, Bengaluru' },
        },
      ],
    });
    const predictions = await autocompletePlaces('fitz', {
      sessionToken: 'sess-1234567890',
      near: { latitude: 12.93, longitude: 77.62 },
    });
    expect(predictions).toEqual([
      {
        placeId: 'ChIJgym',
        description: 'FitZone Gym, Koramangala, Bengaluru',
        mainText: 'FitZone Gym',
        secondaryText: 'Koramangala, Bengaluru',
      },
    ]);
    const search = calledUrl(fetchMock);
    expect(search.searchParams.get('components')).toBe('country:in');
    expect(search.searchParams.get('sessiontoken')).toBe('sess-1234567890');
    expect(search.searchParams.get('location')).toBe('12.93,77.62');
    expect(search.searchParams.get('radius')).toBe('50000');

    const detailsMock = stubGoogle({
      status: 'OK',
      result: {
        name: 'FitZone Gym',
        formatted_address: 'Koramangala, Bengaluru, Karnataka 560034, India',
        place_id: 'ChIJgym',
        geometry: { location: { lat: 12.9352, lng: 77.6245 } },
        address_components: BENGALURU.results[0]!.address_components,
      },
    });
    const picked = await placeDetails('ChIJgym', 'sess-1234567890');
    expect(picked).toMatchObject({ name: 'FitZone Gym', latitude: 12.9352, city: 'Bengaluru' });
    expect(calledUrl(detailsMock).searchParams.get('sessiontoken')).toBe('sess-1234567890');
  });

  it('is an empty list, not an error, when nothing matches', async () => {
    stubGoogle({ status: 'ZERO_RESULTS', predictions: [] });
    expect(await autocompletePlaces('zzzz')).toEqual([]);
  });

  it('is null for a place id Google no longer knows', async () => {
    stubGoogle({ status: 'NOT_FOUND', result: null });
    expect(await placeDetails('ChIJgone')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Q137: directions through the Routes API                            */
/* ------------------------------------------------------------------ */

describe('directions', () => {
  const ROUTE = {
    routes: [
      {
        distanceMeters: 4820,
        duration: '912s',
        polyline: { encodedPolyline: 'abc}~xyz' },
        legs: [
          {
            steps: [
              { distanceMeters: 300, staticDuration: '60s', navigationInstruction: { maneuver: 'DEPART', instructions: 'Head north on MG Road' }, polyline: { encodedPolyline: 'ab' } },
              { distanceMeters: 4520, staticDuration: '852s', navigationInstruction: { maneuver: 'TURN_LEFT', instructions: 'Turn left onto Brigade Road' } },
            ],
          },
        ],
      },
    ],
  };

  it('posts the two-wheeler mode with the field mask and answers the seam shape', async () => {
    const fetchMock = stubGoogle(ROUTE);
    const directions = await routeDirections({ latitude: 12.97, longitude: 77.60 }, { latitude: 12.93, longitude: 77.62 }, 'two_wheeler');
    expect(directions).toEqual({
      polyline: 'abc}~xyz',
      distanceM: 4820,
      durationS: 912,
      steps: [
        { instruction: 'Head north on MG Road', distanceM: 300, durationS: 60, polyline: 'ab' },
        { instruction: 'Turn left onto Brigade Road', distanceM: 4520, durationS: 852, polyline: null },
      ],
      mode: 'two_wheeler',
      modeUsed: 'two_wheeler',
      provider: 'GOOGLE',
    });
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe('server-key');
    expect(headers['X-Goog-FieldMask']).toContain('routes.polyline.encodedPolyline');
    expect(JSON.parse(String(init.body))).toMatchObject({ travelMode: 'TWO_WHEELER', units: 'METRIC' });
  });

  it('is null, not an error, when Google finds no route', async () => {
    stubGoogle({ routes: [] });
    expect(await routeDirections({ latitude: 12.97, longitude: 77.60 }, { latitude: 12.93, longitude: 77.62 }, 'driving')).toBeNull();
  });

  it('a refused key on the Routes API is the same 503', async () => {
    stubGoogle({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'API key not valid' } }, false, 403);
    await expect(routeDirections({ latitude: 12.97, longitude: 77.60 }, { latitude: 12.93, longitude: 77.62 }, 'driving')).rejects.toMatchObject({
      statusCode: 503,
      code: 'INTEGRATION_NOT_CONFIGURED',
    });
  });

  it('quota on the Routes API is 429', async () => {
    stubGoogle({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, false, 429);
    await expect(routeDirections({ latitude: 12.97, longitude: 77.60 }, { latitude: 12.93, longitude: 77.62 }, 'driving')).rejects.toMatchObject({ statusCode: 429 });
  });
});
