import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * E6: `GET /disputes` on the list contract, with the old limit/offset shape
 * kept for one release. The schema decides which shape was asked for; the
 * service pages and counts; the controller answers the matching body.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findQueue: vi.fn(), countQueue: vi.fn() },
}));

vi.mock('../prisma-disputes.repository', () => ({ prismaDisputesRepository: repository }));
vi.mock('../../identifiers', () => ({ allocateIdentifier: vi.fn() }));
vi.mock('../../users', () => ({ getUserDisplayName: vi.fn(), listAdminUserIds: vi.fn() }));
vi.mock('../../notifications', () => ({ createNotification: vi.fn() }));
vi.mock('../../wallets', () => ({ ensureWallet: vi.fn(), move: vi.fn() }));
vi.mock('../../order-milestones', () => ({ raiseReinstallMilestone: vi.fn(), findMilestoneStatuses: vi.fn().mockResolvedValue([]) }));
vi.mock('../../fraud', () => ({ findOpenFraudCasesForDisputes: vi.fn().mockResolvedValue([]) }));

import { queueQuerySchema, queueShape } from '../disputes.schema';
import { listQueuePage } from '../disputes.service';
import { queueHandler } from '../disputes.controller';

const row = (id: string) => ({
  id,
  displayId: `DSP-${id}`,
  status: 'OPEN',
  amountClaimed: null,
  creditedAmount: null,
  slaDueAt: null,
  slaPausedAt: null,
  slaPausedMs: 0,
  reinstallMilestoneId: null,
  order: null,
  _count: { messages: 0, evidence: 0 },
});

beforeEach(() => {
  vi.clearAllMocks();
  repository.findQueue.mockResolvedValue([row('1'), row('2')]);
  repository.countQueue.mockResolvedValue({ total: 7, counts: { OPEN: 5, UNDER_REVIEW: 2, AWAITING_RESPONSE: 0, ESCALATED: 0, RESOLVED: 0, REJECTED: 0 } });
});

describe('the query', () => {
  it('reads q, a comma list of statuses and page/pageSize; the new pair wins over limit/offset', () => {
    const both = queueQuerySchema.parse({ q: 'DSP-1', status: 'OPEN,ESCALATED', page: '2', pageSize: '10', limit: '50', offset: '100' });
    expect(both.status).toEqual(['OPEN', 'ESCALATED']);
    expect(queueShape(both)).toEqual({ legacy: false, page: 2, pageSize: 10 });
    expect(queueShape(queueQuerySchema.parse({}))).toEqual({ legacy: false, page: 1, pageSize: 20 });
    expect(queueShape(queueQuerySchema.parse({ limit: '25', offset: '50' }))).toEqual({ legacy: true, limit: 25, offset: 50 });
    expect(queueQuerySchema.safeParse({ status: 'NOPE' }).success).toBe(false);
  });
});

describe('the page', () => {
  it('pages through the repository and carries total and the chips', async () => {
    const page = await listQueuePage({ q: 'bent', status: ['OPEN'], page: 3, pageSize: 2 });
    expect(repository.findQueue).toHaveBeenCalledWith({ q: 'bent', status: ['OPEN'], limit: 2, offset: 4 });
    expect(repository.countQueue).toHaveBeenCalledWith({ q: 'bent', status: ['OPEN'] });
    expect(page).toMatchObject({ total: 7, page: 3, pageSize: 2, counts: { OPEN: 5, UNDER_REVIEW: 2 } });
    expect(page.items).toHaveLength(2);
  });
});

describe('the route', () => {
  const response = () => {
    const res: Record<string, unknown> = {};
    res['json'] = vi.fn(() => res);
    return res as never as { json: ReturnType<typeof vi.fn> };
  };

  it('answers the list contract by default', async () => {
    const res = response();
    await queueHandler({ query: { page: '1' } } as never, res as never);
    const body = res.json.mock.calls[0]![0] as { data: { items: unknown[]; total: number } };
    expect(body.data.total).toBe(7);
    expect(body.data.items).toHaveLength(2);
  });

  it('keeps the bare array for a caller still sending limit/offset', async () => {
    const res = response();
    await queueHandler({ query: { limit: '2', offset: '0' } } as never, res as never);
    const body = res.json.mock.calls[0]![0] as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(repository.countQueue).not.toHaveBeenCalled();
  });
});
