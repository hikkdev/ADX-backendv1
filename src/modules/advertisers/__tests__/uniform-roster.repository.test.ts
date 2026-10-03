import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — the party rosters, made uniform: what `listAdvertisers`
 * asks the database. Every cut is one AND part; the search reaches the city
 * and the phone as the console prints it; the campaigns are counted in the
 * same query; `total` counts every row the cuts match.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: { advertiser: { findMany: vi.fn(), count: vi.fn() } },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { kycRosterStateWhere } from '../../../shared/kyc-state';
import { prismaAdvertisersRepository as repository } from '../prisma-advertisers.repository';

beforeEach(() => {
  vi.clearAllMocks();
  prisma.advertiser.findMany.mockResolvedValue([{ id: 'adv_1', name: 'Swiggy', _count: { campaigns: 5 } }]);
  prisma.advertiser.count.mockResolvedValue(7);
});

describe('listAdvertisers', () => {
  it('ANDs the search, the door, the KYC state, the type and the city', async () => {
    await repository.listAdvertisers({ q: '98765-43210', onboardedVia: 'AGENT', kycState: 'PENDING', type: 'AGENCY', city: 'Pune', cityId: 'city_pune', limit: 50 });
    const [args] = prisma.advertiser.findMany.mock.calls[0]!;
    // Account lifecycle (2 Oct 2026): the cuts, then the status facet (ACTIVE by default) beside them.
    const parts = args.where.AND[0].AND;
    expect(parts).toContainEqual({ onboardedVia: 'AGENT' });
    expect(parts).toContainEqual(kycRosterStateWhere('PENDING', true));
    expect(parts).toContainEqual({ type: 'AGENCY' });
    expect(parts).toContainEqual({ OR: [{ cityId: 'city_pune' }, { cityId: null, city: { equals: 'Pune', mode: 'insensitive' } }] });
    const search = parts.find((part: { OR?: unknown[] }) => Array.isArray(part.OR) && part.OR.some((clause) => 'companyName' in (clause as object)));
    expect(search.OR).toContainEqual({ mobile: { contains: '9876543210' } });
    expect(search.OR).toContainEqual({ city: { contains: '98765-43210', mode: 'insensitive' } });
    // The total is counted over the same cuts.
    expect(prisma.advertiser.count).toHaveBeenNthCalledWith(1, { where: args.where });
  });

  it('counts the campaigns in the same query and answers the total beside the cursor page', async () => {
    const page = await repository.listAdvertisers({ limit: 50 });
    const [args] = prisma.advertiser.findMany.mock.calls[0]!;
    // Account lifecycle: the account rides the read for the row's state, and is not sent on.
    expect(args.include).toEqual({ _count: { select: { campaigns: true } }, user: { select: { isActive: true, closedAt: true } } });
    expect(page).toEqual({
      rows: [{ id: 'adv_1', name: 'Swiggy', campaignCount: 5, accountState: 'ACTIVE' }],
      nextCursor: null,
      total: 7,
      statusCounts: { ACTIVE: 7, SUSPENDED: 7, DEACTIVATED: 7, CLOSED: 7 },
    });
  });
});
