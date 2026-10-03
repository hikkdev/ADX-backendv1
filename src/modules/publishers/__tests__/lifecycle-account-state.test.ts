import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Account lifecycle (2 Oct 2026) — the publisher's side of "one meaning per
 * word". The KYC queue lists working accounts unless the desk asks for the
 * inactive (`include=inactive`), every count with it, and each row says
 * where the account stands (`accountState`); the roster takes `status=`
 * (ACTIVE by default on the list contract, ALL for everyone) with
 * `statusCounts`, while the bare array keeps everyone for its pickers.
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    publisher: {
      findMany: vi.fn<AnyFn>(async () => []),
      count: vi.fn<AnyFn>(async () => 0),
      groupBy: vi.fn<AnyFn>(async () => []),
      findUnique: vi.fn<AnyFn>(async () => null),
    },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaPublishersRepository as repository } from '../prisma-publishers.repository';
import { publisherBareQuerySchema, publisherRosterQuerySchema } from '../publishers.schema';
import { publisherStateWhere, workingPublisherWhere } from '../../../shared/party-status';

const WORKING = workingPublisherWhere();
const queueWhere = () => prisma.publisher.findMany.mock.calls[0]![0].where.AND as object[];

beforeEach(() => {
  vi.clearAllMocks();
  prisma.publisher.findMany.mockResolvedValue([]);
  prisma.publisher.count.mockResolvedValue(0);
  prisma.publisher.groupBy.mockResolvedValue([]);
});

describe('the KYC queue lists working accounts by default', () => {
  it('ANDs the working-publisher fragment into the queue and joins the account for the row state', async () => {
    await repository.findKycQueue({});
    expect(queueWhere()).toContainEqual(WORKING);
    expect(prisma.publisher.findMany.mock.calls[0]![0].include).toMatchObject({ user: { select: { isActive: true, closedAt: true } } });
  });

  it('leaves the fragment out when the desk asks for the inactive', async () => {
    await repository.findKycQueue({ includeInactive: true });
    expect(queueWhere()).not.toContainEqual(WORKING);
  });

  it('every count behind the chips takes the same where', async () => {
    await repository.countKycQueue({ state: 'PENDING' });
    expect(prisma.publisher.count.mock.calls[0]![0].where.AND).toContainEqual(WORKING);
    await repository.countKycQueue({ state: 'PENDING', includeInactive: true });
    expect(prisma.publisher.count.mock.calls[1]![0].where.AND).not.toContainEqual(WORKING);
  });
});

describe('the roster status facet', () => {
  it('parses status case-insensitively on both paths, and refuses a word that is not one', () => {
    expect(publisherRosterQuerySchema.parse({ status: 'suspended' })).toMatchObject({ status: 'SUSPENDED' });
    expect(publisherRosterQuerySchema.parse({ status: 'all' })).toMatchObject({ status: 'ALL' });
    expect(publisherBareQuerySchema.parse({ status: 'closed' })).toMatchObject({ status: 'CLOSED' });
    expect(publisherRosterQuerySchema.safeParse({ status: 'EXITED' }).success).toBe(false);
  });

  it('the list contract defaults to ACTIVE, counts every state with the facet removed, and says each row’s state', async () => {
    prisma.publisher.count.mockImplementation(async () => 2);
    prisma.publisher.findMany.mockResolvedValue([
      { id: 'pub_1', suspensionScopes: [], user: { isActive: true, closedAt: null }, _count: { listings: 1 }, agent: null, kyc: null },
    ]);
    const page = await repository.findRosterPage({ page: 1, pageSize: 20 });
    const where = prisma.publisher.findMany.mock.calls[0]![0].where;
    expect(JSON.stringify(where)).toContain(JSON.stringify(publisherStateWhere('ACTIVE')));
    expect(page.statusCounts).toEqual({ ACTIVE: 2, SUSPENDED: 2, DEACTIVATED: 2, CLOSED: 2 });
    // One count for the page, four for the chips — each chip's where is that state alone.
    const chipWheres = prisma.publisher.count.mock.calls.slice(1).map((call) => JSON.stringify(call[0].where));
    expect(chipWheres.some((w) => w.includes(JSON.stringify(publisherStateWhere('CLOSED'))))).toBe(true);
  });

  it('ALL is everyone — no state cut on the page', async () => {
    await repository.findRosterPage({ page: 1, pageSize: 20, status: 'ALL' });
    const where = JSON.stringify(prisma.publisher.findMany.mock.calls[0]![0].where);
    expect(where).not.toContain(JSON.stringify(publisherStateWhere('ACTIVE')));
  });

  it('the bare array keeps everyone unless a status is named', async () => {
    await repository.findAllForAdmin(undefined, undefined);
    expect(JSON.stringify(prisma.publisher.findMany.mock.calls[0]![0].where)).not.toContain('BLOCK_NEW');
    await repository.findAllForAdmin(undefined, undefined, 'SUSPENDED');
    expect(JSON.stringify(prisma.publisher.findMany.mock.calls[1]![0].where)).toContain(JSON.stringify(publisherStateWhere('SUSPENDED')));
  });
});
