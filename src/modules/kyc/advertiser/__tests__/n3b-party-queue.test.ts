import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * N3-B (the owner, 14 Sep 2026) — "the moment a user creates an account or
 * gets an account at ADX, their KYC automatically becomes pending hence they
 * should be automatically appearing in the KYC Queue."
 *
 * The fact from Neon that opened this: two advertisers with kycStatus
 * PENDING ('Swiggy', created on the console with no user, and a probe row)
 * and ZERO AdvertiserKyc rows — the owner opened the queue and saw nobody.
 *
 * What is pinned: `GET /advertiser-kyc` is a query over the Advertiser
 * table — every advertiser not yet verified plus every advertiser with a
 * record — each row carrying its `state`; a party with no record is
 * AWAITING_DOCUMENTS with every record column null, `kycId` null and `id`
 * the profile's; a requested one is REQUESTED; a submitted one is PENDING;
 * `?state=` is the facet and `?status=` its alias; the chips count parties
 * per state, `awaitingDocuments` among them; `?q=` reaches the party;
 * `?advertiserId=` takes a profile id or a user id.
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    advertiser: { findMany: vi.fn<AnyFn>(async () => []), count: vi.fn<AnyFn>(async () => 0) },
    advertiserKyc: { findUnique: vi.fn<AnyFn>(), upsert: vi.fn<AnyFn>(), create: vi.fn<AnyFn>(), update: vi.fn<AnyFn>(), findFirst: vi.fn<AnyFn>() },
  },
}));

vi.mock('../../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/database')>();
  return { ...actual, prisma };
});

import { prismaAdvertiserKycRepository as repository } from '../prisma-advertiser-kyc.repository';

const NOW = new Date('2026-09-14T22:00:00.000Z');
const ARRIVED = new Date('2026-09-14T10:00:00.000Z');
const BASE = { OR: [{ kycStatus: { not: 'VERIFIED' } }, { kyc: { isNot: null } }] };

const advertiser = (over: Record<string, unknown> = {}) => ({
  id: 'adv_swiggy',
  displayId: 'ADV-1409-2601',
  name: 'Swiggy',
  companyName: 'Bundl Technologies',
  email: 'ops@swiggy.in',
  mobile: '+919800000001',
  city: 'Bengaluru',
  userId: null,
  kycStatus: 'PENDING',
  type: 'COMMERCIAL',
  createdAt: ARRIVED,
  kyc: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.advertiser.findMany.mockResolvedValue([]);
  prisma.advertiser.count.mockResolvedValue(0);
});

describe('the queue is every advertiser', () => {
  it('lists Swiggy — created on the console with no user and no record — as AWAITING_DOCUMENTS, the record columns null, id the profile’s', async () => {
    prisma.advertiser.findMany.mockResolvedValue([advertiser()]);
    prisma.advertiser.count.mockResolvedValue(1);
    const { items, total } = await repository.findPage({}, 1, 20);
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      id: 'adv_swiggy',
      kycId: null,
      state: 'AWAITING_DOCUMENTS',
      status: null,
      submittedAt: null,
      requestedAt: null,
      method: null,
      advertiserId: null,
      advertiserProfileId: null,
      party: { id: 'adv_swiggy', displayId: 'ADV-1409-2601', name: 'Swiggy', companyName: 'Bundl Technologies', email: 'ops@swiggy.in', mobile: '+919800000001', city: 'Bengaluru', userId: null, createdAt: ARRIVED },
    });
    expect(items[0]!.advertiser).toEqual(items[0]!.party);
    // The query: the base (not yet verified, or with a record), the record left-joined, late submissions first then arrivals.
    expect(prisma.advertiser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [BASE] },
        include: { kyc: true },
        skip: 0,
        take: 20,
        orderBy: [{ kyc: { submittedAt: { sort: 'asc', nulls: 'last' } } }, { createdAt: 'asc' }],
      }),
    );
  });

  it('a requested party is REQUESTED, a submitted one PENDING — the record spread over the row, id the record’s', async () => {
    prisma.advertiser.findMany.mockResolvedValue([
      advertiser({ id: 'adv_req', kyc: { id: 'akyc_req', advertiserProfileId: 'adv_req', advertiserId: null, status: 'PENDING', submittedAt: null, requestedAt: NOW, requestedChannel: 'DIGIO', method: 'DIGIO' } }),
      advertiser({ id: 'adv_sub', userId: 'usr_sub', kyc: { id: 'akyc_sub', advertiserProfileId: 'adv_sub', advertiserId: 'usr_sub', status: 'PENDING', submittedAt: NOW, requestedAt: null, method: 'MANUAL' } }),
      advertiser({ id: 'adv_ok', kycStatus: 'VERIFIED', kyc: { id: 'akyc_ok', advertiserProfileId: 'adv_ok', status: 'VERIFIED', submittedAt: NOW, method: 'DIGIO' } }),
    ]);
    const { items } = await repository.findPage({}, 1, 20);
    expect(items.map((row) => [row.id, row.kycId, row.state])).toEqual([
      ['akyc_req', 'akyc_req', 'REQUESTED'],
      ['akyc_sub', 'akyc_sub', 'PENDING'],
      ['akyc_ok', 'akyc_ok', 'VERIFIED'],
    ]);
    expect(items[0]).toMatchObject({ requestedChannel: 'DIGIO', advertiserId: null, party: { id: 'adv_req' } });
  });

  it('`state=` narrows to one state; `status=` is its alias; `requested=true` is the REQUESTED state', async () => {
    await repository.findPage({ state: 'AWAITING_DOCUMENTS' }, 1, 20);
    expect(prisma.advertiser.findMany.mock.calls[0]![0].where.AND).toEqual([
      BASE,
      { OR: [{ kyc: null, kycStatus: { not: 'VERIFIED' } }, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: null } } }] },
    ]);
    await repository.findPage({ status: 'PENDING' }, 1, 20);
    expect(prisma.advertiser.findMany.mock.calls[1]![0].where.AND).toEqual([BASE, { kyc: { is: { status: 'PENDING', submittedAt: { not: null } } } }]);
    await repository.findPage({ requested: true }, 1, 20);
    expect(prisma.advertiser.findMany.mock.calls[2]![0].where.AND).toEqual([BASE, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: { not: null } } } }]);
    // `state` wins over the alias.
    await repository.findPage({ state: 'VERIFIED', status: 'PENDING' }, 1, 20);
    expect(prisma.advertiser.findMany.mock.calls[3]![0].where.AND).toEqual([BASE, { kyc: { is: { status: 'VERIFIED' } } }]);
  });

  it('`q=` reaches the party — name, company, display id, email, mobile; `advertiserId=` is the profile id or the user id', async () => {
    await repository.findPage({ q: 'swig', advertiserId: 'x_1' }, 1, 20);
    expect(prisma.advertiser.findMany.mock.calls[0]![0].where.AND).toEqual([
      BASE,
      { OR: [{ id: 'x_1' }, { userId: 'x_1' }] },
      {
        OR: [
          { name: { contains: 'swig', mode: 'insensitive' } },
          { companyName: { contains: 'swig', mode: 'insensitive' } },
          { displayId: { contains: 'swig', mode: 'insensitive' } },
          { email: { contains: 'swig', mode: 'insensitive' } },
          { mobile: { contains: 'swig' } },
        ],
      },
    ]);
  });

  it('the record-level facets — assignment, escalation — narrow to rows that have a record; `newest` is the party’s arrival order', async () => {
    await repository.findPage({ assignedToId: 'usr_ops', escalated: true }, 2, 10, 'newest');
    const call = prisma.advertiser.findMany.mock.calls[0]![0];
    expect(call.where.AND).toEqual([BASE, { kyc: { is: { assignedToId: 'usr_ops' } } }, { kyc: { is: { escalatedAt: { not: null } } } }]);
    expect(call).toMatchObject({ skip: 10, take: 10, orderBy: [{ createdAt: 'desc' }] });
  });
});

describe('the chips', () => {
  it('count parties per state with the state facet (and its aliases) removed — awaiting-documents parties counted', async () => {
    prisma.advertiser.count.mockImplementation(async ({ where }: { where: { AND: unknown[] } }) => (JSON.stringify(where.AND[1]).includes('"kyc":null') ? 2 : 1));
    const counts = await repository.countByState({ state: 'PENDING', status: 'PENDING', requested: true, q: 'x' });
    expect(counts).toEqual({ AWAITING_DOCUMENTS: 2, REQUESTED: 1, PENDING: 1, NEEDS_INFO: 1, REJECTED: 1, VERIFIED: 1 });
    expect(prisma.advertiser.count).toHaveBeenCalledTimes(6);
    for (const call of prisma.advertiser.count.mock.calls) {
      // the base, the state, the search — never the facet that was on the page
      expect(call[0].where.AND).toHaveLength(3);
      expect(call[0].where.AND[0]).toEqual(BASE);
    }
  });

  it('breaches are PENDING records past the cutoff; the requested chip is the REQUESTED state with the facets removed', async () => {
    await repository.countBreached({ state: 'PENDING' }, NOW);
    expect(prisma.advertiser.count).toHaveBeenLastCalledWith({
      where: { AND: [{ AND: [BASE, { kyc: { is: { status: 'PENDING', submittedAt: { not: null } } } }] }, { kyc: { is: { status: 'PENDING', submittedAt: { not: null, lt: NOW } } } }] },
    });
    await repository.countRequested({ state: 'PENDING', status: 'PENDING' });
    expect(prisma.advertiser.count).toHaveBeenLastCalledWith({ where: { AND: [BASE, { kyc: { is: { status: 'PENDING', submittedAt: null, requestedAt: { not: null } } } }] } });
  });
});

describe('the key — N3-B: the record belongs to the profile', () => {
  it('a write is addressed by the profile when there is one, else by the user; a created row carries both ids', async () => {
    prisma.advertiserKyc.upsert.mockResolvedValue({ id: 'akyc_1' });
    await repository.requestKyc({ advertiserProfileId: 'adv_swiggy', advertiserId: null }, { requestedById: 'usr_admin', requestedChannel: 'DIGIO', at: NOW });
    expect(prisma.advertiserKyc.upsert).toHaveBeenLastCalledWith({
      where: { advertiserProfileId: 'adv_swiggy' },
      update: { requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'DIGIO', advertiserProfileId: 'adv_swiggy' },
      create: { advertiserProfileId: 'adv_swiggy', advertiserId: null, requestedAt: NOW, requestedById: 'usr_admin', requestedChannel: 'DIGIO' },
    });
    await repository.resubmit({ advertiserProfileId: null, advertiserId: 'usr_legacy' }, { selfieUrl: 'https://x/s.png' });
    expect(prisma.advertiserKyc.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ where: { advertiserId: 'usr_legacy' } }));
    // A legacy row the service already holds is addressed by its id and adopts the profile key on the way.
    await repository.resubmit({ id: 'akyc_legacy', advertiserProfileId: 'adv_1', advertiserId: 'usr_legacy' }, { selfieUrl: 'https://x/s.png' });
    expect(prisma.advertiserKyc.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { id: 'akyc_legacy' }, update: expect.objectContaining({ advertiserProfileId: 'adv_1', advertiserId: 'usr_legacy', status: 'PENDING' }) }),
    );
    expect(() => repository.requestKyc({ advertiserProfileId: null, advertiserId: null }, { requestedById: 'usr_admin', requestedChannel: 'DIGIO', at: NOW })).toThrow();
  });

  it('the desk’s first recording for a profile with no user carries the profile alone', async () => {
    prisma.advertiserKyc.create.mockResolvedValue({ id: 'akyc_new' });
    await repository.createAtDesk({ advertiserProfileId: 'adv_swiggy', advertiserId: null }, { kycType: 'COMMERCIAL', panNumber: 'ABCDE1234F' }, { recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL', at: NOW });
    expect(prisma.advertiserKyc.create).toHaveBeenCalledWith({
      data: { advertiserProfileId: 'adv_swiggy', advertiserId: null, kycType: 'COMMERCIAL', panNumber: 'ABCDE1234F', status: 'PENDING', submittedAt: NOW, recordedById: 'usr_admin', recordedVia: 'DESK', method: 'MANUAL' },
    });
  });
});
