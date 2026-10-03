import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026): the advertiser roster's `status=` facet —
 * ACTIVE by default, SUSPENDED / DEACTIVATED / CLOSED, ALL for everyone —
 * with `statusCounts` beside the page (each counted with the facet removed)
 * and `accountState` on every row, the account read for it never sent on.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: { advertiser: { findMany: vi.fn(), count: vi.fn() } },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { advertiserStateWhere } from '../../../shared/party-status';
import { prismaAdvertisersRepository as repository } from '../prisma-advertisers.repository';
import { advertiserRosterQuerySchema } from '../advertisers.schema';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.advertiser.findMany.mockResolvedValue([
    { id: 'adv_1', suspensionScopes: [], _count: { campaigns: 2 }, user: { isActive: true, closedAt: null } },
    { id: 'adv_2', suspensionScopes: ['BLOCK_NEW'], _count: { campaigns: 0 }, user: { isActive: true, closedAt: null } },
  ]);
  prisma.advertiser.count.mockResolvedValue(3);
});

describe('the advertiser roster status facet', () => {
  it('parses the five words', () => {
    expect(advertiserRosterQuerySchema.parse({ status: 'deactivated' })).toMatchObject({ status: 'DEACTIVATED' });
    expect(advertiserRosterQuerySchema.safeParse({ status: 'EXITED' }).success).toBe(false);
  });

  it('defaults to the working accounts and counts each state with the facet removed', async () => {
    const page = await repository.listAdvertisers({ limit: 50 });
    expect(prisma.advertiser.findMany.mock.calls[0]![0].where.AND).toContainEqual(advertiserStateWhere('ACTIVE'));
    expect(page.statusCounts).toEqual({ ACTIVE: 3, SUSPENDED: 3, DEACTIVATED: 3, CLOSED: 3 });
    const chips = prisma.advertiser.count.mock.calls.slice(1).map(([args]) => args.where.AND[1]);
    expect(chips).toEqual([advertiserStateWhere('ACTIVE'), advertiserStateWhere('SUSPENDED'), advertiserStateWhere('DEACTIVATED'), advertiserStateWhere('CLOSED')]);
  });

  it('a named state narrows to it; ALL is everyone', async () => {
    await repository.listAdvertisers({ limit: 50, status: 'CLOSED' });
    expect(prisma.advertiser.findMany.mock.calls[0]![0].where.AND).toContainEqual(advertiserStateWhere('CLOSED'));
    await repository.listAdvertisers({ limit: 50, status: 'ALL' });
    expect(JSON.stringify(prisma.advertiser.findMany.mock.calls[1]![0].where)).not.toContain('BLOCK_NEW');
  });

  it('every row carries accountState and not the account it was read from', async () => {
    const page = await repository.listAdvertisers({ limit: 50, status: 'ALL' });
    const rows = (page as unknown as { rows: Record<string, unknown>[] }).rows;
    expect(rows.map((row) => row['accountState'])).toEqual(['ACTIVE', 'SUSPENDED']);
    expect(rows[0]).not.toHaveProperty('user');
  });
});
