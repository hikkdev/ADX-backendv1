import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DR 10's order board (`5102:39707`) — search, sort, status chips and a page.
 *
 * What this replaces: `status` was `z.string().optional()` and the repository
 * cast it `status as any`, so `?status=IN_PROGRESS,PENDING_OTP` reached
 * Postgres as one invalid enum and surfaced as a 500 rather than a 400. And
 * `limit` had no maximum at all, so `?limit=100000` was honoured.
 *
 * Pinned here: the status facet is a comma list checked against the real
 * fourteen, the page is capped, and the board can be searched by order,
 * listing, city or agent — which is what the frame's "Search orders or agent"
 * box promises.
 */

const { repository } = vi.hoisted(() => ({
  repository: { findAll: vi.fn() },
}));

vi.mock('../prisma-orders.repository', () => ({ prismaOrdersRepository: repository }));

import { getAllOrders } from '../orders.queries';
import { ORDER_STATUSES, adminOrdersQuerySchema } from '../orders.schema';

beforeEach(() => {
  vi.clearAllMocks();
  repository.findAll.mockResolvedValue({
    items: [{ id: 'ord_1', status: 'IN_PROGRESS' }],
    total: 12,
    counts: { IN_PROGRESS: 3, COMPLETED: 9 },
  });
});

describe('the admin orders query', () => {
  it('knows all fourteen order statuses', () => {
    expect(ORDER_STATUSES).toHaveLength(14);
    expect(ORDER_STATUSES).toContain('PENDING_PUBLISHER');
    expect(ORDER_STATUSES).toContain('CANCELLED');
  });

  it('accepts a comma list of statuses — the thing that used to 500', () => {
    expect(adminOrdersQuerySchema.parse({ status: 'IN_PROGRESS,PENDING_OTP' }).status).toEqual([
      'IN_PROGRESS',
      'PENDING_OTP',
    ]);
  });

  it('refuses an unknown status as a 400 rather than passing it to Postgres', () => {
    expect(adminOrdersQuerySchema.safeParse({ status: 'IN_PROGESS' }).success).toBe(false);
  });

  it('caps the page — ?pageSize=100000 used to be honoured', () => {
    expect(adminOrdersQuerySchema.safeParse({ pageSize: '100000' }).success).toBe(false);
    expect(adminOrdersQuerySchema.parse({}).pageSize).toBe(20);
  });

  it('offers the board its sort keys and refuses the rest', () => {
    for (const sort of ['NEWEST', 'OLDEST', 'DUE']) {
      expect(adminOrdersQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(adminOrdersQuerySchema.safeParse({ sort: 'AGENT' }).success).toBe(false);
  });

  it('carries the agent facet, which is how a board is triaged', () => {
    expect(adminOrdersQuerySchema.parse({ agentId: 'agt_1' }).agentId).toBe('agt_1');
  });
});

describe('getAllOrders', () => {
  it('returns the page whole, with the chip counts', async () => {
    const page = await getAllOrders(adminOrdersQuerySchema.parse({ status: 'IN_PROGRESS' }));
    expect(page.total).toBe(12);
    expect(page.counts).toEqual({ IN_PROGRESS: 3, COMPLETED: 9 });
    expect(page.page).toBe(1);
  });

  it('passes the parsed query through rather than a string', async () => {
    await getAllOrders(adminOrdersQuerySchema.parse({ q: 'forum', page: '3', pageSize: '5' }));
    expect(repository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'forum', page: 3, pageSize: 5 }),
    );
  });
});
