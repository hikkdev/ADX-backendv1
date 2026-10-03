import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Account lifecycle (2 Oct 2026): every rights row the sweep reads says whether its publisher is a working account. */

const { prisma } = vi.hoisted(() => ({ prisma: { listing: { findMany: vi.fn() } } }));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaSupplyRepository as repository } from '../prisma-supply.repository';

beforeEach(() => vi.clearAllMocks());

describe('rightsDue', () => {
  it('joins the publisher’s scopes and account and answers publisherWorking', async () => {
    prisma.listing.findMany.mockResolvedValue([
      { id: 'a', publisher: { name: 'On', suspensionScopes: [], user: { isActive: true, closedAt: null } } },
      { id: 'b', publisher: { name: 'Blocked', suspensionScopes: ['BLOCK_NEW'], user: { isActive: true, closedAt: null } } },
      { id: 'c', publisher: { name: 'Closed', suspensionScopes: [], user: { isActive: false, closedAt: new Date() } } },
      { id: 'd', publisher: null },
    ]);
    const rows = await repository.rightsDue(new Date());
    expect(rows.map((row) => [row.id, row.publisherWorking])).toEqual([['a', true], ['b', false], ['c', false], ['d', true]]);
    expect(prisma.listing.findMany.mock.calls[0]![0].select.publisher).toEqual({ select: { name: true, suspensionScopes: true, user: { select: { isActive: true, closedAt: true } } } });
  });
});
