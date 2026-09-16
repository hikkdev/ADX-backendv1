import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * G10: the kill switches bite — Lot G (answer 144).
 *
 * `requireFeature(key)` sits on the routers a switched-off feature must
 * stop, and every key named here is a registered feature. This drives the
 * live app with every one of those flags off and watches each probe answer
 * 503 FEATURE_OFF `{ key }` before any controller runs: the flags table is
 * a fake here (every registered key off, no rollout), so the suite touches
 * neither Postgres nor Redis. The on-path — the guard letting a request
 * through, the rollout rules on the token — is the feature-flags module's
 * own test.
 *
 * Two of the switches are conditional (`requireFeatureWhen`): an ordinary
 * listing or campaign write is not gated, only the one that opts into the
 * feature — instant booking on the listing, a second market on the
 * campaign — so the probe for those carries the opting body.
 */

const { repository } = vi.hoisted(() => ({
  repository: { listState: vi.fn(), list: vi.fn(), find: vi.fn(), update: vi.fn(), changes: vi.fn(), createRegistered: vi.fn(), updateRegistered: vi.fn(), foldLegacy: vi.fn() },
}));

vi.mock('../../src/modules/feature-flags/prisma-feature-flags.repository', () => ({ prismaFeatureFlagsRepository: repository }));
vi.mock('../../src/shared/cache/read-through', () => ({
  readThrough: async (_key: string, _ttl: number, load: () => Promise<unknown>) => load(),
  invalidate: async () => undefined,
}));

import { app } from '../../src/app';
import inventory from '../../docs/route-inventory.json';
import type { RouteEntry } from '../../scripts/collect-routes';
import { declaredFeatures } from '../../src/shared/features';
import { tokenFor } from '../../src/shared/testing';

/* The committed inventory, the way the other contract suites read the chain
 * (the collector patches the Router before the app loads, and the app is
 * loaded here); tests/architecture/route-inventory.test.ts keeps it current. */
const routes = inventory.routes as RouteEntry[];

/** The keys the kill switch must bite, and one probe per key that reaches its guard. */
const PROBES: { key: string; label: string; send: () => request.Test }[] = [
  {
    key: 'marketplace.instant-booking',
    label: 'POST /listings opting into instant booking',
    send: () => request(app).post('/api/v1/listings').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'])}`).send({ title: 'x', instantBooking: true }),
  },
  {
    key: 'campaigns.multi-market',
    label: 'POST /campaigns naming a second market',
    send: () => request(app).post('/api/v1/campaigns').set('Authorization', `Bearer ${tokenFor(['ADVERTISER'])}`).send({ targetMarkets: ['Pune', 'Mumbai'] }),
  },
  {
    key: 'publisher.spot-insights',
    label: 'GET /publishers/me/bookings/:orderId/insights',
    send: () => request(app).get('/api/v1/publishers/me/bookings/contract-test-id/insights').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'])}`),
  },
  {
    key: 'payments.gateways',
    label: 'POST /payments/intents',
    send: () => request(app).post('/api/v1/payments/intents').set('Authorization', `Bearer ${tokenFor(['ADVERTISER'])}`).send({}),
  },
  {
    key: 'campaigns.landing-pages',
    label: 'GET /campaigns/:id/landing-page',
    send: () => request(app).get('/api/v1/campaigns/contract-test-id/landing-page').set('Authorization', `Bearer ${tokenFor(['ADVERTISER'])}`),
  },
  {
    key: 'marketplace.reviews',
    label: 'GET /reviews (the desk)',
    send: () => request(app).get('/api/v1/reviews').set('Authorization', `Bearer ${tokenFor(['ADMIN'])}`),
  },
  {
    key: 'marketplace.reviews',
    label: 'GET /listings/browse/:listingId/reviews (the party side)',
    send: () => request(app).get('/api/v1/listings/browse/contract-test-id/reviews').set('Authorization', `Bearer ${tokenFor(['ADVERTISER'])}`),
  },
  {
    key: 'comms.announcements',
    label: 'POST /announcements/:id/send',
    send: () => request(app).post('/api/v1/announcements/contract-test-id/send').set('Authorization', `Bearer ${tokenFor(['ADMIN'])}`).send({}),
  },
  {
    key: 'users.data-export',
    label: 'POST /users/me/data-export',
    send: () => request(app).post('/api/v1/users/me/data-export').set('Authorization', `Bearer ${tokenFor(['ADVERTISER'])}`).send({}),
  },
  {
    key: 'comms.push',
    label: 'PUT /users/me/devices',
    send: () => request(app).put('/api/v1/users/me/devices').set('Authorization', `Bearer ${tokenFor(['ADVERTISER'])}`).send({}),
  },
];

const KEYS = [...new Set(PROBES.map((probe) => probe.key))];

/** Every registered feature, off, no rollout — the state the probes run against. */
function everyFeatureOff() {
  return declaredFeatures().map((declaration) => ({
    key: declaration.key,
    enabled: false,
    rolloutPercent: 100,
    variant: null,
    variants: [...declaration.variants],
    rollout: null,
    surfaces: [...declaration.surfaces],
    source: 'REGISTERED',
  }));
}

const GATE = /^requireFeature(?:When)?\((.+)\)$/;

function gatedKeys(route: RouteEntry): string[] {
  return route.chain.map((entry) => GATE.exec(entry)?.[1]).filter((key): key is string => Boolean(key));
}

describe('the kill switches (G10)', () => {
  beforeAll(() => {
    repository.listState.mockImplementation(async () => everyFeatureOff());
  });

  it('names only registered features', () => {
    const declared = new Set(declaredFeatures().map((declaration) => declaration.key));
    for (const key of KEYS) expect(declared.has(key), `${key} is not a registered feature`).toBe(true);
  });

  it.each(KEYS)('%s guards at least one mounted route', (key) => {
    const guarded = routes.filter((route) => gatedKeys(route).includes(key)).map((route) => `${route.method} ${route.path}`);
    expect(guarded.length, `no route carries requireFeature(${key})`).toBeGreaterThan(0);
  });

  it.each(PROBES.map((probe) => [probe.label, probe] as const))('%s answers 503 FEATURE_OFF when the flag is off', async (_label, probe) => {
    const res = await probe.send();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: { code: 'FEATURE_OFF', details: { key: probe.key } } });
  });

  it('a conditional switch leaves the ordinary write alone — the flag is not even read', async () => {
    repository.listState.mockClear();
    // No instantBooking in the body: the listing write goes past the switch to its own validation.
    const res = await request(app).post('/api/v1/listings').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'])}`).send({});
    expect(res.status).not.toBe(503);
    expect(repository.listState).not.toHaveBeenCalled();
  });
});
