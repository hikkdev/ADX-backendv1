import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The seam itself — G7 (Q101/132): the integrations row picks the vendor,
 * and the client config never carries a server key.
 */

const { integrations, google, mapbox, osm } = vi.hoisted(() => ({
  integrations: { getEffectiveMapsConfig: vi.fn() },
  google: {
    googleMapsProvider: {
      name: 'GOOGLE',
      geocode: vi.fn(async () => ({ formattedAddress: 'from google' })),
      reverse: vi.fn(),
      autocomplete: vi.fn(),
      placeDetails: vi.fn(),
      directions: vi.fn(async () => ({ provider: 'GOOGLE' })),
    },
  },
  mapbox: {
    mapboxMapsProvider: {
      name: 'MAPBOX',
      geocode: vi.fn(async () => ({ formattedAddress: 'from mapbox' })),
      reverse: vi.fn(),
      autocomplete: vi.fn(),
      placeDetails: vi.fn(),
      directions: vi.fn(async () => ({ provider: 'MAPBOX' })),
    },
  },
  osm: {
    osmMapsProvider: {
      name: 'OSM',
      geocode: vi.fn(async () => ({ formattedAddress: 'from osm' })),
      reverse: vi.fn(),
      autocomplete: vi.fn(),
      placeDetails: vi.fn(),
      directions: vi.fn(async () => ({ provider: 'OSM' })),
    },
  },
}));

vi.mock('../../integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integrations')>();
  return { ...actual, ...integrations };
});
vi.mock('../google', () => google);
vi.mock('../mapbox', () => mapbox);
vi.mock('../osm', () => osm);

import { resolveOsmConfig } from '../../integrations';
import { clientTileUrlTemplate, geocodeAddress, getMapsClientConfig, getMapsProvider, routeDirections } from '..';

const osmRow = (over: Record<string, unknown> = {}) => ({
  provider: 'OSM',
  googleBrowserKey: 'browser-key',
  googleServerKey: 'SERVER-KEY',
  mapboxPublicToken: 'pk.public',
  mapboxSecretToken: 'sk.secret',
  osm: resolveOsmConfig({ contactEmail: 'maps@adx.example', ...over }),
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('which vendor answers', () => {
  it('is Google unless ops chose Mapbox', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'GOOGLE' });
    expect((await getMapsProvider()).name).toBe('GOOGLE');
    expect(await geocodeAddress('MG Road')).toEqual({ formattedAddress: 'from google' });
    expect(google.googleMapsProvider.geocode).toHaveBeenCalledWith('MG Road');
    expect(mapbox.mapboxMapsProvider.geocode).not.toHaveBeenCalled();
  });

  it('is Mapbox when the row says so — decided at call time, not at import', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'MAPBOX' });
    expect(await geocodeAddress('MG Road')).toEqual({ formattedAddress: 'from mapbox' });
    const directions = await routeDirections({ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }, 'driving');
    expect(directions).toEqual({ provider: 'MAPBOX' });
    expect(mapbox.mapboxMapsProvider.directions).toHaveBeenCalledWith({ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }, 'driving');
  });

  it('Z-B: is OpenStreetMap when the row says so', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue(osmRow());
    expect((await getMapsProvider()).name).toBe('OSM');
    expect(await geocodeAddress('MG Road')).toEqual({ formattedAddress: 'from osm' });
    expect(await routeDirections({ latitude: 1, longitude: 2 }, { latitude: 3, longitude: 4 }, 'two_wheeler')).toEqual({ provider: 'OSM' });
    expect(google.googleMapsProvider.geocode).not.toHaveBeenCalled();
    expect(mapbox.mapboxMapsProvider.geocode).not.toHaveBeenCalled();
  });
});

describe('the client config (GET /app/maps)', () => {
  it('hands Google clients the browser key and nothing else', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({
      provider: 'GOOGLE',
      googleBrowserKey: 'browser-key',
      googleServerKey: 'SERVER-KEY',
      mapboxPublicToken: 'pk.public',
      mapboxSecretToken: 'sk.secret',
    });
    const cfg = await getMapsClientConfig();
    expect(cfg).toEqual({ provider: 'GOOGLE', googleBrowserKey: 'browser-key' });
    expect(JSON.stringify(cfg)).not.toContain('SERVER-KEY');
    expect(JSON.stringify(cfg)).not.toContain('sk.secret');
  });

  it('hands Mapbox clients the public token and nothing else', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({
      provider: 'MAPBOX',
      googleBrowserKey: 'browser-key',
      googleServerKey: 'SERVER-KEY',
      mapboxPublicToken: 'pk.public',
      mapboxSecretToken: 'sk.secret',
    });
    const cfg = await getMapsClientConfig();
    expect(cfg).toEqual({ provider: 'MAPBOX', mapboxPublicToken: 'pk.public' });
    expect(JSON.stringify(cfg)).not.toContain('sk.secret');
  });

  it('Z-B / AC-B1: hands OSM clients the tile line — template, attribution, max zoom, the public-tiles warning — plus the Mapbox PUBLIC token the phones initialise the SDK with, and no other key of any vendor', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue(osmRow());
    const cfg = await getMapsClientConfig();
    expect(cfg).toEqual({
      provider: 'OSM',
      tileUrlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '(c) OpenStreetMap contributors',
      tileMaxZoom: 19,
      publicTiles: true,
      mapboxPublicToken: 'pk.public',
      engineReady: true,
    });
    for (const secret of ['SERVER-KEY', 'sk.secret', 'browser-key', 'maps@adx.example', 'mapboxSecretToken']) {
      expect(JSON.stringify(cfg), secret).not.toContain(secret);
    }
  });

  it('AC-B1: with no Mapbox public token stored the OSM member says null and engineReady is false — the secret token is never the fallback', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ ...osmRow(), mapboxPublicToken: undefined });
    const cfg = await getMapsClientConfig();
    expect(cfg).toMatchObject({ provider: 'OSM', mapboxPublicToken: null, engineReady: false });
    expect(JSON.stringify(cfg)).not.toContain('sk.secret');
    expect(JSON.stringify(cfg)).not.toContain('mapboxSecretToken');

    // A blank token is no token.
    integrations.getEffectiveMapsConfig.mockResolvedValue({ ...osmRow(), mapboxPublicToken: '   ' });
    expect(await getMapsClientConfig()).toMatchObject({ mapboxPublicToken: null, engineReady: false });
  });

  it('Z-B: on a public-safe tile host the key goes into the template — {key} or ?key= — and publicTiles is off', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue(
      osmRow({ tileUrlTemplate: 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}', tileApiKey: 'mt-browser-key', tileAttribution: '(c) MapTiler (c) OpenStreetMap contributors', tileMaxZoom: 20 }),
    );
    expect(await getMapsClientConfig()).toEqual({
      provider: 'OSM',
      tileUrlTemplate: 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=mt-browser-key',
      tileAttribution: '(c) MapTiler (c) OpenStreetMap contributors',
      tileMaxZoom: 20,
      publicTiles: false,
      mapboxPublicToken: 'pk.public',
      engineReady: true,
    });
    expect(clientTileUrlTemplate({ tileUrlTemplate: 'https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}.png', tileApiKey: 'st key' })).toBe(
      'https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}.png?key=st%20key',
    );
    expect(clientTileUrlTemplate({ tileUrlTemplate: 'https://tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey={key}', tileApiKey: 'tf' })).toBe('https://tile.thunderforest.com/cycle/{z}/{x}/{y}.png?apikey=tf');
    expect(clientTileUrlTemplate({ tileUrlTemplate: 'https://maps.geoapify.com/v1/tile/osm-carto/{z}/{x}/{y}.png?apiKey={key}', tileApiKey: 'ga' })).toBe('https://maps.geoapify.com/v1/tile/osm-carto/{z}/{x}/{y}.png?apiKey=ga');
  });

  it('Z-B: on any other host the key stays on the server — the template is answered as stored', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue(osmRow({ tileUrlTemplate: 'https://tiles.adx.internal/{z}/{x}/{y}.png?key={key}', tileApiKey: 'SERVER-ONLY' }));
    const cfg = await getMapsClientConfig();
    expect(cfg).toMatchObject({ provider: 'OSM', tileUrlTemplate: 'https://tiles.adx.internal/{z}/{x}/{y}.png?key={key}', publicTiles: false });
    expect(JSON.stringify(cfg)).not.toContain('SERVER-ONLY');
  });

  it('is null, not an empty string, while the key is still to come (Q128)', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'GOOGLE', googleBrowserKey: '' });
    expect(await getMapsClientConfig()).toEqual({ provider: 'GOOGLE', googleBrowserKey: null });
  });
});
