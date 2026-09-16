import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * G7 (Q101/132): GET /app/maps — the phones' and the console's map config.
 *
 * Pinned: a session is needed (the key is restricted on the vendor's side,
 * but it is still quota somebody pays for); the answer names the vendor and
 * carries ONLY the browser key / public token; and the server key never
 * appears in the body whatever the row holds.
 */

const { integrations } = vi.hoisted(() => ({
  integrations: { getEffectiveMapsConfig: vi.fn() },
}));

vi.mock('../../../shared/integrations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/integrations')>();
  return { ...actual, ...integrations };
});
vi.mock('../prisma-app-config.repository', () => ({ prismaAppConfigRepository: {} }));

import { errorHandler } from '../../../shared/errors';
import { resolveOsmConfig } from '../../../shared/integrations';
import { tokenFor } from '../../../shared/testing';
import { appStatusRouter } from '../app-config.routes';

function app() {
  const instance = express();
  const api = Router();
  api.use('/app', appStatusRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');

beforeEach(() => {
  vi.clearAllMocks();
  integrations.getEffectiveMapsConfig.mockResolvedValue({
    provider: 'GOOGLE',
    googleBrowserKey: 'AIza-browser',
    googleServerKey: 'AIza-SERVER',
    mapboxPublicToken: 'pk.public',
    mapboxSecretToken: 'sk.secret',
  });
});

describe('GET /app/maps', () => {
  it('needs a session', async () => {
    expect((await request(app()).get('/api/v1/app/maps')).status).toBe(401);
  });

  it('answers Google with the browser key and never the server key', async () => {
    const res = await request(app()).get('/api/v1/app/maps').set('Authorization', `Bearer ${agent}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ provider: 'GOOGLE', googleBrowserKey: 'AIza-browser' });
    expect(res.text).not.toContain('AIza-SERVER');
    expect(res.text).not.toContain('sk.secret');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers Mapbox with the public token and never the secret one', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({
      provider: 'MAPBOX',
      googleServerKey: 'AIza-SERVER',
      mapboxPublicToken: 'pk.public',
      mapboxSecretToken: 'sk.secret',
    });
    const res = await request(app()).get('/api/v1/app/maps').set('Authorization', `Bearer ${agent}`);
    expect(res.body.data).toEqual({ provider: 'MAPBOX', mapboxPublicToken: 'pk.public' });
    expect(res.text).not.toContain('sk.secret');
    expect(res.text).not.toContain('AIza-SERVER');
  });

  it('AC-B1: answers OSM with the tile line AND the Mapbox PUBLIC token the phones initialise the SDK with — engineReady true — and never the secret token', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({
      provider: 'OSM',
      googleServerKey: 'AIza-SERVER',
      mapboxPublicToken: 'pk.public',
      mapboxSecretToken: 'sk.secret',
      osm: resolveOsmConfig({ contactEmail: 'maps@adx.example' }),
    });
    const res = await request(app()).get('/api/v1/app/maps').set('Authorization', `Bearer ${agent}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      provider: 'OSM',
      tileUrlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      tileAttribution: '(c) OpenStreetMap contributors',
      tileMaxZoom: 19,
      publicTiles: true,
      mapboxPublicToken: 'pk.public',
      engineReady: true,
    });
    expect(res.body.data).not.toHaveProperty('mapboxSecretToken');
    expect(res.text).not.toContain('sk.secret');
    expect(res.text).not.toContain('AIza-SERVER');
    expect(res.text).not.toContain('maps@adx.example');
  });

  it('AC-B1: answers OSM with a null token and engineReady false while no Mapbox public token is stored — the secret is not a fallback', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({
      provider: 'OSM',
      googleServerKey: 'AIza-SERVER',
      mapboxSecretToken: 'sk.secret',
      osm: resolveOsmConfig({ contactEmail: 'maps@adx.example' }),
    });
    const res = await request(app()).get('/api/v1/app/maps').set('Authorization', `Bearer ${agent}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: 'OSM', mapboxPublicToken: null, engineReady: false, publicTiles: true });
    expect(res.body.data).not.toHaveProperty('mapboxSecretToken');
    expect(res.text).not.toContain('sk.secret');
  });

  it('is null while the browser key is still to come (Q128)', async () => {
    integrations.getEffectiveMapsConfig.mockResolvedValue({ provider: 'GOOGLE', googleServerKey: 'AIza-SERVER' });
    const res = await request(app()).get('/api/v1/app/maps').set('Authorization', `Bearer ${agent}`);
    expect(res.body.data).toEqual({ provider: 'GOOGLE', googleBrowserKey: null });
  });
});
