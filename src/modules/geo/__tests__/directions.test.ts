import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Q137: GET /geo/directions — the route line for a job, once.
 *
 * Pinned: the query shape ("lat,lng" twice, a mode that defaults to
 * driving); that the answer is the seam's shape with the encoded polyline;
 * that a second read of the same rounded pair within fifteen minutes never
 * reaches the vendor; and that two points eleven metres apart share a key
 * while two a street apart do not.
 */

const { maps, cache } = vi.hoisted(() => ({
  maps: { routeDirections: vi.fn(), DIRECTIONS_MODES: ['driving', 'two_wheeler'] },
  cache: { store: new Map<string, string>() },
}));

vi.mock('../../../shared/maps', () => maps);
vi.mock('../../../shared/cache', () => ({
  readThrough: async (key: string, _ttl: number, load: () => Promise<unknown>) => {
    const hit = cache.store.get(key);
    if (hit !== undefined) return JSON.parse(hit);
    const value = await load();
    cache.store.set(key, JSON.stringify(value));
    return value;
  },
}));

import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { geoRouter } from '../geo.routes';
import { DIRECTIONS_CACHE_TTL_S, directionsCacheKey } from '../directions.service';

function app() {
  const instance = express();
  const api = Router();
  api.use('/geo', geoRouter);
  instance.use('/api/v1', api);
  instance.use(errorHandler);
  return instance;
}

const agent = tokenFor(['AGENT_PUBLISHER'], 'usr_agent');

const ROUTE = {
  polyline: 'abc}~xyz',
  distanceM: 4820,
  durationS: 912,
  steps: [{ instruction: 'Head north', distanceM: 4820, durationS: 912, polyline: null }],
  mode: 'two_wheeler',
  modeUsed: 'two_wheeler',
  provider: 'GOOGLE',
};

beforeEach(() => {
  vi.clearAllMocks();
  cache.store.clear();
  maps.routeDirections.mockResolvedValue(ROUTE);
});

describe('GET /geo/directions', () => {
  it('needs a session', async () => {
    const res = await request(app()).get('/api/v1/geo/directions?from=12.97,77.60&to=12.93,77.62');
    expect(res.status).toBe(401);
  });

  it('answers the polyline, the totals and the steps for the mode asked', async () => {
    const res = await request(app())
      .get('/api/v1/geo/directions?from=12.97,77.60&to=12.93,77.62&mode=two_wheeler')
      .set('Authorization', `Bearer ${agent}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(ROUTE);
    expect(maps.routeDirections).toHaveBeenCalledWith(
      { latitude: 12.97, longitude: 77.6 },
      { latitude: 12.93, longitude: 77.62 },
      'two_wheeler',
    );
  });

  it('defaults the mode to driving', async () => {
    await request(app()).get('/api/v1/geo/directions?from=12.97,77.60&to=12.93,77.62').set('Authorization', `Bearer ${agent}`);
    expect(maps.routeDirections.mock.calls[0]![2]).toBe('driving');
  });

  it('rejects a point that is not "lat,lng", or is off the globe', async () => {
    for (const query of ['from=12.97&to=12.93,77.62', 'from=abc&to=12.93,77.62', 'from=95,77.60&to=12.93,77.62', 'from=12.97,77.60&to=12.93,77.62&mode=walking']) {
      const res = await request(app()).get(`/api/v1/geo/directions?${query}`).set('Authorization', `Bearer ${agent}`);
      expect(res.status, query).toBe(400);
    }
    expect(maps.routeDirections).not.toHaveBeenCalled();
  });

  it('is 404 when the vendor finds no route', async () => {
    maps.routeDirections.mockResolvedValue(null);
    const res = await request(app()).get('/api/v1/geo/directions?from=12.97,77.60&to=12.93,77.62').set('Authorization', `Bearer ${agent}`);
    expect(res.status).toBe(404);
  });

  /* Q137: one call per opened job, never per refresh. */
  it('asks the vendor once for the same rounded pair, however often the screen refreshes', async () => {
    const client = request(app());
    for (let i = 0; i < 3; i += 1) {
      await client.get('/api/v1/geo/directions?from=12.97,77.60&to=12.93,77.62').set('Authorization', `Bearer ${agent}`);
    }
    // Eleven metres of GPS jitter is the same corner.
    await client.get('/api/v1/geo/directions?from=12.97004,77.60004&to=12.93,77.62').set('Authorization', `Bearer ${agent}`);
    expect(maps.routeDirections).toHaveBeenCalledTimes(1);
    // A different mode is a different route.
    await client.get('/api/v1/geo/directions?from=12.97,77.60&to=12.93,77.62&mode=two_wheeler').set('Authorization', `Bearer ${agent}`);
    expect(maps.routeDirections).toHaveBeenCalledTimes(2);
  });

  it('keeps the answer fifteen minutes under the pair rounded to four decimals', () => {
    expect(DIRECTIONS_CACHE_TTL_S).toBe(900);
    const key = directionsCacheKey({ latitude: 12.970041, longitude: 77.600039 }, { latitude: 12.93, longitude: 77.62 }, 'driving');
    expect(key).toBe('geo:directions:driving:12.9700,77.6000>12.9300,77.6200');
    expect(directionsCacheKey({ latitude: 12.971, longitude: 77.6 }, { latitude: 12.93, longitude: 77.62 }, 'driving')).not.toBe(key);
  });
});
