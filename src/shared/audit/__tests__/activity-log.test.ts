import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const prisma = vi.hoisted(() => ({
  activityLog: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
  },
}));

vi.mock('../../database/prisma', () => ({ prisma }));

import { findActivity, logActivity } from '../activity-log';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.activityLog.create.mockResolvedValue({});
});

function fakeRequest(overrides: Partial<Request> = {}): Request {
  const locals: Record<string, unknown> = {};
  return {
    ip: '10.0.0.1',
    headers: { 'user-agent': 'vitest' },
    method: 'POST',
    requestId: 'req-42',
    res: { locals },
    ...overrides,
  } as unknown as Request;
}

describe('logActivity', () => {
  /* The 59 call sites written before Lot A. Not one of them may change. */
  it('keeps the original (userId, action, req?, metadata?) signature working', async () => {
    const req = fakeRequest();
    await logActivity('user-1', 'LEGAL_DOCUMENT_CREATED', req, { documentId: 'doc-1' });

    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        action: 'LEGAL_DOCUMENT_CREATED',
        metadata: { documentId: 'doc-1' },
        ipAddress: '10.0.0.1',
        userAgent: 'vitest',
        requestId: 'req-42',
      }),
    });
  });

  it('works with no request at all, as the services call it', async () => {
    await logActivity('user-1', 'ACCESS_GRANT_ISSUED', undefined, { grantId: 'g-1' });
    const data = prisma.activityLog.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ userId: 'user-1', action: 'ACCESS_GRANT_ISSUED', metadata: { grantId: 'g-1' } });
    expect(data.requestId).toBeUndefined();
    expect(data.ipAddress).toBeUndefined();
  });

  it('accepts the options object: target, module, diff, metadata, and the request id from req', async () => {
    const req = fakeRequest();
    await logActivity('admin-1', 'WALLET_ADJUSTED', {
      req,
      targetType: 'Wallet',
      targetId: 'w-1',
      module: 'wallets',
      diff: { balance: { before: '100.00', after: '150.00' } },
      metadata: { reason: 'goodwill' },
    });

    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'admin-1',
        action: 'WALLET_ADJUSTED',
        metadata: { reason: 'goodwill' },
        ipAddress: '10.0.0.1',
        userAgent: 'vitest',
        targetType: 'Wallet',
        targetId: 'w-1',
        module: 'wallets',
        requestId: 'req-42',
        diff: { balance: { before: '100.00', after: '150.00' } },
      },
    });
  });

  it('takes an explicit requestId when there is no request (a job acting on someone\'s behalf)', async () => {
    await logActivity('system', 'PAYOUT_RELEASED', { requestId: 'job-tick-7', targetType: 'Payout', targetId: 'p-1', module: 'payouts' });
    expect(prisma.activityLog.create.mock.calls[0]![0].data).toMatchObject({ requestId: 'job-tick-7', targetId: 'p-1' });
  });

  /*
   * The hand-written row must win over the generic one: a call that carries
   * the request marks its response audited so audit-admin-writes stays quiet.
   */
  it('marks the response audited when called with a request, in either form', async () => {
    const legacy = fakeRequest();
    await logActivity('user-1', 'X', legacy);
    expect((legacy.res as { locals: Record<string, unknown> }).locals['audited']).toBe(true);

    const modern = fakeRequest();
    await logActivity('user-1', 'X', { req: modern });
    expect((modern.res as { locals: Record<string, unknown> }).locals['audited']).toBe(true);

    const none = fakeRequest();
    await logActivity('user-1', 'X', undefined, {});
    expect((none.res as { locals: Record<string, unknown> }).locals['audited']).toBeUndefined();
  });
});

describe('findActivity', () => {
  beforeEach(() => {
    prisma.activityLog.findMany.mockResolvedValue([
      { id: 'a1', action: 'ORDER_APPROVED', module: 'orders', user: { id: 'u1', name: 'Asha', email: 'asha@adx.co' } },
    ]);
    prisma.activityLog.count.mockResolvedValue(1);
    prisma.activityLog.groupBy.mockResolvedValue([
      { module: 'orders', _count: { _all: 7 } },
      { module: null, _count: { _all: 2 } },
    ]);
  });

  it('returns the list contract with counts by module and the actor joined', async () => {
    const page = await findActivity(
      { action: 'ORDER_APPROVED', module: 'orders', userId: 'u1' },
      { page: 2, pageSize: 10, sort: 'newest' },
    );

    expect(page).toEqual({
      items: expect.any(Array),
      total: 1,
      page: 2,
      pageSize: 10,
      counts: { orders: 7, '(none)': 2 },
    });
    expect(page.items[0]).toMatchObject({ user: { name: 'Asha', email: 'asha@adx.co' } });

    const args = prisma.activityLog.findMany.mock.calls[0]![0];
    expect(args).toMatchObject({
      where: { action: 'ORDER_APPROVED', module: 'orders', userId: 'u1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  });

  /* The chip row must remain a way back out: the module facet is dropped from its own count. */
  it('counts modules against the filter without the module facet', async () => {
    await findActivity({ module: 'orders', targetType: 'Order' }, { page: 1, pageSize: 20, sort: 'newest' });
    const groupArgs = prisma.activityLog.groupBy.mock.calls[0]![0];
    expect(groupArgs.by).toEqual(['module']);
    expect(groupArgs.where).toEqual({ targetType: 'Order' });
    expect(groupArgs.where).not.toHaveProperty('module');
  });

  it('turns q into an action-or-target contains, and from/to into a createdAt window', async () => {
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-11T00:00:00Z');
    await findActivity({ q: 'refund', from, to, targetId: 'w-1' }, { page: 1, pageSize: 20, sort: 'oldest' });
    const { where, orderBy } = prisma.activityLog.findMany.mock.calls[0]![0];
    expect(where.OR).toEqual([
      { action: { contains: 'refund', mode: 'insensitive' } },
      { targetId: { contains: 'refund', mode: 'insensitive' } },
    ]);
    expect(where.createdAt).toEqual({ gte: from, lte: to });
    expect(where.targetId).toBe('w-1');
    expect(orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});
