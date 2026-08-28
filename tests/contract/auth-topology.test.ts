import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app';
import inventory from '../../docs/route-inventory.json';
import { ALL_ROLES, guardedRoles, tokenFor } from '../helpers/tokens';
import type { RouteEntry } from '../../scripts/collect-routes';

/**
 * Characterises the authentication and authorisation topology of every route.
 *
 * These assertions never reach a controller — authenticate() and requireRole()
 * short-circuit first — so the suite touches neither Postgres nor Redis and
 * writes nothing. That makes it safe to run anywhere while still pinning the
 * guarantee that matters most during the module migration: a route that needs
 * a token today must still need one afterwards, guarded by the same roles.
 */
const routes = inventory.routes as RouteEntry[];

/** `/api/v1/orders/:id/approve` -> `/api/v1/orders/contract-test-id/approve` */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, 'contract-test-id');
}

function send(route: RouteEntry, token?: string) {
  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  const req = request(app)[method](concrete(route.path));
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
}

const authenticated = routes.filter((r) => r.chain.includes('authenticate'));
const roleGuarded = routes.filter((r) => guardedRoles(r.chain) !== null);

describe('authentication topology', () => {
  it('covers most of the surface (fails loudly if the inventory goes empty)', () => {
    expect(authenticated.length).toBeGreaterThan(120);
    expect(roleGuarded.length).toBeGreaterThan(80);
  });

  it.each(authenticated.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s rejects a missing token with 401 UNAUTHORIZED',
    async (_label, route) => {
      const res = await send(route);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    },
  );

  it.each(authenticated.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s rejects a malformed token with 401 UNAUTHORIZED',
    async (_label, route) => {
      const res = await send(route, 'not-a-real-jwt');
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    },
  );
});

describe('authorisation topology', () => {
  const cases = roleGuarded
    .map((route) => {
      const allowed = guardedRoles(route.chain) ?? [];
      const denied = ALL_ROLES.find((role) => !allowed.includes(role));
      return denied
        ? ([`${route.method} ${route.path} (denies ${denied})`, route, denied] as const)
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  it('found a denied role for every guarded route', () => {
    expect(cases).toHaveLength(roleGuarded.length);
  });

  it.each(cases)('%s with 403 FORBIDDEN', async (_label, route, denied) => {
    const res = await send(route, tokenFor([denied]));
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
  });
});

describe('public routes stay public', () => {
  const publicRoutes = routes.filter((r) => !r.chain.includes('authenticate'));

  it('still includes the endpoints that are deliberately unauthenticated', () => {
    const paths = publicRoutes.map((r) => r.path);
    expect(paths).toContain('/api/v1/health');
    expect(paths).toContain('/api/v1/config');
    expect(paths).toContain('/api/v1/listings/:id/similar');
    expect(paths).toContain('/api/v1/qr/:qrId/image.png');
    expect(paths).toContain('/api/v1/webhooks/digio');
    expect(paths).toContain('/api/v1/users/bootstrap-admin');
  });

  it('GET /api/v1/health answers without a token', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { status: 'ok', service: 'adx-backend' },
    });
  });

  it('PUT /api/v1/config is gated by the admin secret or an ADMIN token', async () => {
    const noCredentials = await request(app).put('/api/v1/config').send({ flows: {}, enums: {} });
    expect(noCredentials.status).toBe(401);

    const nonAdmin = await request(app)
      .put('/api/v1/config')
      .set('Authorization', `Bearer ${tokenFor(['PUBLISHER'])}`)
      .send({ flows: {}, enums: {} });
    expect(nonAdmin.status).toBe(403);
  });

  it('unknown routes return 404 NOT_FOUND', async () => {
    const res = await request(app).get('/api/v1/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });
});
