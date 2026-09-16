import { Decimal } from '../../shared/money';
import { Prisma, prisma } from '../../shared/database';
import { listArgs } from '../../shared/pagination';
import type { PackagesRepository, TrialStart, TrialStartResult } from './packages.repository';
import { EXPIRING_WITHIN_DAYS, type PackageShelf } from './packages.schema';

/** The Prisma side of the packages port. */

const saleInclude = {
  lines: { orderBy: { amount: 'desc' as const } },
  advertiser: {
    select: { id: true, name: true, companyName: true, email: true, mobile: true, userId: true },
  },
  package: { select: { id: true, name: true, tier: true } },
} as const;

export const prismaPackagesRepository: PackagesRepository = {
  async commissionAmounts(incentiveIds) {
    if (incentiveIds.length === 0) return new Map();
    const rows = await prisma.agentIncentive.findMany({
      where: { id: { in: incentiveIds } },
      select: { id: true, amount: true },
    });
    return new Map(rows.map((row) => [row.id, new Decimal(row.amount)]));
  },

  async agentTier(agentId) {
    const row = await prisma.agentProfile.findUnique({ where: { id: agentId }, select: { tier: true } });
    return row?.tier ?? null;
  },

  listPackages(includeInactive = false) {
    return prisma.advertiserPackage.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { pricePerMonth: 'asc' }],
    });
  },

  findPackage(id) {
    return prisma.advertiserPackage.findUnique({ where: { id } });
  },

  findPackagesByIds(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.advertiserPackage.findMany({ where: { id: { in: [...ids] } } });
  },

  findPackageByTier(tier) {
    return prisma.advertiserPackage.findUnique({ where: { tier } });
  },

  upsertPackage(data) {
    const { tier, ...rest } = data;
    return prisma.advertiserPackage.upsert({
      where: { tier },
      update: rest,
      create: { tier, ...rest },
    });
  },

  updatePackage(tier, patch) {
    return prisma.advertiserPackage.update({ where: { tier }, data: patch });
  },

  listAddOns(includeInactive = false) {
    return prisma.packageAddOn.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { pricePerMonth: 'asc' }],
    });
  },

  findAddOnsByCode(codes) {
    if (codes.length === 0) return Promise.resolve([]);
    return prisma.packageAddOn.findMany({ where: { code: { in: codes }, isActive: true } });
  },

  findAddOnByCode(code) {
    return prisma.packageAddOn.findUnique({ where: { code } });
  },

  updateAddOn(code, patch) {
    return prisma.packageAddOn.update({ where: { code }, data: patch });
  },

  upsertAddOn(data) {
    const { code, ...rest } = data;
    return prisma.packageAddOn.upsert({
      where: { code },
      update: rest,
      create: { code, ...rest },
    });
  },

  createSale(data) {
    const { lines, ...sale } = data;
    return prisma.packageSale.create({
      data: { ...sale, lines: { create: lines } },
      include: saleInclude,
    });
  },

  findSale(id) {
    return prisma.packageSale.findUnique({ where: { id }, include: saleInclude });
  },

  findSaleByToken(paymentToken) {
    return prisma.packageSale.findUnique({ where: { paymentToken }, include: saleInclude });
  },

  findSaleByReference(reference) {
    return prisma.packageSale.findUnique({ where: { reference }, include: saleInclude });
  },

  async referenceExists(reference) {
    return (await prisma.packageSale.count({ where: { reference } })) > 0;
  },

  async tokenExists(paymentToken) {
    return (await prisma.packageSale.count({ where: { paymentToken } })) > 0;
  },

  updateSale(id, patch) {
    return prisma.packageSale.update({ where: { id }, data: patch, include: saleInclude });
  },

  async listSalesPage(filter) {
    const now = new Date();
    const soon = new Date(now.getTime() + EXPIRING_WITHIN_DAYS * 24 * 60 * 60 * 1000);

    // A plan can sit past its end date with nothing having moved its status
    // yet, so EXPIRED is "the column says so, or the date has passed".
    const shelfWhere = (shelf: PackageShelf | undefined): Prisma.PackageSaleWhereInput =>
      shelf === 'ACTIVE'
        ? { status: 'ACTIVE', OR: [{ endsAt: null }, { endsAt: { gt: soon } }] }
        : shelf === 'EXPIRING'
          ? { status: 'ACTIVE', endsAt: { gt: now, lte: soon } }
          : shelf === 'EXPIRED'
            ? { OR: [{ status: 'EXPIRED' }, { status: 'ACTIVE', endsAt: { lte: now } }] }
            : {};

    const base: Prisma.PackageSaleWhereInput = {
      ...(filter.advertiserId ? { advertiserId: filter.advertiserId } : {}),
      ...(filter.agentId ? { agentId: filter.agentId } : {}),
      ...(filter.q
        ? {
            OR: [
              { reference: { contains: filter.q, mode: 'insensitive' as const } },
              { packageName: { contains: filter.q, mode: 'insensitive' as const } },
              { advertiser: { name: { contains: filter.q, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const statusWhere: Prisma.PackageSaleWhereInput = filter.status?.length
      ? { status: { in: filter.status } }
      : {};
    const where: Prisma.PackageSaleWhereInput = {
      AND: [base, shelfWhere(filter.shelf), statusWhere],
    };

    // A plan with no renewal date sorts last on RENEWAL: the column is there
    // to work the ones that are coming up.
    const orderBy: Prisma.PackageSaleOrderByWithRelationInput =
      filter.sort === 'OLDEST'
        ? { createdAt: 'asc' }
        : filter.sort === 'RENEWAL'
          ? { nextBillingAt: { sort: 'asc', nulls: 'last' } }
          : filter.sort === 'VALUE_DESC'
            ? { total: 'desc' } // non-nullable, so no nulls-last to state
            : { createdAt: 'desc' };

    // Each chip counted over the search but never over the chip in force.
    const [items, total, active, expiring, expired] = await Promise.all([
      prisma.packageSale.findMany({ where, orderBy, ...listArgs(filter), include: saleInclude }),
      prisma.packageSale.count({ where }),
      prisma.packageSale.count({ where: { AND: [base, shelfWhere('ACTIVE')] } }),
      prisma.packageSale.count({ where: { AND: [base, shelfWhere('EXPIRING')] } }),
      prisma.packageSale.count({ where: { AND: [base, shelfWhere('EXPIRED')] } }),
    ]);
    return { items, total, counts: { ACTIVE: active, EXPIRING: expiring, EXPIRED: expired } };
  },

  listSales(filter) {
    return prisma.packageSale.findMany({
      where: {
        ...(filter.advertiserId ? { advertiserId: filter.advertiserId } : {}),
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        ...(filter.status ? { status: { in: filter.status } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
      include: saleInclude,
    });
  },

  advertiserContext(advertiserId) {
    return prisma.advertiser.findUnique({
      where: { id: advertiserId },
      select: { id: true, agentId: true },
    });
  },

  findActiveSale(advertiserId, now) {
    return prisma.packageSale.findFirst({
      where: {
        advertiserId,
        status: 'ACTIVE',
        // Lot J2: a term queued after the current one (QUEUE_AFTER_TERM) is
        // ACTIVE with a start still ahead; it is not the live plan yet.
        startsAt: { lte: now },
        // A term that has run out is not active, whatever the column says —
        // the sweep that flips it may not have run yet.
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
      orderBy: { startsAt: 'desc' },
      include: saleInclude,
    });
  },

  findActiveSales(advertiserIds, now) {
    if (advertiserIds.length === 0) return Promise.resolve([]);
    return prisma.packageSale.findMany({
      where: {
        advertiserId: { in: [...advertiserIds] },
        status: 'ACTIVE',
        startsAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gte: now } }],
      },
      orderBy: { startsAt: 'desc' },
      include: saleInclude,
    });
  },

  findExpiredSales(now) {
    return prisma.packageSale.findMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } },
      take: 500,
      include: saleInclude,
    });
  },

  /* ── Lot J2 ─────────────────────────────────────────────────────── */

  findLapsedSale(advertiserId, since, at) {
    return prisma.packageSale.findFirst({
      where: { advertiserId, status: { in: ['ACTIVE', 'EXPIRED'] }, endsAt: { gt: since, lte: at } },
      orderBy: { endsAt: 'desc' },
      include: saleInclude,
    });
  },

  findLapsedSales(advertiserIds, since, at) {
    if (advertiserIds.length === 0) return Promise.resolve([]);
    return prisma.packageSale.findMany({
      where: { advertiserId: { in: [...advertiserIds] }, status: { in: ['ACTIVE', 'EXPIRED'] }, endsAt: { gt: since, lte: at } },
      orderBy: { endsAt: 'desc' },
      include: saleInclude,
    });
  },

  async hasEverHeldSale(advertiserId) {
    return (await prisma.packageSale.count({ where: { advertiserId, status: { in: ['ACTIVE', 'EXPIRED'] } } })) > 0;
  },

  async startTrial(input: TrialStart): Promise<TrialStartResult> {
    return prisma.$transaction(async (tx) => {
      // Lot K (B2): the per-advertiser lock first, so the history read below
      // sees every trial start that got here before this one.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.advertiserId}))`;
      const held = await tx.packageSale.count({ where: { advertiserId: input.advertiserId, status: { in: ['ACTIVE', 'EXPIRED'] } } });
      if (held > 0) return { started: false, sale: null };
      const { lines, ...sale } = input.sale;
      const created = await tx.packageSale.create({
        data: {
          ...sale,
          lines: { create: lines },
          status: 'ACTIVE',
          paidAt: input.now,
          paidMethod: 'TRIAL',
          paidReference: null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          nextBillingAt: input.endsAt,
          incentiveId: null,
        },
        include: saleInclude,
      });
      return { started: true, sale: created };
    });
  },

  findEndingBetween(from, to) {
    return prisma.packageSale.findMany({
      where: { status: { in: ['ACTIVE', 'EXPIRED'] }, endsAt: { gt: from, lte: to } },
      orderBy: { endsAt: 'asc' },
      take: 500,
      include: saleInclude,
    });
  },

  async hasSuccessorSale(advertiserId, at, excludeId) {
    const row = await prisma.packageSale.findFirst({
      where: {
        advertiserId,
        id: { not: excludeId },
        status: 'ACTIVE',
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
      },
      select: { id: true },
    });
    return row !== null;
  },

  findSaleStartingAt(advertiserId, tier, startsAt) {
    return prisma.packageSale.findFirst({
      where: { advertiserId, tier, startsAt, status: { in: ['PENDING_PAYMENT', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  },

  async noticeSent(userId, relatedId, title) {
    const row = await prisma.notification.findFirst({ where: { userId, relatedId, title }, select: { id: true } });
    return row !== null;
  },
};
