import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G7 (Q101/132/137, Q109) / Y-B — the `maps` and `audience` sections.
 *
 * Pinned: both sections are on the GET with their provider switch and every
 * key masked (a browser key is public on a phone and still a credential on
 * a settings screen); the pre-G7 `googleMaps.apiKey` row shows through as
 * the server key; the PUT validates the provider and the GeoIQ variable
 * map; a change of provider is named in the trail with before and after,
 * and the trail never carries a key. Y-B: `providers` is the enabled set
 * and `policy` the blend policy, both on the GET with the defaults filled
 * in; a legacy one-vendor row reads as a one-element set; a legacy
 * `provider` in a PUT becomes the set and the old key is cleared; the
 * policy is strict and merged over the stored one; a change of set or
 * policy is audited with the before and after.
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

beforeEach(() => {
  vi.clearAllMocks();
  config.getIntegrationsConfig.mockResolvedValue({});
  config.updateIntegrationsConfig.mockResolvedValue({});
});

describe('GET /integrations — maps and audience', () => {
  it('defaults to Google and NONE with nothing configured', async () => {
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.maps.provider).toBe('GOOGLE');
    expect(res.body.data.audience).toMatchObject({ provider: 'NONE', providers: [], geoiqVariables: {}, catchmentRadiusM: 500 });
    expect(res.body.data.audience.policy).toEqual({
      footfall: { primary: 'AZIRA', fallback: true, blend: 'AVERAGE' },
      demographics: { primary: 'GEOIQ', fallback: true },
      affinities: { primary: 'GEOIQ', fallback: true },
    });
    expect(res.body.data.audience.geoiqBaseUrl).toContain('geoiq.io');
  });

  it('Y-B: a legacy one-vendor row reads as a one-element set; a stored partial policy is filled from the defaults', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ audience: { provider: 'GEOIQ', policy: { footfall: { blend: 'PRIMARY' } } } });
    const legacy = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(legacy.body.data.audience).toMatchObject({ provider: 'GEOIQ', providers: ['GEOIQ'] });
    expect(legacy.body.data.audience.policy.footfall).toEqual({ primary: 'AZIRA', fallback: true, blend: 'PRIMARY' });

    config.getIntegrationsConfig.mockResolvedValue({ audience: { provider: 'GEOIQ', providers: ['AZIRA', 'GEOIQ'] } });
    const both = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    // The set wins over the legacy key; `provider` is the footfall primary in force for the old screen.
    expect(both.body.data.audience).toMatchObject({ provider: 'AZIRA', providers: ['GEOIQ', 'AZIRA'] });
  });

  it('masks every key and token, and shows the pre-G7 Google row through as the server key', async () => {
    config.getIntegrationsConfig.mockResolvedValue({
      googleMaps: { apiKey: 'AIzaLEGACY-server-1234' },
      maps: { provider: 'MAPBOX', googleBrowserKey: 'AIzaBROWSER-5678', mapboxPublicToken: 'pk.public-abcd', mapboxSecretToken: 'sk.secret-wxyz' },
      audience: { provider: 'GEOIQ', geoiqApiKey: 'geoiq-key-9999', aziraApiKey: 'azira-key-1111', aziraClientId: 'adx', geoiqVariables: { 'footfall.daily': 'w_footfall' }, catchmentRadiusM: 750 },
    });
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.maps).toMatchObject({
      provider: 'MAPBOX',
      googleBrowserKey: '••••5678',
      googleServerKey: '••••1234',
      mapboxPublicToken: '••••abcd',
      mapboxSecretToken: '••••wxyz',
    });
    // Z-B: the OSM sub-section is always on the read, defaults filled in.
    expect(Object.keys(res.body.data.maps).sort()).toEqual(['googleBrowserKey', 'googleServerKey', 'mapboxPublicToken', 'mapboxSecretToken', 'osm', 'provider']);
    expect(res.body.data.audience).toMatchObject({
      provider: 'GEOIQ',
      providers: ['GEOIQ'],
      geoiqApiKey: '••••9999',
      aziraApiKey: '••••1111',
      aziraClientId: 'adx',
      geoiqVariables: { 'footfall.daily': 'w_footfall' },
      catchmentRadiusM: 750,
    });
    for (const secret of ['AIzaLEGACY', 'AIzaBROWSER', 'pk.public', 'sk.secret', 'geoiq-key', 'azira-key']) {
      expect(res.text, secret).not.toContain(secret);
    }
  });
});

describe('PUT /integrations — maps', () => {
  it('writes the section and names a provider change in the trail without a key', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ maps: { provider: 'GOOGLE' } });
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'maps', patch: { provider: 'MAPBOX', mapboxSecretToken: 'sk.new-secret' } });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('maps', { provider: 'MAPBOX', mapboxSecretToken: 'sk.new-secret' });
    const change = audit.logActivity.mock.calls.find((call) => call[1] === 'MAPS_PROVIDER_CHANGED');
    expect(change).toBeDefined();
    expect(change![2]).toMatchObject({ targetType: 'AppConfig', targetId: 'integrations', module: 'integrations' });
    expect(JSON.stringify({ diff: change![2].diff, metadata: change![2].metadata })).not.toContain('sk.new-secret');
    expect(JSON.stringify(change![2].diff)).toContain('MAPBOX');
  });

  it('rejects a vendor that is not behind the seam', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'maps', patch: { provider: 'HERE' } });
    expect(res.status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });

  it('a key rotation alone is not a provider change', async () => {
    await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'maps', patch: { googleServerKey: 'AIza-rotated' } });
    expect(audit.logActivity.mock.calls.map((call) => call[1])).toEqual(['INTEGRATION_CONFIG_UPDATED']);
  });
});

describe('PUT /integrations — audience', () => {
  it('writes a legacy `provider` as the enabled set with the variable map and the radius, and names the switch in the trail', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({
        section: 'audience',
        patch: { provider: 'GEOIQ', geoiqApiKey: 'geoiq-new', geoiqVariables: { 'footfall.daily': 'w_footfall', 'age.18_24': 'w_age_18_24', 'affinity.fitness': 'w_gym' }, catchmentRadiusM: 800 },
      });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('audience', expect.objectContaining({ providers: ['GEOIQ'], catchmentRadiusM: 800 }));
    expect(config.updateIntegrationsConfig.mock.calls[0]![1]).not.toHaveProperty('provider');
    const change = audit.logActivity.mock.calls.find((call) => call[1] === 'AUDIENCE_PROVIDER_CHANGED');
    expect(change).toBeDefined();
    expect(change![2]).toMatchObject({ targetType: 'AppConfig', targetId: 'integrations', module: 'integrations' });
    expect(JSON.stringify(change![2].diff)).toContain('GEOIQ');
    expect(JSON.stringify({ diff: change![2].diff, metadata: change![2].metadata })).not.toContain('geoiq-new');
  });

  it('Y-B: writes both vendors and a partial policy merged over the stored one and the defaults; clears the legacy key; audits the before and after', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ audience: { provider: 'GEOIQ', policy: { demographics: { fallback: false } } } });
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'audience', patch: { providers: ['AZIRA', 'GEOIQ'], policy: { footfall: { blend: 'PRIMARY' } } } });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('audience', {
      providers: ['GEOIQ', 'AZIRA'],
      provider: null,
      policy: {
        footfall: { primary: 'AZIRA', fallback: true, blend: 'PRIMARY' },
        demographics: { primary: 'GEOIQ', fallback: false },
        affinities: { primary: 'GEOIQ', fallback: true },
      },
    });
    const change = audit.logActivity.mock.calls.find((call) => call[1] === 'AUDIENCE_PROVIDER_CHANGED');
    expect(change).toBeDefined();
    const diff = JSON.stringify(change![2].diff);
    expect(diff).toContain('AZIRA');
    expect(diff).toContain('PRIMARY');
    expect(diff).toContain('AVERAGE');
  });

  it('Y-B: an empty set switches the audience off; a policy naming a vendor off the seam or a stray key is refused', async () => {
    const off = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'audience', patch: { providers: [] } });
    expect(off.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('audience', { providers: [] });
    for (const patch of [
      { providers: ['NEAR'] },
      { policy: { footfall: { primary: 'NONE' } } },
      { policy: { footfall: { blend: 'MAX' } } },
      { policy: { retail: { primary: 'GEOIQ' } } },
      { policy: { footfall: { primary: 'GEOIQ', weight: 2 } } },
    ]) {
      const bad = await request(app()).put('/api/v1/integrations').set('Authorization', `Bearer ${admin}`).send({ section: 'audience', patch });
      expect(bad.status, JSON.stringify(patch)).toBe(400);
    }
    expect(config.updateIntegrationsConfig).toHaveBeenCalledTimes(1);
  });

  it('a key rotation alone is not a provider change', async () => {
    await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'audience', patch: { aziraApiKey: 'azira-rotated' } });
    expect(audit.logActivity.mock.calls.map((call) => call[1])).toEqual(['INTEGRATION_CONFIG_UPDATED']);
  });

  it('refuses a variable map naming a field the seam does not have, and a radius off the scale', async () => {
    const bad = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'audience', patch: { geoiqVariables: { 'footfall.hourly': 'w_x' } } });
    expect(bad.status).toBe(400);
    const far = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'audience', patch: { catchmentRadiusM: 50_000 } });
    expect(far.status).toBe(400);
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });
});


/**
 * Z-B (the owner, 15 Sep 2026): OpenStreetMap beside Google and Mapbox.
 *
 * Pinned: the `osm` sub-section is on the GET with the defaults filled in
 * (the public Nominatim, the demo OSRM, Photon, the public tile server with
 * `publicTiles: true`, the attribution, max zoom 19) and the tile key
 * masked; a legacy row without `osm` still parses to the same; the PUT
 * merges the sub-object over the stored one (a base URL alone keeps the
 * email), is strict, and writes `publicTiles` from the template; selecting
 * OSM without a contact email is refused 400 and nothing is written; a
 * switch to OSM is named in the trail.
 */
describe('Z-B: OpenStreetMap on the maps section', () => {
  it('GET: a legacy row without `osm` reads the defaults, public tiles flagged', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ maps: { provider: 'GOOGLE', googleServerKey: 'AIza-1234' } });
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.maps.provider).toBe('GOOGLE');
    expect(res.body.data.maps.osm).toEqual({
      nominatimBaseUrl: 'https://nominatim.openstreetmap.org',
      osrmBaseUrl: 'https://router.project-osrm.org',
      photonBaseUrl: 'https://photon.komoot.io',
      contactEmail: null,
      userAgent: 'ADX/1.0.0 (no contact email set)',
      tileUrlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '(c) OpenStreetMap contributors',
      tileMaxZoom: 19,
      tileApiKey: null,
      publicTiles: true,
    });
  });

  it('GET: a stored OSM row shows through with the tile key masked and publicTiles off on a provider host', async () => {
    config.getIntegrationsConfig.mockResolvedValue({
      maps: {
        provider: 'OSM',
        osm: { contactEmail: 'maps@adx.example', nominatimBaseUrl: 'https://nominatim.adx.internal/', tileUrlTemplate: 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}', tileApiKey: 'maptiler-key-9876', tileMaxZoom: 20, publicTiles: false },
      },
    });
    const res = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(res.body.data.maps.provider).toBe('OSM');
    expect(res.body.data.maps.osm).toMatchObject({
      nominatimBaseUrl: 'https://nominatim.adx.internal',
      contactEmail: 'maps@adx.example',
      userAgent: 'ADX/1.0.0 (maps@adx.example)',
      tileUrlTemplate: 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key={key}',
      tileApiKey: '••••9876',
      tileMaxZoom: 20,
      publicTiles: false,
    });
    expect(res.text).not.toContain('maptiler-key');
  });

  it('AC-B1 GET: under OSM the section says what the phones need — phoneEngine { engine: MAPBOX, tokenPresent } — with the token itself still masked and never the secret', async () => {
    config.getIntegrationsConfig.mockResolvedValue({
      maps: { provider: 'OSM', mapboxPublicToken: 'pk.public-abcd', mapboxSecretToken: 'sk.secret-wxyz', osm: { contactEmail: 'maps@adx.example' } },
    });
    const withToken = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(withToken.status).toBe(200);
    expect(withToken.body.data.maps.phoneEngine).toEqual({ engine: 'MAPBOX', tokenPresent: true });
    expect(withToken.body.data.maps.mapboxPublicToken).toBe('••••abcd');
    expect(withToken.text).not.toContain('pk.public');
    expect(withToken.text).not.toContain('sk.secret');

    // No public token stored (and none in the test env): the phones cannot initialise the SDK yet. A secret alone does not count.
    config.getIntegrationsConfig.mockResolvedValue({ maps: { provider: 'OSM', mapboxSecretToken: 'sk.secret-wxyz', osm: { contactEmail: 'maps@adx.example' } } });
    const without = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(without.body.data.maps.phoneEngine).toEqual({ engine: 'MAPBOX', tokenPresent: false });

    // Not on OSM: the console draws Google / Mapbox with the vendor's own key, no phone-engine note.
    config.getIntegrationsConfig.mockResolvedValue({ maps: { provider: 'GOOGLE' } });
    const google = await request(app()).get('/api/v1/integrations').set('Authorization', `Bearer ${admin}`);
    expect(google.body.data.maps).not.toHaveProperty('phoneEngine');
  });

  it('PUT: selecting OSM without a contact email is refused 400 and nothing is written', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'maps', patch: { provider: 'OSM' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('osm.contactEmail');
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
    expect(audit.logActivity).not.toHaveBeenCalled();
  });

  it('PUT: selecting OSM with the email writes the sub-object with publicTiles, names the switch in the trail', async () => {
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'maps', patch: { provider: 'OSM', osm: { contactEmail: 'maps@adx.example' } } });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('maps', { provider: 'OSM', osm: { contactEmail: 'maps@adx.example', publicTiles: true } });
    const change = audit.logActivity.mock.calls.find((call) => call[1] === 'MAPS_PROVIDER_CHANGED');
    expect(change).toBeDefined();
    expect(JSON.stringify(change![2].diff)).toContain('OSM');
  });

  it('PUT: the sub-object is merged over the stored one — a tile change keeps the email, and a provider host clears publicTiles', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ maps: { provider: 'OSM', osm: { contactEmail: 'maps@adx.example', publicTiles: true } } });
    const res = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'maps', patch: { osm: { tileUrlTemplate: 'https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}.png', tileApiKey: 'stadia-key', tileAttribution: '(c) Stadia Maps (c) OpenStreetMap contributors', userAgent: '' } } });
    expect(res.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('maps', {
      osm: {
        contactEmail: 'maps@adx.example',
        tileUrlTemplate: 'https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}.png',
        tileApiKey: 'stadia-key',
        tileAttribution: '(c) Stadia Maps (c) OpenStreetMap contributors',
        publicTiles: false,
      },
    });
    // The trail carries the fields, never the key; a key rotation alone is not a provider change.
    const updated = audit.logActivity.mock.calls.find((call) => call[1] === 'INTEGRATION_CONFIG_UPDATED');
    expect(JSON.stringify(updated![3])).not.toContain('stadia-key');
    expect(audit.logActivity.mock.calls.map((call) => call[1])).toEqual(['INTEGRATION_CONFIG_UPDATED']);
  });

  it('PUT: clearing the email while on OSM is refused; clearing it while on Google is fine', async () => {
    config.getIntegrationsConfig.mockResolvedValue({ maps: { provider: 'OSM', osm: { contactEmail: 'maps@adx.example' } } });
    const onOsm = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'maps', patch: { osm: { contactEmail: null } } });
    expect(onOsm.status).toBe(400);
    config.getIntegrationsConfig.mockResolvedValue({ maps: { provider: 'GOOGLE', osm: { contactEmail: 'maps@adx.example' } } });
    const onGoogle = await request(app())
      .put('/api/v1/integrations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ section: 'maps', patch: { osm: { contactEmail: null } } });
    expect(onGoogle.status).toBe(200);
    expect(config.updateIntegrationsConfig).toHaveBeenCalledWith('maps', { osm: { publicTiles: true } });
  });

  it('PUT: the sub-object is strict — a stray key, a bad email, a template without {z}/{x}/{y}, a zoom off the scale, publicTiles from the screen', async () => {
    for (const osm of [
      { contactEmail: 'maps@adx.example', weird: 1 },
      { contactEmail: 'not-an-email' },
      { contactEmail: 'maps@adx.example', tileUrlTemplate: 'https://tiles.example.com/{z}/{x}.png' },
      { contactEmail: 'maps@adx.example', nominatimBaseUrl: 'ftp://nominatim' },
      { contactEmail: 'maps@adx.example', tileMaxZoom: 30 },
      { contactEmail: 'maps@adx.example', publicTiles: false },
    ]) {
      const bad = await request(app()).put('/api/v1/integrations').set('Authorization', `Bearer ${admin}`).send({ section: 'maps', patch: { provider: 'OSM', osm } });
      expect(bad.status, JSON.stringify(osm)).toBe(400);
    }
    expect(config.updateIntegrationsConfig).not.toHaveBeenCalled();
  });
});
