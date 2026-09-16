import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  activityLog: { create: vi.fn() },
}));

vi.mock('../../database/prisma', () => ({ prisma }));

import { authenticate, requireRole } from '../../auth';
import { requestId } from '../../http/request-id';
import { tokenFor } from '../../testing';
import { logActivity } from '../activity-log';
import { auditAdminWrites, routeTemplate, targetOf } from '../audit-admin-writes';

/** A miniature of create-app: the id first, the parser, the audit tap, then routers under /api/v1. */
function appWith() {
  const app = express();
  app.use(requestId);
  app.use(express.json());
  app.use(auditAdminWrites);

  const legal = Router();
  legal.use(authenticate);
  legal.post('/documents', requireRole('ADMIN'), (_req, res) => {
    res.status(201).json({ ok: true });
  });
  legal.post('/documents/:id/activate', requireRole('ADMIN'), (_req, res) => {
    res.json({ ok: true });
  });
  legal.get('/documents', requireRole('ADMIN'), (_req, res) => {
    res.json({ ok: true });
  });
  legal.patch('/documents/:id/broken', requireRole('ADMIN'), (_req, res) => {
    res.status(409).json({ ok: false });
  });
  // A handler that audits by hand, the way the 59 existing call sites do.
  legal.delete('/documents/:id', requireRole('ADMIN'), async (req, res) => {
    await logActivity(req.user!.sub, 'LEGAL_DOCUMENT_DELETED', req, { documentId: req.params['id'] });
    res.status(204).end();
  });

  const milestones = Router({ mergeParams: true });
  milestones.use(authenticate);
  milestones.post('/:milestoneId/approve', requireRole('ADMIN'), (_req, res) => {
    res.json({ ok: true });
  });

  const api = Router();
  api.use('/legal', legal);
  api.use('/orders/:orderId/milestones', milestones);
  app.use('/api/v1', api);
  return app;
}

const admin = tokenFor(['ADMIN'], 'admin-1');
const publisher = tokenFor(['PUBLISHER'], 'pub-1');

const flushed = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.activityLog.create.mockResolvedValue({});
});

describe('auditAdminWrites', () => {
  it('writes one row for a successful admin write, with the route template and keys only', async () => {
    const res = await request(appWith())
      .post('/api/v1/legal/documents')
      .set('Authorization', `Bearer ${admin}`)
      .set('x-request-id', 'req-a')
      .send({ title: 'Terms', body: 'secret text that must not be logged' });
    expect(res.status).toBe(201);
    await flushed();

    expect(prisma.activityLog.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.activityLog.create.mock.calls[0]![0];
    expect(data).toMatchObject({
      userId: 'admin-1',
      action: 'legal.POST /legal/documents',
      module: 'legal',
      requestId: 'req-a',
      metadata: { bodyKeys: ['title', 'body'], params: {}, queryKeys: [], status: 201 },
    });
    expect(JSON.stringify(data)).not.toContain('secret text');
  });

  it('guesses the target from the id parameter and the module', async () => {
    await request(appWith()).post('/api/v1/legal/documents/doc-7/activate').set('Authorization', `Bearer ${admin}`);
    await flushed();
    expect(prisma.activityLog.create.mock.calls[0]![0].data).toMatchObject({
      action: 'legal.POST /legal/documents/:id/activate',
      targetType: 'Legal',
      targetId: 'doc-7',
    });
  });

  it('prefers the first parameter ending in Id, and templates the mount path too', async () => {
    await request(appWith())
      .post('/api/v1/orders/ord-1/milestones/ms-2/approve')
      .set('Authorization', `Bearer ${admin}`);
    await flushed();
    expect(prisma.activityLog.create.mock.calls[0]![0].data).toMatchObject({
      action: 'orders.POST /orders/:orderId/milestones/:milestoneId/approve',
      module: 'orders',
      targetType: 'Order',
      targetId: 'ord-1',
    });
  });

  it('stays quiet for reads, failures, and non-admin callers', async () => {
    const app = appWith();
    await request(app).get('/api/v1/legal/documents').set('Authorization', `Bearer ${admin}`);
    await request(app).patch('/api/v1/legal/documents/x/broken').set('Authorization', `Bearer ${admin}`);
    await request(app).post('/api/v1/legal/documents').set('Authorization', `Bearer ${publisher}`).send({});
    await request(app).post('/api/v1/legal/documents').send({});
    await flushed();
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  /* A hand-written row is the better row; the generic one must not double it. */
  it('is suppressed when the handler already logged through logActivity(req)', async () => {
    const res = await request(appWith()).delete('/api/v1/legal/documents/doc-9').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(204);
    await flushed();
    expect(prisma.activityLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.activityLog.create.mock.calls[0]![0].data.action).toBe('LEGAL_DOCUMENT_DELETED');
  });

  it('never fails the request when the write fails', async () => {
    prisma.activityLog.create.mockRejectedValue(new Error('fk violation'));
    const res = await request(appWith()).post('/api/v1/legal/documents').set('Authorization', `Bearer ${admin}`).send({});
    expect(res.status).toBe(201);
    await flushed();
  });
});

describe('helpers', () => {
  it('routeTemplate replaces param values in the mount path and strips the API prefix', () => {
    expect(
      routeTemplate({
        baseUrl: '/api/v1/orders/ord-1/milestones',
        path: '/ms-2/approve',
        params: { orderId: 'ord-1', milestoneId: 'ms-2' },
        route: { path: '/:milestoneId/approve' },
      }),
    ).toBe('/orders/:orderId/milestones/:milestoneId/approve');
  });

  it('routeTemplate falls back to id-shaped segments when Express has no route', () => {
    expect(
      routeTemplate({ baseUrl: '/api/v1/wallets', path: '/cm1abc2def3ghi4jkl5mno6pq/adjust', params: {} }),
    ).toBe('/wallets/:id/adjust');
  });

  it('targetOf singularises the module for a plain id', () => {
    expect(targetOf({ id: 'rc-1' }, 'rate-cards')).toEqual({ targetType: 'RateCard', targetId: 'rc-1' });
    expect(targetOf({ id: 'a-1' }, 'access-grants')).toEqual({ targetType: 'AccessGrant', targetId: 'a-1' });
    expect(targetOf({ publisherId: 'p-1', id: 'l-1' }, 'listings')).toEqual({ targetType: 'Publisher', targetId: 'p-1' });
    expect(targetOf({}, 'legal')).toEqual({ targetType: undefined, targetId: undefined });
  });
});
