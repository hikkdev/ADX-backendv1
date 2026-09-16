import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../../src/app';
import inventory from '../../docs/route-inventory.json';
import { signAccessToken, signImpersonationToken } from '../../src/shared/auth';
import type { RouteEntry } from '../../scripts/collect-routes';

/**
 * Lot A, Q27: an impersonation token can only read.
 *
 * The guard is one branch in `authenticate()`, so the guarantee is
 * topological — but the only convincing way to say it is to drive every write
 * route on the live app and watch each one refuse. These requests never reach
 * a controller (the guard is ahead of every router's own middleware), so the
 * suite touches neither Postgres nor Redis.
 *
 * A 2FA challenge token is checked in the same place, for the same reason: it
 * is signed with the access secret, and nothing but /auth/2fa/* may accept it.
 */
const routes = inventory.routes as RouteEntry[];
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const impersonation = signImpersonationToken('pub_1', ['PUBLISHER'], { sub: 'adm_1', sessionId: 'imp_1' });

function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, 'contract-test-id');
}

function send(route: RouteEntry, token: string) {
  const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
  return request(app)[method](concrete(route.path)).set('Authorization', `Bearer ${token}`);
}

describe('an impersonation token cannot write', () => {
  const writes = routes.filter((r) => WRITE.has(r.method) && r.chain.includes('authenticate'));

  it('found the authenticated write surface', () => {
    expect(writes.length).toBeGreaterThan(80);
  });

  it.each(writes.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s answers 403 IMPERSONATION_READ_ONLY',
    async (_label, route) => {
      const res = await send(route, impersonation);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ success: false, error: { code: 'IMPERSONATION_READ_ONLY' } });
    },
  );

  it('is accepted on a read, where it is the point of the feature', async () => {
    // An ADMIN-only read, so the answer comes from the role guard rather than
    // from a controller — which proves the token got past authenticate()
    // without the test needing a database.
    const read = routes.find((r) => r.method === 'GET' && r.path === '/api/v1/users')!;
    const res = await send(read, impersonation);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('an ordinary token is unaffected on the same routes', async () => {
    const route = routes.find((r) => r.method === 'POST' && r.path === '/api/v1/users')!;
    const res = await send(route, signAccessToken('adm_1', ['ADMIN']));
    expect(res.status).not.toBe(403);
  });
});
