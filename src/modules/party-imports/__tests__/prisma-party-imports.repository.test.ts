import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lot S, the repository at the Prisma seam: the match reads are reads over
 * the parties' own tables — never a write — shaped into what the planner
 * needs; a print partner's number on a User that is not a partner is a
 * blocked mobile; an employee match carries its user id (the update
 * service is keyed by it); the list is on the list contract, per party;
 * the import's rows are stored under the party and read back only under it.
 */

type AnyFn = (...args: any[]) => any;

const { prisma } = vi.hoisted(() => ({
  prisma: {
    partyImport: { create: vi.fn<AnyFn>(), findMany: vi.fn<AnyFn>(), count: vi.fn<AnyFn>(), groupBy: vi.fn<AnyFn>(), findFirst: vi.fn<AnyFn>(), update: vi.fn<AnyFn>() },
    partyImportRow: { update: vi.fn<AnyFn>(), findMany: vi.fn<AnyFn>() },
    advertiser: { findMany: vi.fn<AnyFn>() },
    agentProfile: { findMany: vi.fn<AnyFn>() },
    printPartner: { findMany: vi.fn<AnyFn>() },
    employee: { findMany: vi.fn<AnyFn>() },
    user: { findMany: vi.fn<AnyFn>(), findUnique: vi.fn<AnyFn>() },
    // Lot U: the publisher's spots and rate card — reads only.
    publisher: { findUnique: vi.fn<AnyFn>() },
    listing: { findMany: vi.fn<AnyFn>() },
    mediaType: { findMany: vi.fn<AnyFn>() },
    sizeClass: { findMany: vi.fn<AnyFn>() },
    material: { findMany: vi.fn<AnyFn>() },
    city: { findFirst: vi.fn<AnyFn>() },
    order: { findMany: vi.fn<AnyFn>() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});
// The one thing the repository takes from `listings` is the slot-hold clause, a pure function.
vi.mock('../../listings', async (importOriginal) => {
  const { slotHoldingOrdersWhere } = await importOriginal<typeof import('../../listings')>();
  return { slotHoldingOrdersWhere, LISTING_CATEGORIES: ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] };
});

import { Prisma } from '../../../shared/database';
import { prismaPartyImportsRepository as repository } from '../prisma-party-imports.repository';

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of [prisma.advertiser, prisma.agentProfile, prisma.printPartner, prisma.employee, prisma.user, prisma.listing, prisma.mediaType, prisma.sizeClass, prisma.material, prisma.order]) table.findMany.mockResolvedValue([]);
  prisma.partyImportRow.findMany.mockResolvedValue([]);
});

describe('the import rows', () => {
  it('stores the batch under its party with VALIDATED and the counts, and reads it back only under that party', async () => {
    prisma.partyImport.create.mockResolvedValue({ id: 'imp_1' });
    await repository.createImport({
      party: 'AGENT',
      fileName: 'agents.csv',
      note: null,
      uploadedById: 'usr_admin',
      rows: [{ rowNumber: 2, data: { mobile: '+919000000001' }, outcome: 'CREATED', targetId: null, message: 'Will create' }],
      counts: { rowCount: 1, createdCount: 1, mergedCount: 0, skippedCount: 0, warningCount: 0, invalidCount: 0 },
    });
    expect(prisma.partyImport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ party: 'AGENT', status: 'VALIDATED', rowCount: 1, createdCount: 1, rows: { create: [expect.objectContaining({ rowNumber: 2, outcome: 'CREATED', targetId: null })] } }),
      }),
    );
    prisma.partyImport.findFirst.mockResolvedValue(null);
    await repository.findImport('ADVERTISER', 'imp_1');
    expect(prisma.partyImport.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'imp_1', party: 'ADVERTISER' } }));
  });

  it('lists per party on the list contract, with the status histogram over the party', async () => {
    prisma.partyImport.findMany.mockResolvedValue([{ id: 'imp_2' }]);
    prisma.partyImport.count.mockResolvedValue(3);
    prisma.partyImport.groupBy.mockResolvedValue([{ status: 'COMMITTED', _count: { _all: 2 } }, { status: 'VALIDATED', _count: { _all: 1 } }]);
    const page = await repository.listImports('EMPLOYEE', { status: ['COMMITTED'], page: 2, pageSize: 1 });
    expect(page).toEqual({ items: [{ id: 'imp_2' }], total: 3, page: 2, pageSize: 1, counts: { VALIDATED: 1, COMMITTED: 2, REVOKED: 0 } });
    expect(prisma.partyImport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { party: 'EMPLOYEE', status: { in: ['COMMITTED'] } }, skip: 1, take: 1 }));
    expect(prisma.partyImport.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { party: 'EMPLOYEE' } }));
  });

  it('stamps only what the commit wrote on the row', async () => {
    prisma.partyImportRow.update.mockResolvedValue({});
    await repository.stampRow('r1', { targetId: 'adv_1', data: { mobile: 'x', result: { action: 'CREATED' } } });
    expect(prisma.partyImportRow.update).toHaveBeenCalledWith({ where: { id: 'r1' }, data: { targetId: 'adv_1', data: { mobile: 'x', result: { action: 'CREATED' } } } });
  });
});

describe('the match reads', () => {
  it('advertisers: by mobile, by the KYC record\'s PAN and by GSTIN, the address as billingAddress', async () => {
    const row = { id: 'adv_1', displayId: 'ADV-1', mobile: '+919000000001', name: 'Fresh', email: null, type: 'COMMERCIAL', companyName: 'Fresh Co', industry: null, gstin: '27ABCDE1234F1Z5', billingAddress: '1 Lane', city: null, state: null, kyc: { panNumber: 'ABCDE1234F' } };
    prisma.advertiser.findMany.mockResolvedValue([row]);
    const match = await repository.matchAdvertisers({ mobiles: ['+919000000001'], pans: ['ABCDE1234F'], gstins: ['27ABCDE1234F1Z5'] });
    expect(match.byMobile[0]).toMatchObject({ id: 'adv_1', label: 'Fresh Co', fields: { address: '1 Lane', panNumber: 'ABCDE1234F', email: null, type: 'COMMERCIAL' } });
    expect(match.byPan.get('ABCDE1234F')?.id).toBe('adv_1');
    expect(match.byGstin.get('27ABCDE1234F1Z5')?.id).toBe('adv_1');
    expect(prisma.advertiser.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kyc: { is: { panNumber: { in: ['ABCDE1234F'] } } } } }));
    expect(match.blockedMobiles.size).toBe(0);
  });

  it('print partners: a number on a User that is not a partner is blocked; a partner\'s own number is a match; emails taken by their holder\'s mobile', async () => {
    prisma.printPartner.findMany.mockResolvedValue([
      { id: 'prt_1', userId: 'usr_prt', displayId: 'PRT-1', mobile: '+919000000001', name: 'Old Press', legalName: null, gstin: null, panNumber: null, contactName: null, email: null, address: null, city: null, capabilities: ['flex'], maxWidthFt: new Prisma.Decimal('12.50'), turnaroundDays: 3 },
    ]);
    prisma.user.findMany.mockImplementation(async ({ where }: { where: { mobile?: unknown; email?: unknown } }) =>
      where.mobile
        ? [{ id: 'usr_prt', mobile: '+919000000001' }, { id: 'usr_pub', mobile: '+919000000002' }]
        : [{ email: 'taken@x.in', mobile: '+919111111111' }],
    );
    const match = await repository.matchPrintPartners({ mobiles: ['+919000000001', '+919000000002'], pans: [], gstins: [], emails: ['taken@x.in'] });
    expect(match.byMobile[0]).toMatchObject({ id: 'prt_1', fields: { capabilities: 'flex', maxWidthFt: '12.5', turnaroundDays: '3' } });
    expect(match.blockedMobiles.get('+919000000002')).toContain('needs its own number');
    expect(match.blockedMobiles.has('+919000000001')).toBe(false);
    expect(match.takenEmails.get('taken@x.in')).toBe('+919111111111');
  });

  it('employees: matched through the user\'s mobile, carrying the user id; the user behind a mobile says whether it already has a record', async () => {
    prisma.employee.findMany.mockResolvedValue([{ id: 'emp_1', userId: 'usr_emp', displayId: 'EMP-1', department: 'Ops', designation: null, region: null, workMode: 'OFFICE', employmentType: null, user: { mobile: '+919000000001', name: 'Meera', email: 'meera@x.in' } }]);
    const match = await repository.matchEmployees({ mobiles: ['+919000000001'], emails: [] });
    expect(match.byMobile[0]).toMatchObject({ id: 'emp_1', userId: 'usr_emp', label: 'Meera', fields: { department: 'Ops', workMode: 'OFFICE', designation: null } });
    expect(prisma.employee.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { user: { mobile: { in: ['+919000000001'] } } } }));

    prisma.user.findUnique.mockResolvedValue({ id: 'usr_x', employeeProfile: null });
    await expect(repository.findUserByMobile('+919000000009')).resolves.toEqual({ id: 'usr_x', employeeId: null });
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(repository.findUserByMobile('+919000000009')).resolves.toBeNull();
  });

  it('agents: matched through the user\'s mobile; name and email are the User\'s, city and state the profile\'s', async () => {
    prisma.agentProfile.findMany.mockResolvedValue([{ id: 'agt_1', displayId: 'AGT-1', city: null, state: 'MH', user: { mobile: '+919000000001', name: 'Ravi', email: null } }]);
    const match = await repository.matchAgents({ mobiles: ['+919000000001'], emails: [] });
    expect(match.byMobile[0]).toEqual({ id: 'agt_1', displayId: 'AGT-1', mobile: '+919000000001', label: 'Ravi', fields: { name: 'Ravi', email: null, city: null, state: 'MH' } });
  });

  it('reads nothing when there is nothing to match', async () => {
    const match = await repository.matchAdvertisers({ mobiles: [], pans: [], gstins: [] });
    expect(match.byMobile).toEqual([]);
    expect(prisma.advertiser.findMany).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

/**
 * Lot U at the Prisma seam: the import is stored FOR a publisher and listed
 * per publisher; the attempt id is stamped once; the publisher's listings
 * are read with their merge keys and a two-decimal rate; the external
 * references come from the rows earlier LISTING imports committed; the
 * 25 m read is a bounding box per point, other publishers only, live
 * listings only; a running booking is an order holding a slot today.
 */
describe('Lot U: the publisher reads', () => {
  it('stores and lists an import under its publisher, and stamps the attempt', async () => {
    prisma.partyImport.create.mockResolvedValue({ id: 'imp_1' });
    await repository.createImport({
      party: 'LISTING',
      fileName: 'spots.csv',
      note: null,
      uploadedById: 'usr_admin',
      publisherId: 'pub_1',
      rows: [],
      counts: { rowCount: 0, createdCount: 0, mergedCount: 0, skippedCount: 0, warningCount: 0, invalidCount: 0 },
    });
    expect(prisma.partyImport.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ party: 'LISTING', publisherId: 'pub_1' }) }));

    prisma.partyImport.findMany.mockResolvedValue([]);
    prisma.partyImport.count.mockResolvedValue(0);
    prisma.partyImport.groupBy.mockResolvedValue([]);
    await repository.listImports('RATE_CARD', { publisherId: 'pub_1', page: 1, pageSize: 20 });
    expect(prisma.partyImport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { party: 'RATE_CARD', publisherId: 'pub_1' } }));
    expect(prisma.partyImport.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { party: 'RATE_CARD', publisherId: 'pub_1' } }));

    prisma.partyImport.update.mockResolvedValue({});
    await repository.setAttempt('imp_1', 'att_1');
    expect(prisma.partyImport.update).toHaveBeenCalledWith({ where: { id: 'imp_1' }, data: { attemptId: 'att_1' } });
  });

  it('reads the publisher\'s live listings with their merge keys, and the external references from committed LISTING rows', async () => {
    prisma.listing.findMany.mockResolvedValue([
      { id: 'lst_1', displayId: 'ADX-LST-00001', title: 'Old', address: '12, MG Road', latitude: 18.5, longitude: 73.8, ratePerDay: new Prisma.Decimal('1500'), slotsTotal: 1, status: 'ACTIVE', subType: null, description: 'x', city: 'Pune', size: null, mediaTypeId: 'mt_1', sizeClassId: null, materialId: null },
    ]);
    const own = await repository.listPublisherListings('pub_1');
    expect(own[0]).toMatchObject({ id: 'lst_1', ratePerDay: '1500.00', fields: { description: 'x', mediaTypeId: 'mt_1', sizeClassId: null } });
    expect(prisma.listing.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { publisherId: 'pub_1', status: { notIn: ['INACTIVE', 'REJECTED'] } } }));

    prisma.partyImportRow.findMany.mockResolvedValue([
      { targetId: 'lst_1', data: { externalRef: 'REF-1', title: 'Old' } },
      { targetId: 'lst_2', data: { title: 'No ref' } },
      { targetId: 'lst_3', data: { externalRef: '' } },
    ]);
    const refs = await repository.findExternalRefs('pub_1');
    expect([...refs.entries()]).toEqual([['REF-1', 'lst_1']]);
    expect(prisma.partyImportRow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { targetId: { not: null }, import: { party: 'LISTING', publisherId: 'pub_1', status: 'COMMITTED' } } }));
  });

  it('the 25 m read: a bounding box per point, other publishers only, live only; nothing read for no points', async () => {
    await expect(repository.findListingsNear([], 'pub_1', 25)).resolves.toEqual([]);
    expect(prisma.listing.findMany).not.toHaveBeenCalled();

    prisma.listing.findMany.mockResolvedValue([
      { id: 'lst_o', displayId: 'ADX-LST-00099', title: 'Rival', publisherId: 'pub_2', latitude: 18.52049, longitude: 73.85671 },
      { id: 'lst_n', displayId: null, title: 'No point', publisherId: 'pub_2', latitude: null, longitude: null },
    ]);
    const near = await repository.findListingsNear([{ latitude: 18.5205, longitude: 73.8567 }], 'pub_1', 25);
    expect(near).toEqual([{ id: 'lst_o', displayId: 'ADX-LST-00099', title: 'Rival', publisherId: 'pub_2', latitude: 18.52049, longitude: 73.85671 }]);
    const call = prisma.listing.findMany.mock.calls[0]![0] as { where: { OR: { latitude: { gte: number; lte: number }; longitude: { gte: number; lte: number } }[]; publisherId: unknown; status: unknown } };
    expect(call.where.publisherId).toEqual({ not: 'pub_1' });
    expect(call.where.status).toEqual({ notIn: ['INACTIVE', 'REJECTED'] });
    expect(call.where.OR).toHaveLength(1);
    // A box a little wider than 25 m — it over-selects and the service narrows to the radius.
    const box = call.where.OR[0]!;
    expect(box.latitude.lte - box.latitude.gte).toBeGreaterThan(0.0004);
    expect(box.latitude.lte - box.latitude.gte).toBeLessThan(0.001);
  });

  it('the vocabulary, the city id and the running bookings', async () => {
    prisma.mediaType.findMany.mockResolvedValue([{ id: 'mt_1', name: 'Hoarding', slug: 'hoarding', category: 'OUTDOOR' }]);
    prisma.sizeClass.findMany.mockResolvedValue([{ id: 'sc_1', name: '20 x 10 ft', slug: '20x10' }]);
    prisma.material.findMany.mockResolvedValue([{ id: 'mat_1', name: 'Flex', slug: 'flex' }]);
    await expect(repository.listSpotVocabulary()).resolves.toEqual({
      mediaTypes: [{ id: 'mt_1', name: 'Hoarding', slug: 'hoarding', category: 'OUTDOOR' }],
      sizeClasses: [{ id: 'sc_1', name: '20 x 10 ft', slug: '20x10' }],
      materials: [{ id: 'mat_1', name: 'Flex', slug: 'flex' }],
    });
    expect(prisma.mediaType.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'ACTIVE' } }));

    prisma.city.findFirst.mockResolvedValue({ id: 'city_1' });
    await expect(repository.findCityIdByName('pune')).resolves.toBe('city_1');
    expect(prisma.city.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { name: { equals: 'pune', mode: 'insensitive' } } }));

    await expect(repository.listingsWithRunningBooking([])).resolves.toEqual(new Set());
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    prisma.order.findMany.mockResolvedValue([{ listingId: 'lst_1' }]);
    const now = new Date('2026-09-15T10:00:00.000Z');
    await expect(repository.listingsWithRunningBooking(['lst_1', 'lst_2'], now)).resolves.toEqual(new Set(['lst_1']));
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ listingId: { in: ['lst_1', 'lst_2'] } }), distinct: ['listingId'] }));
  });
});
