import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Account lifecycle (2 Oct 2026): the package renewal sweep neither reminds nor renews a suspended, deactivated or closed advertiser. */

const { prisma } = vi.hoisted(() => ({ prisma: { packageSale: { findMany: vi.fn() } } }));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { workingAdvertiserWhere } from '../../../shared/party-status';
import { prismaPackagesRepository as repository } from '../prisma-packages.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.packageSale.findMany.mockResolvedValue([]);
});

describe('findEndingBetween', () => {
  it('reads only sales whose advertiser is a working account', async () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-08T00:00:00Z');
    await repository.findEndingBetween(from, to);
    expect(prisma.packageSale.findMany.mock.calls[0]![0].where).toEqual({ status: { in: ['ACTIVE', 'EXPIRED'] }, endsAt: { gt: from, lte: to }, advertiser: workingAdvertiserWhere() });
  });
});
