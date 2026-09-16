import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Mapbox adapter of the maps seam — G7 (Q101), with Mapbox stubbed.
 *
 * What is pinned: that no secret token is 503 without touching the network
 * and that the PUBLIC token is never what this adapter spends; that Mapbox's
 * HTTP vocabulary becomes the same ApiErrors Google's does; that `[lng, lat]`
 * and `context` become the seam's place shape; that a search's session token
 * travels on the suggest and the retrieve; and (Q137) that a two-wheeler
 * route is answered with the driving profile and says so in `modeUsed`.
 */

const { integrations } = vi.hoisted(() => ({
  integrations: { getEffectiveMapsConfig: vi.fn() },
}));

vi.mock('../../integrations', () => integrations);

import { autocompletePlaces, geocodeAddress, placeDetails, reverseGeocode, routeDirections } from '../mapbox';

function stubMapbox(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn(async () => ({ ok, status, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calledUrl = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => new URL(String(fetchMock.mock.calls[call]![0]));

const BENGALURU = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'dXJuOm1ieGFkcjpiZW5nYWx1cnU',
      geometry: { type: 'Point', coordinates: [77.6061, 12.9758] },
      properties: {
        mapbox_id: 'dXJuOm1ieGFkcjpiZW5nYWx1cnU',
        feature_type: 'address',
        name: '12 MG Road',
        full_address: '12 MG Road, Bengaluru, Karnataka 560001, India',
        place_formatted: 'Bengaluru, Karnataka 560001, India',
        coordinates: { longitude: 77.6061, latitude: 12.9758 },
        context: {
          address: { name: '12 MG Road', address_number: '12', street_name: 'MG Road' },
          street: { name: 'MG Road' },
          postcode: { name: '560001' },
          place: { name: 'Bengaluru' },
          district: { name: 'Bengaluru Urban' },
          region: { name: 'Karnataka', region_code: 'KA' },
          country: { name: 'India', country_code: 'IN' },
        },
      },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  integrations.getEffectiveMapsConfig.mockResolvedValue({
    provider: 'MAPBOX',
    mapboxSecretToken: 'sk.secret',
    mapboxPublicToken: 'pk.public',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('with no secret token', () => {
  it('answers 503 and never calls Mapbox — the public token is not a substitute', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'MAPBOX', mapboxPublicToken: 'pk.public' });
    const fetchMock = stubMapbox(BENGALURU);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('geocoding an address (Geocoding v6)', () => {
  it('turns a feature into the fields a listing wants, India-only, with the secret token', async () => {
    const fetchMock = stubMapbox(BENGALURU);
    const place = await geocodeAddress('12 MG Road Bengaluru');
    expect(place).toEqual({
      formattedAddress: '12 MG Road, Bengaluru, Karnataka 560001, India',
      latitude: 12.9758,
      longitude: 77.6061,
      placeId: 'dXJuOm1ieGFkcjpiZW5nYWx1cnU',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
    });
    const url = calledUrl(fetchMock);
    expect(url.origin + url.pathname).toBe('https://api.mapbox.com/search/geocode/v6/forward');
    expect(url.searchParams.get('q')).toBe('12 MG Road Bengaluru');
    expect(url.searchParams.get('country')).toBe('in');
    expect(url.searchParams.get('access_token')).toBe('sk.secret');
  });

  it('falls back to the district when there is no place', async () => {
    const result = structuredClone(BENGALURU) as typeof BENGALURU;
    delete (result.features[0]!.properties.context as { place?: unknown }).place;
    stubMapbox(result);
    expect((await geocodeAddress('somewhere'))?.city).toBe('Bengaluru Urban');
  });

  it('is null, not an error, when nothing matches', async () => {
    stubMapbox({ type: 'FeatureCollection', features: [] });
    expect(await geocodeAddress('zzzz')).toBeNull();
  });
});

describe('what Mapbox says goes wrong', () => {
  it('a refused token is the same 503 as no token', async () => {
    stubMapbox({ message: 'Not Authorized - Invalid Token' }, false, 401);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 503, code: 'INTEGRATION_NOT_CONFIGURED' });
  });

  it('the rate limit is 429', async () => {
    stubMapbox({ message: 'Too Many Requests' }, false, 429);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 429 });
  });

  it('a malformed request is the caller`s 400', async () => {
    stubMapbox({ message: 'Query too long' }, false, 422);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('Mapbox being down is a 502, and so is an unreachable Mapbox', async () => {
    stubMapbox({}, false, 503);
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 502 });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    await expect(geocodeAddress('MG Road')).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('reverse geocoding', () => {
  it('sends the point as longitude / latitude, in that order', async () => {
    const fetchMock = stubMapbox(BENGALURU);
    const place = await reverseGeocode({ latitude: 12.9758, longitude: 77.6061 });
    expect(place?.city).toBe('Bengaluru');
    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe('/search/geocode/v6/reverse');
    expect(url.searchParams.get('longitude')).toBe('77.6061');
    expect(url.searchParams.get('latitude')).toBe('12.9758');
  });
});

describe('place search (Search Box v1)', () => {
  it('is India-only and carries the session token on the suggest and the retrieve', async () => {
    const fetchMock = stubMapbox({
      suggestions: [
        {
          name: 'FitZone Gym',
          mapbox_id: 'dXJuOm1ieHBvaTpmaXR6b25l',
          feature_type: 'poi',
          full_address: 'FitZone Gym, Koramangala, Bengaluru, Karnataka 560034, India',
          place_formatted: 'Koramangala, Bengaluru, Karnataka 560034, India',
        },
      ],
      attribution: '© Mapbox',
    });
    const predictions = await autocompletePlaces('fitz', {
      sessionToken: 'sess-1234567890',
      near: { latitude: 12.93, longitude: 77.62 },
    });
    expect(predictions).toEqual([
      {
        placeId: 'dXJuOm1ieHBvaTpmaXR6b25l',
        description: 'FitZone Gym, Koramangala, Bengaluru, Karnataka 560034, India',
        mainText: 'FitZone Gym',
        secondaryText: 'Koramangala, Bengaluru, Karnataka 560034, India',
      },
    ]);
    const search = calledUrl(fetchMock);
    expect(search.pathname).toBe('/search/searchbox/v1/suggest');
    expect(search.searchParams.get('country')).toBe('in');
    expect(search.searchParams.get('session_token')).toBe('sess-1234567890');
    expect(search.searchParams.get('proximity')).toBe('77.62,12.93');

    const retrieveMock = stubMapbox({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [77.6245, 12.9352] },
          properties: {
            name: 'FitZone Gym',
            mapbox_id: 'dXJuOm1ieHBvaTpmaXR6b25l',
            feature_type: 'poi',
            full_address: 'FitZone Gym, Koramangala, Bengaluru, Karnataka 560034, India',
            coordinates: { longitude: 77.6245, latitude: 12.9352 },
            context: BENGALURU.features[0]!.properties.context,
          },
        },
      ],
    });
    const picked = await placeDetails('dXJuOm1ieHBvaTpmaXR6b25l', 'sess-1234567890');
    expect(picked).toMatchObject({ name: 'FitZone Gym', latitude: 12.9352, longitude: 77.6245, city: 'Bengaluru' });
    const retrieve = calledUrl(retrieveMock);
    expect(retrieve.pathname).toBe('/search/searchbox/v1/retrieve/dXJuOm1ieHBvaTpmaXR6b25l');
    expect(retrieve.searchParams.get('session_token')).toBe('sess-1234567890');
  });

  it('is an empty list, not an error, when nothing matches', async () => {
    stubMapbox({ suggestions: [], attribution: '© Mapbox' });
    expect(await autocompletePlaces('zzzz')).toEqual([]);
  });

  it('is null for a place id Mapbox no longer knows', async () => {
    stubMapbox({ message: 'Not Found' }, false, 404);
    expect(await placeDetails('dXJuOmdvbmU')).toBeNull();
  });
});

describe('directions (Directions v5)', () => {
  const ROUTE = {
    code: 'Ok',
    routes: [
      {
        distance: 4819.6,
        duration: 911.7,
        geometry: 'abc}~xyz',
        legs: [
          {
            steps: [
              { distance: 300.2, duration: 60.1, geometry: 'ab', maneuver: { type: 'depart', instruction: 'Drive north on MG Road.' } },
              { distance: 4519.4, duration: 851.6, geometry: 'cd', maneuver: { type: 'turn', instruction: 'Turn left onto Brigade Road.' } },
            ],
          },
        ],
      },
    ],
    waypoints: [],
  };

  it('answers a two-wheeler request with the driving profile and says so', async () => {
    const fetchMock = stubMapbox(ROUTE);
    const directions = await routeDirections({ latitude: 12.97, longitude: 77.6 }, { latitude: 12.93, longitude: 77.62 }, 'two_wheeler');
    expect(directions).toEqual({
      polyline: 'abc}~xyz',
      distanceM: 4820,
      durationS: 912,
      steps: [
        { instruction: 'Drive north on MG Road.', distanceM: 300, durationS: 60, polyline: 'ab' },
        { instruction: 'Turn left onto Brigade Road.', distanceM: 4519, durationS: 852, polyline: 'cd' },
      ],
      mode: 'two_wheeler',
      modeUsed: 'driving',
      provider: 'MAPBOX',
    });
    const url = calledUrl(fetchMock);
    expect(url.pathname).toBe('/directions/v5/mapbox/driving/77.6,12.97;77.62,12.93');
    expect(url.searchParams.get('geometries')).toBe('polyline');
    expect(url.searchParams.get('steps')).toBe('true');
    expect(url.searchParams.get('overview')).toBe('full');
  });

  it('is null, not an error, when Mapbox finds no route', async () => {
    stubMapbox({ code: 'NoRoute', message: 'No route found', routes: [] });
    expect(await routeDirections({ latitude: 12.97, longitude: 77.6 }, { latitude: 12.93, longitude: 77.62 }, 'driving')).toBeNull();
  });

  it('an unexpected code is a 502', async () => {
    stubMapbox({ code: 'ProfileNotFound', message: 'Unknown profile' });
    await expect(routeDirections({ latitude: 12.97, longitude: 77.6 }, { latitude: 12.93, longitude: 77.62 }, 'driving')).rejects.toMatchObject({ statusCode: 502 });
  });
});
