import express, { Router } from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectRoutes, type RouteEntry } from '../../scripts/collect-routes';
import { guardedRoles, tokenFor } from '../../src/shared/testing';

const prisma = vi.hoisted(() => ({
  activityLog: { create: vi.fn() },
}));

vi.mock('../../src/shared/database/prisma', () => ({ prisma }));

import { auditAdminWrites, logActivity } from '../../src/shared/audit';
import { authenticate, requireRole } from '../../src/shared/auth';
import { requestId } from '../../src/shared/http';

/**
 * Lot A, Q28: every ADMIN write leaves a row.
 *
 * The universal tap (shared/audit/audit-admin-writes.ts) is one app-level
 * middleware, so the guarantee is topological: it must sit ahead of every
 * router, under the request id that stamps its rows. The live route tree is
 * walked here rather than the JSON snapshot so the assertion cannot go stale
 * against a regenerated inventory.
 */
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

describe('admin-write audit coverage', () => {
  let routes: RouteEntry[];
  let adminWrites: RouteEntry[];

  beforeAll(async () => {
    routes = await collectRoutes();
    adminWrites = routes.filter((r) => WRITE.has(r.method) && (guardedRoles(r.chain) ?? []).includes('ADMIN'));
  });

  it('finds the admin write surface (fails loudly if the guard naming changes)', () => {
    expect(adminWrites.length).toBeGreaterThan(80);
  });

  it('stamps a request id first on every route, before anything can log or fail', () => {
    for (const route of routes) {
      expect(route.chain[0], `${route.method} ${route.path}`).toBe('requestId');
    }
  });

  it('mounts the audit tap ahead of the router on every ADMIN-guarded write route', () => {
    for (const route of adminWrites) {
      const tap = route.chain.indexOf('auditAdminWrites');
      const auth = route.chain.indexOf('authenticate');
      const label = `${route.method} ${route.path}`;
      expect(tap, label).toBeGreaterThanOrEqual(0);
      expect(auth, label).toBeGreaterThanOrEqual(0);
      expect(tap, label).toBeLessThan(auth);
    }
  });

  it('keeps the readiness probe public and the audit reads ADMIN-only', () => {
    const ready = routes.find((r) => r.path === '/api/v1/health/ready');
    expect(ready?.chain).not.toContain('authenticate');
    const audit = routes.filter((r) => r.path.startsWith('/api/v1/audit'));
    expect(audit.map((r) => r.path)).toEqual([
      '/api/v1/audit',
      '/api/v1/audit/export.csv',
      '/api/v1/audit/targets/:targetType/:targetId',
    ]);
    for (const route of audit) expect(guardedRoles(route.chain)).toEqual(['ADMIN']);
  });
});

/**
 * The behavioural half, on the same stack create-app assembles — id, parser,
 * tap, then a router guarded the way every module router is — so a 2xx from
 * an ADMIN produces exactly one row and nothing else does.
 */
describe('a sample ADMIN write through the tap', () => {
  const flushed = () => new Promise((resolve) => setImmediate(resolve));

  function sampleApp() {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.use(auditAdminWrites);
    const router = Router();
    router.use(authenticate);
    router.post('/:id/approve', requireRole('ADMIN'), (_req, res) => {
      res.json({ success: true });
    });
    router.post('/:id/reject', requireRole('ADMIN'), async (req, res) => {
      await logActivity(req.user!.sub, 'PAYOUT_REJECTED', req, { payoutId: req.params['id'] });
      res.json({ success: true });
    });
    const api = Router();
    api.use('/payouts', router);
    app.use('/api/v1', api);
    return app;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.activityLog.create.mockResolvedValue({});
  });

  it('writes one generic row with the route template, the target and the request id', async () => {
    const res = await request(sampleApp())
      .post('/api/v1/payouts/pay-1/approve')
      .set('Authorization', `Bearer ${tokenFor(['ADMIN'], 'admin-7')}`)
      .set('x-request-id', 'contract-req')
      .send({ note: 'ok' });
    expect(res.status).toBe(200);
    await flushed();

    expect(prisma.activityLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.activityLog.create.mock.calls[0]![0].data).toMatchObject({
      userId: 'admin-7',
      action: 'payouts.POST /payouts/:id/approve',
      module: 'payouts',
      targetType: 'Payout',
      targetId: 'pay-1',
      requestId: 'contract-req',
      metadata: { bodyKeys: ['note'], params: { id: 'pay-1' }, queryKeys: [], status: 200 },
    });
  });

  it('defers to a hand-written row, and writes nothing for a non-admin', async () => {
    const app = sampleApp();
    await request(app).post('/api/v1/payouts/pay-2/reject').set('Authorization', `Bearer ${tokenFor(['ADMIN'], 'admin-7')}`);
    await flushed();
    expect(prisma.activityLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.activityLog.create.mock.calls[0]![0].data.action).toBe('PAYOUT_REJECTED');

    prisma.activityLog.create.mockClear();
    await request(app).post('/api/v1/payouts/pay-3/approve').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'], 'pub-1')}`);
    await flushed();
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });
});
