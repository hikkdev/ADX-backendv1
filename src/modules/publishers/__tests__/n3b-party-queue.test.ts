import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N3-B (the owner, 14 Sep 2026) — the publisher KYC queue lists PARTIES.
 *
 * What is pinned, at the query: `GET /publishers/kyc-queue` is every
 * publisher not yet verified plus every publisher with a record; `state=`
 * is the facet, `status=` its alias, `requested=true` the REQUESTED state;
 * `q=` reaches the publisher; the record-level facets narrow to rows that
 * have a record; late submissions first, then the parties with nothing in
 * by when they arrived. At the service: every row carries its `state` and
 * `kycId`; a party with no record is AWAITING_DOCUMENTS with no age; the
 * chips count publishers per state, `awaitingDocuments` among them.
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    publisher: { findMany: vi.fn<AnyFn>(async () => []), count: vi.fn<AnyFn>(async () => 0) },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaPublishersRepository as repository } from '../prisma-publishers.repository';
import { kycQueueQuerySchema } from '../publishers.schema';

const BASE = { OR: [{ kycStatus: { not: 'VERIFIED' } }, { kyc: { isNot: null } }] };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.publisher.findMany.mockResolvedValue([]);
  prisma.publisher.count.mockResolvedValue(0);
});

describe('the query', () => {
  it('takes `state` (one of six, case-insensitive) beside the `status` alias, and `q`', () => {
    expect(kycQueueQuerySchema.parse({ state: 'awaiting_documents', q: 'Sharma' })).toEqual({ state: 'AWAITING_DOCUMENTS', q: 'Sharma' });
    expect(kycQueueQuerySchema.parse({ status: 'needs_info' })).toEqual({ status: 'NEEDS_INFO' });
    expect(kycQueueQuerySchema.safeParse({ state: 'LOST' }).success).toBe(false);
  });
});

describe('the queue is every publisher', () => {
  it('with no facet: the base alone, the record left-joined, late submissions first then arrivals', async () => {
    await repository.findKycQueue({});
    expect(prisma.publisher.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [BASE] },
        include: expect.objectContaining({ kyc: true }),
        orderBy: [{ kyc: { submittedAt: { sort: 'asc', nulls: 'last' } } }, { createdAt: 'asc' }],
      }),
    );
  });

  it('`state=AWAITING_DOCUMENTS` is no record (and not verified) or an untouched record; `status=` is the alias; `requested=true` is REQUESTED, ordered by the ask', async () => {
    await repository.findKycQueue({ state: 'AWAITING_DOCUMENTS' });
    expect(prisma.publisher.findMany.mock.calls[0]![0].where.AND).toEqual([
      BASE,
      { OR: [{ kyc: null, kycStatus: { not: 'VERIFIED' } }, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: null } } }] },
    ]);
    await repository.findKycQueue({ status: 'PENDING' });
    expect(prisma.publisher.findMany.mock.calls[1]![0].where.AND).toEqual([BASE, { kyc: { is: { status: 'PENDING', submittedAt: { not: null } } } }]);
    await repository.findKycQueue({ requested: true, sort: 'newest' });
    expect(prisma.publisher.findMany.mock.calls[2]![0].where.AND).toEqual([BASE, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: { not: null } } } }]);
    expect(prisma.publisher.findMany.mock.calls[2]![0].orderBy).toEqual([{ kyc: { requestedAt: { sort: 'desc', nulls: 'last' } } }, { createdAt: 'desc' }]);
  });

  it('the record-level facets narrow to rows with a record; `unassigned` and `q` reach the publisher', async () => {
    await repository.findKycQueue({ assignedToId: null, method: 'DIGIO', escalated: false, unassigned: true, q: 'Sharma' });
    expect(prisma.publisher.findMany.mock.calls[0]![0].where.AND).toEqual([
      BASE,
      { kyc: { is: { assignedToId: null, method: 'DIGIO', escalatedAt: null } } },
      { agentId: null },
      {
        OR: [
          { name: { contains: 'Sharma', mode: 'insensitive' } },
          { displayId: { contains: 'Sharma', mode: 'insensitive' } },
          { email: { contains: 'Sharma', mode: 'insensitive' } },
          { mobile: { contains: 'Sharma' } },
          { contactMobile: { contains: 'Sharma' } },
        ],
      },
    ]);
    await repository.countKycQueue({ state: 'REQUESTED' });
    expect(prisma.publisher.count).toHaveBeenCalledWith({ where: { AND: [BASE, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: { not: null } } } }] } });
  });
});
