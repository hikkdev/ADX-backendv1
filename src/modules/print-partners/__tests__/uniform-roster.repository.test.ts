import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 29 Sep 2026 — the party rosters, made uniform: what `listPartners` asks
 * the database. Every cut is one AND part — the city's `OR` and the
 * search's `OR` used to sit side by side in one object, where the search's
 * overwrote the city's; the door is read off `appliedAt` and the party
 * import's CREATED rows; the jobs are counted in the same query.
 */

const { prisma } = vi.hoisted(() => ({
  prisma: {
    printPartner: { findMany: vi.fn(), count: vi.fn() },
    partyImportRow: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

vi.mock('../../../shared/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/database')>();
  return { ...actual, prisma };
});

import { kycRosterStateWhere } from '../../../shared/kyc-state';
import { prismaPrintPartnersRepository as repository } from '../prisma-print-partners.repository';

const committed = new Date('2026-09-18T12:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  prisma.printPartner.findMany.mockResolvedValue([
    { id: 'prt_1', userId: 'usr_1', name: 'Balaji Prints', isActive: true, _count: { jobs: 4 } },
    { id: 'prt_2', userId: 'usr_2', name: 'Sharma Flex', isActive: true, _count: { jobs: 0 } },
  ]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.printPartner.count.mockResolvedValue(2);
  prisma.partyImportRow.findMany.mockImplementation(async ({ where }: { where: { targetId: unknown } }) =>
    // The door's id list (targetId not null) and the page's lookup (targetId in [...]) both name prt_2.
    'in' in (where.targetId as object) ? [{ targetId: 'prt_2', import: { committedAt: committed, createdAt: committed } }] : [{ targetId: 'prt_2' }],
  );
});

const parts = () => prisma.printPartner.findMany.mock.calls[0]![0].where.AND[0].AND as Record<string, unknown>[];

describe('listPartners', () => {
  it('keeps the city and the search as separate AND parts, and adds the KYC state', async () => {
    await repository.listPartners({ q: '+91 98450 12345', city: 'Pune', cityId: 'city_pune', kycState: 'VERIFIED', page: 1, pageSize: 100 });
    expect(parts()).toContainEqual({ OR: [{ cityId: 'city_pune' }, { cityId: null, city: { equals: 'Pune', mode: 'insensitive' } }] });
    // The roster's VERIFIED takes in a legacy row too — no record, a VERIFIED mirror — as the pill reads it.
    expect(parts()).toContainEqual(kycRosterStateWhere('VERIFIED', true));
    expect(kycRosterStateWhere('VERIFIED', true).OR).toContainEqual({ kyc: null, kycStatus: 'VERIFIED' });
    const search = parts().find((part) => Array.isArray(part['OR']) && (part['OR'] as object[]).some((clause) => 'legalName' in clause)) as { OR: unknown[] };
    expect(search.OR).toContainEqual({ mobile: { contains: '9845012345' } });
    expect(search.OR).toContainEqual({ email: { contains: '+91 98450 12345', mode: 'insensitive' } });
  });

  it('reads the door: SELF applied, IMPORT created by an import, DESK the rest, AGENT nobody', async () => {
    await repository.listPartners({ onboardedVia: 'SELF', page: 1, pageSize: 20 });
    expect(parts()).toContainEqual({ appliedAt: { not: null } });

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ onboardedVia: 'IMPORT', page: 1, pageSize: 20 });
    expect(parts()).toContainEqual({ appliedAt: null, id: { in: ['prt_2'] } });
    expect(prisma.partyImportRow.findMany).toHaveBeenCalledWith({
      where: { outcome: 'CREATED', targetId: { not: null }, import: { party: 'PRINT_PARTNER' } },
      select: { targetId: true },
    });

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ onboardedVia: 'DESK', page: 1, pageSize: 20 });
    expect(parts()).toContainEqual({ appliedAt: null, id: { notIn: ['prt_2'] } });

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ onboardedVia: 'AGENT', page: 1, pageSize: 20 });
    expect(parts()).toContainEqual({ id: { in: [] } });
  });

  it('passes the PP-1 applications facet through as its own part', async () => {
    await repository.listPartners({ applied: true, page: 1, pageSize: 20 });
    expect(parts()).toContainEqual({ appliedAt: { not: null }, activatedAt: null });
  });

  it('counts the jobs in the same query and marks the rows an import created', async () => {
    const page = await repository.listPartners({ page: 1, pageSize: 20 });
    const [args] = prisma.printPartner.findMany.mock.calls[0]!;
    expect(args.include).toEqual({ _count: { select: { jobs: true } } });
    expect(page.items).toEqual([
      { id: 'prt_1', userId: 'usr_1', name: 'Balaji Prints', isActive: true, jobCount: 4, importedAt: null, accountState: 'ACTIVE' },
      { id: 'prt_2', userId: 'usr_2', name: 'Sharma Flex', isActive: true, jobCount: 0, importedAt: committed, accountState: 'ACTIVE' },
    ]);
  });

  it('counts the active chips over the cuts without the active facet', async () => {
    await repository.listPartners({ kycState: 'PENDING', active: true, page: 1, pageSize: 20 });
    const [findArgs] = prisma.printPartner.findMany.mock.calls[0]!;
    expect(findArgs.where.AND).toContainEqual({ isActive: true });
    const base = findArgs.where.AND[0];
    expect(prisma.printPartner.count).toHaveBeenCalledWith({ where: { AND: [base, { isActive: true }] } });
    expect(prisma.printPartner.count).toHaveBeenCalledWith({ where: { AND: [base, { isActive: false }] } });
  });

  it('counts the active chips the same way when the Status is sent instead', async () => {
    await repository.listPartners({ status: 'DEACTIVATED', page: 1, pageSize: 20 });
    const base = prisma.printPartner.findMany.mock.calls[0]![0].where.AND[0];
    expect(prisma.printPartner.count).toHaveBeenCalledWith({ where: { AND: [base, { isActive: true }] } });
    expect(prisma.printPartner.count).toHaveBeenCalledWith({ where: { AND: [base, { isActive: false }] } });
  });
});

/**
 * Account lifecycle (2 Oct 2026): the Status every party roster takes. A
 * print partner has no relation to its User, so the closed accounts are read
 * beside the roster — the PARTNER users with `closedAt` — and the cut, the
 * chips and each row's pill all read that one set.
 */
describe('listPartners — the Status', () => {
  const closedAt = new Date('2026-10-01T09:00:00.000Z');

  beforeEach(() => {
    prisma.user.findMany.mockResolvedValue([{ id: 'usr_2', closedAt }]);
    prisma.printPartner.findMany.mockResolvedValue([
      { id: 'prt_1', userId: 'usr_1', name: 'Balaji Prints', isActive: true, _count: { jobs: 4 } },
      // Closure turns the row's switch off too — the closure reads first.
      { id: 'prt_2', userId: 'usr_2', name: 'Sharma Flex', isActive: false, _count: { jobs: 0 } },
      { id: 'prt_3', userId: 'usr_3', name: 'Kiran Signs', isActive: false, _count: { jobs: 1 } },
    ]);
  });

  const facet = () => prisma.printPartner.findMany.mock.calls[0]![0].where.AND.slice(1) as unknown[];

  it('reads the closed PARTNER accounts once, beside the roster', async () => {
    await repository.listPartners({ page: 1, pageSize: 20 });
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { closedAt: { not: null }, roles: { some: { role: 'PARTNER' } } },
      select: { id: true, closedAt: true },
    });
  });

  it('marks each row CLOSED when its account is closed, DEACTIVATED off the roster, else ACTIVE', async () => {
    const page = await repository.listPartners({ page: 1, pageSize: 20 });
    expect(page.items.map((row) => [row.id, row.accountState])).toEqual([
      ['prt_1', 'ACTIVE'],
      ['prt_2', 'CLOSED'],
      ['prt_3', 'DEACTIVATED'],
    ]);
  });

  it('cuts ACTIVE, DEACTIVATED and CLOSED by the switch and the closed accounts, and ALL not at all', async () => {
    await repository.listPartners({ status: 'ACTIVE', page: 1, pageSize: 20 });
    expect(facet()).toEqual([{ isActive: true, userId: { notIn: ['usr_2'] } }]);

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ status: 'DEACTIVATED', page: 1, pageSize: 20 });
    expect(facet()).toEqual([{ isActive: false, userId: { notIn: ['usr_2'] } }]);

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ status: 'CLOSED', page: 1, pageSize: 20 });
    expect(facet()).toEqual([{ userId: { in: ['usr_2'] } }]);

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ status: 'ALL', page: 1, pageSize: 20 });
    expect(facet()).toEqual([]);
  });

  it('lets the Status win over `active=` when both are sent, and keeps `active=` exactly as it cut alone', async () => {
    await repository.listPartners({ status: 'CLOSED', active: true, page: 1, pageSize: 20 });
    expect(facet()).toEqual([{ userId: { in: ['usr_2'] } }]);

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ status: 'ALL', active: false, page: 1, pageSize: 20 });
    expect(facet()).toEqual([]);

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ active: false, page: 1, pageSize: 20 });
    expect(facet()).toEqual([{ isActive: false }]);

    prisma.printPartner.findMany.mockClear();
    await repository.listPartners({ page: 1, pageSize: 20 });
    expect(facet()).toEqual([]);
  });

  it('counts each state over the cuts with the Status removed', async () => {
    prisma.printPartner.count.mockImplementation(async ({ where }: { where: { AND: unknown[] } }) => {
      const part = JSON.stringify(where.AND[1] ?? null);
      if (part === JSON.stringify({ userId: { in: ['usr_2'] } })) return 1;
      if (part === JSON.stringify({ isActive: false, userId: { notIn: ['usr_2'] } })) return 2;
      if (part === JSON.stringify({ isActive: true, userId: { notIn: ['usr_2'] } })) return 5;
      return 99;
    });
    const page = await repository.listPartners({ kycState: 'PENDING', status: 'CLOSED', page: 1, pageSize: 20 });
    expect(page.statusCounts).toEqual({ ACTIVE: 5, DEACTIVATED: 2, CLOSED: 1 });
    const base = prisma.printPartner.findMany.mock.calls[0]![0].where.AND[0];
    expect(prisma.printPartner.count).toHaveBeenCalledWith({ where: { AND: [base, { isActive: true, userId: { notIn: ['usr_2'] } }] } });
    expect(prisma.printPartner.count).toHaveBeenCalledWith({ where: { AND: [base, { isActive: false, userId: { notIn: ['usr_2'] } }] } });
    expect(prisma.printPartner.count).toHaveBeenCalledWith({ where: { AND: [base, { userId: { in: ['usr_2'] } }] } });
  });
});
