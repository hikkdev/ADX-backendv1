import express, { Router } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRow } from '../../../shared/audit';

const shared = vi.hoisted(() => ({
  findActivity: vi.fn(),
  findActivityRows: vi.fn(),
  logActivity: vi.fn(),
}));

vi.mock('../../../shared/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/audit')>();
  return { ...actual, ...shared };
});

import { authenticate, requireRole } from '../../../shared/auth';
import { errorHandler } from '../../../shared/errors';
import { tokenFor } from '../../../shared/testing';
import { auditRouter } from '../audit.routes';
import { csvCell, csvLine, EXPORT_BATCH, iterateAuditRows } from '../audit.service';

const row = (overrides: Partial<ActivityRow> = {}): ActivityRow =>
  ({
    id: 'a1',
    userId: 'u1',
    action: 'ORDER_APPROVED',
    metadata: { orderId: 'o1' },
    ipAddress: '10.0.0.1',
    userAgent: 'x',
    targetType: 'Order',
    targetId: 'o1',
    module: 'orders',
    requestId: 'req-1',
    diff: null,
    createdAt: new Date('2026-09-11T10:00:00Z'),
    user: { id: 'u1', name: 'Asha, Admin', email: 'asha@adx.co' },
    ...overrides,
  }) as ActivityRow;

function appWith() {
  const app = express();
  const api = Router();
  api.use('/audit', auditRouter);
  app.use('/api/v1', api);
  app.use(errorHandler);
  return app;
}

const admin = tokenFor(['ADMIN'], 'admin-1');

beforeEach(() => {
  vi.clearAllMocks();
  shared.logActivity.mockResolvedValue(undefined);
  shared.findActivity.mockResolvedValue({ items: [row()], total: 1, page: 1, pageSize: 20, counts: { orders: 1 } });
});

describe('GET /audit', () => {
  it('parses the list contract and hands the filter and page to the trail', async () => {
    const res = await request(appWith())
      .get('/api/v1/audit?q=refund&module=wallets&from=2026-09-01&to=2026-09-11T23:59:59Z&sort=oldest&page=2&pageSize=5')
      .set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 1, counts: { orders: 1 } });
    expect(res.body.data.items[0].user).toEqual({ id: 'u1', name: 'Asha, Admin', email: 'asha@adx.co' });

    expect(shared.findActivity).toHaveBeenCalledWith(
      { q: 'refund', module: 'wallets', from: new Date('2026-09-01'), to: new Date('2026-09-11T23:59:59Z') },
      { sort: 'oldest', page: 2, pageSize: 5 },
    );
  });

  it('rejects a window that ends before it starts, and a page size over the cap', async () => {
    const backwards = await request(appWith()).get('/api/v1/audit?from=2026-09-11&to=2026-09-01').set('Authorization', `Bearer ${admin}`);
    expect(backwards.status).toBe(400);
    const huge = await request(appWith()).get('/api/v1/audit?pageSize=500').set('Authorization', `Bearer ${admin}`);
    expect(huge.status).toBe(400);
  });

  it('is admin-only', async () => {
    const res = await request(appWith()).get('/api/v1/audit').set('Authorization', `Bearer ${tokenFor(['PUBLISHER'])}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /audit/targets/:targetType/:targetId', () => {
  it('is the same list narrowed to one record', async () => {
    const res = await request(appWith()).get('/api/v1/audit/targets/Wallet/w-9?sort=oldest').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(shared.findActivity).toHaveBeenCalledWith(
      { targetType: 'Wallet', targetId: 'w-9' },
      { sort: 'oldest', page: 1, pageSize: 20 },
    );
  });
});

describe('GET /audit/export.csv', () => {
  it('streams text/csv with a header row, one line per row, and audits itself as AUDIT_EXPORTED', async () => {
    shared.findActivityRows.mockResolvedValueOnce([row(), row({ id: 'a2', diff: { status: { before: 'A', after: 'B' } } })]).mockResolvedValue([]);
    const res = await request(appWith()).get('/api/v1/audit/export.csv?module=orders').set('Authorization', `Bearer ${admin}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="audit-.*\.csv"/);

    const lines = res.text.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('id,createdAt,userId,actorName,actorEmail,action,module,targetType,targetId,requestId,ipAddress,metadata,diff');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"Asha, Admin"');
    expect(lines[2]).toContain('"{""status"":{""before"":""A"",""after"":""B""}}"');

    expect(shared.logActivity).toHaveBeenCalledWith(
      'admin-1',
      'AUDIT_EXPORTED',
      expect.objectContaining({ module: 'audit', metadata: expect.objectContaining({ filter: expect.objectContaining({ module: 'orders' }) }) }),
    );
  });
});

describe('iterateAuditRows', () => {
  it('walks in batches and stops at the cap even when more rows exist', async () => {
    shared.findActivityRows.mockImplementation(async (_f: unknown, slice: { take: number }) =>
      Array.from({ length: slice.take }, (_, i) => row({ id: `r${i}` })),
    );
    let count = 0;
    for await (const batch of iterateAuditRows({}, 'newest', EXPORT_BATCH * 2 + 5)) count += batch.length;
    expect(count).toBe(EXPORT_BATCH * 2 + 5);
    expect(shared.findActivityRows).toHaveBeenCalledTimes(3);
    expect(shared.findActivityRows).toHaveBeenLastCalledWith({}, { skip: EXPORT_BATCH * 2, take: 5, sort: 'newest' });
  });

  it('stops early on a short batch', async () => {
    shared.findActivityRows.mockResolvedValueOnce([row()]);
    let batches = 0;
    for await (const _batch of iterateAuditRows({}, 'newest')) batches += 1;
    expect(batches).toBe(1);
    expect(shared.findActivityRows).toHaveBeenCalledTimes(1);
  });
});

describe('csv formatting', () => {
  it('quotes commas, quotes and newlines; leaves the rest bare; empties nulls', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(new Date('2026-09-11T10:00:00Z'))).toBe('2026-09-11T10:00:00.000Z');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('lays a row out in the column order', () => {
    expect(csvLine(row())).toBe(
      'a1,2026-09-11T10:00:00.000Z,u1,"Asha, Admin",asha@adx.co,ORDER_APPROVED,orders,Order,o1,req-1,10.0.0.1,"{""orderId"":""o1""}",\r\n',
    );
  });
});
