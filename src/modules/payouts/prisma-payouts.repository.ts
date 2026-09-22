import { Prisma, prisma } from '../../shared/database';
import {
  PAYOUT_BATCH_STATUSES,
  type BatchView,
  type NewMethod,
  type NewWithdrawal,
  type PayoutsRepository,
  type WithdrawalListFilter,
  type WithdrawalPatch,
  type WithdrawalRow,
} from './payouts.repository';

const ZERO = new Prisma.Decimal(0);

const withdrawalInclude = {
  payoutMethod: true,
  wallet: {
    select: {
      id: true,
      balance: true,
      goodwill: true,
      publisherId: true,
      agentId: true,
      advertiserId: true,
      printPartnerId: true,
      frozenAt: true,
      publisher: { select: { name: true } },
      agent: { select: { user: { select: { name: true } } } },
      advertiser: { select: { name: true, companyName: true } },
      printPartner: { select: { name: true } },
    },
  },
} as const;

const WITHDRAWAL_STATUSES = ['REQUESTED', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'FAILED', 'CANCELLED'] as const;

function withdrawalWhere(filter: Omit<WithdrawalListFilter, 'limit'>): Prisma.WithdrawalRequestWhereInput {
  const partyWhere: Prisma.WithdrawalRequestWhereInput =
    filter.partyKind === 'PUBLISHER'
      ? { wallet: { publisherId: { not: null } } }
      : filter.partyKind === 'AGENT'
        ? { wallet: { agentId: { not: null } } }
        : filter.partyKind === 'ADVERTISER'
          ? { wallet: { advertiserId: { not: null } } }
          : filter.partyKind === 'PRINT_PARTNER'
            ? { wallet: { printPartnerId: { not: null } } }
            : {};
  const q = filter.q?.trim();
  return {
    ...(filter.walletId ? { walletId: filter.walletId } : {}),
    ...(filter.batchId ? { batchId: filter.batchId } : {}),
    // E6: one party's lines, and the paid-out window.
    ...(filter.publisherId ? { wallet: { publisherId: filter.publisherId } } : {}),
    ...(filter.agentId ? { wallet: { agentId: filter.agentId } } : {}),
    ...(filter.paidFrom || filter.paidTo
      ? { paidAt: { ...(filter.paidFrom ? { gte: filter.paidFrom } : {}), ...(filter.paidTo ? { lte: filter.paidTo } : {}) } }
      : {}),
    ...(filter.status?.length ? { status: { in: filter.status } } : {}),
    ...partyWhere,
    ...(filter.from || filter.to
      ? { requestedAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } }
      : {}),
    ...(q
      ? {
          OR: [
            { reference: { contains: q, mode: 'insensitive' } },
            { railReference: { contains: q, mode: 'insensitive' } },
            { wallet: { publisher: { name: { contains: q, mode: 'insensitive' } } } },
            { wallet: { agent: { user: { name: { contains: q, mode: 'insensitive' } } } } },
            { wallet: { advertiser: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { companyName: { contains: q, mode: 'insensitive' } }] } } },
            { wallet: { printPartner: { name: { contains: q, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };
}

export const prismaPayoutsRepository: PayoutsRepository = {
  /* ── Who the wallet belongs to ─────────────────────────────────── */

  async findPartyContext(walletId) {
    const contact = { select: { name: true, email: true, mobile: true, isActive: true } } as const;
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
      include: {
        publisher: {
          select: { id: true, name: true, userId: true, createdAt: true, sizeBand: true, kycStatus: true, user: contact },
        },
        agent: {
          select: {
            id: true,
            userId: true,
            createdAt: true,
            tier: true,
            user: contact,
            kyc: { select: { status: true } },
          },
        },
        advertiser: {
          select: { id: true, name: true, companyName: true, userId: true, createdAt: true, kycStatus: true, user: contact },
        },
        printPartner: {
          select: { id: true, name: true, userId: true, createdAt: true, isActive: true, email: true, mobile: true },
        },
      },
    });
    if (!wallet) return null;

    if (wallet.publisher) {
      return {
        kind: 'PUBLISHER',
        entityId: wallet.publisher.id,
        walletId: wallet.id,
        userId: wallet.publisher.userId,
        name: wallet.publisher.name,
        onboardedAt: wallet.publisher.createdAt,
        sizeBand: wallet.publisher.sizeBand,
        tier: null,
        kycStatus: wallet.publisher.kycStatus,
        userActive: wallet.publisher.user?.isActive ?? null,
        email: wallet.publisher.user?.email ?? null,
        mobile: wallet.publisher.user?.mobile ?? null,
      };
    }
    if (wallet.agent) {
      return {
        kind: 'AGENT',
        entityId: wallet.agent.id,
        walletId: wallet.id,
        userId: wallet.agent.userId,
        name: wallet.agent.user?.name ?? 'Agent',
        onboardedAt: wallet.agent.createdAt,
        // Agents are not on the publisher size ladder; the individual rungs are
        // the right shape for a person being paid incentives.
        sizeBand: 'INDIVIDUAL',
        tier: wallet.agent.tier ?? null,
        kycStatus: wallet.agent.kyc?.status ?? null,
        userActive: wallet.agent.user?.isActive ?? null,
        email: wallet.agent.user?.email ?? null,
        mobile: wallet.agent.user?.mobile ?? null,
      };
    }
    if (wallet.advertiser) {
      return {
        kind: 'ADVERTISER',
        entityId: wallet.advertiser.id,
        walletId: wallet.id,
        userId: wallet.advertiser.userId,
        name: wallet.advertiser.companyName ?? wallet.advertiser.name,
        onboardedAt: wallet.advertiser.createdAt,
        sizeBand: 'INDIVIDUAL',
        tier: null,
        kycStatus: wallet.advertiser.kycStatus,
        userActive: wallet.advertiser.user?.isActive ?? null,
        email: wallet.advertiser.user?.email ?? null,
        mobile: wallet.advertiser.user?.mobile ?? null,
      };
    }
    if (wallet.printPartner) {
      return {
        kind: 'PRINT_PARTNER',
        entityId: wallet.printPartner.id,
        walletId: wallet.id,
        userId: wallet.printPartner.userId,
        name: wallet.printPartner.name,
        onboardedAt: wallet.printPartner.createdAt,
        // Lot B (B4b): a print shop is a business paid at cost, per job — the
        // individual rung's ₹5,000 a day would hold up a single banner run.
        sizeBand: 'SMALL_AGENCY',
        tier: null,
        // No KYC record: ops vets a partner at the desk (GSTIN, PAN) and the
        // batch preflight does not ask. The User row is sign-in-disabled by
        // design, so the partner's own switch stands in for `userActive`.
        kycStatus: null,
        userActive: wallet.printPartner.isActive,
        email: wallet.printPartner.email,
        mobile: wallet.printPartner.mobile,
      };
    }
    return null;
  },

  async findWalletForUser(userId) {
    const publisher = await prisma.publisher.findFirst({
      where: { userId },
      select: { wallet: { select: { id: true } } },
    });
    if (publisher?.wallet) return { id: publisher.wallet.id, kind: 'PUBLISHER' };

    const agent = await prisma.agentProfile.findUnique({
      where: { userId },
      select: { wallet: { select: { id: true } } },
    });
    if (agent?.wallet) return { id: agent.wallet.id, kind: 'AGENT' };

    const partner = await prisma.printPartner.findUnique({
      where: { userId },
      select: { wallet: { select: { id: true } } },
    });
    if (partner?.wallet) return { id: partner.wallet.id, kind: 'PRINT_PARTNER' };
    return null;
  },

  async findPublisherIdForUser(userId) {
    const publisher = await prisma.publisher.findFirst({ where: { userId }, select: { id: true } });
    return publisher?.id ?? null;
  },

  /* ── Methods ───────────────────────────────────────────────────── */

  findMethodsForUser(userId) {
    return prisma.payoutMethod.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  },

  findMethod(id) {
    return prisma.payoutMethod.findUnique({ where: { id } });
  },

  countMethodsForUser(userId) {
    return prisma.payoutMethod.count({ where: { userId } });
  },

  createMethod(data: NewMethod) {
    return prisma.payoutMethod.create({
      data: {
        userId: data.userId,
        type: data.type,
        accountHolder: data.accountHolder ?? null,
        bankName: data.bankName ?? null,
        accountNumber: data.accountNumber ?? null,
        ifscCode: data.ifscCode ?? null,
        bankBranch: data.bankBranch ?? null,
        ifscVerifiedAt: data.ifscVerifiedAt ?? null,
        upiVpa: data.upiVpa ?? null,
        isDefault: data.isDefault,
      },
    });
  },

  updateMethod(id, patch) {
    return prisma.payoutMethod.update({ where: { id }, data: patch as never });
  },

  async removeMethod(id) {
    await prisma.payoutMethod.delete({ where: { id } });
  },

  /** One default per user, enforced by doing both writes in one transaction. */
  setDefaultMethod(userId, id) {
    return prisma.$transaction(async (tx) => {
      await tx.payoutMethod.updateMany({
        where: { userId, isDefault: true },
        data: { isDefault: false },
      });
      return tx.payoutMethod.update({ where: { id }, data: { isDefault: true } });
    });
  },

  listMethodsByStatus(status, limit) {
    return prisma.payoutMethod.findMany({
      where: { status },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  },

  /* ── Limits ────────────────────────────────────────────────────── */

  listLimits() {
    return prisma.withdrawalLimit.findMany({ orderBy: [{ band: 'asc' }, { minMonths: 'asc' }] });
  },

  upsertLimit(data) {
    return prisma.withdrawalLimit.upsert({
      where: { band_minMonths: { band: data.band, minMonths: data.minMonths } },
      create: data,
      update: { dailyCap: data.dailyCap },
    });
  },

  /* ── Tax ───────────────────────────────────────────────────────── */

  findTaxRate(appliesTo, on) {
    return prisma.taxWithholdingRate.findFirst({
      where: {
        appliesTo,
        effectiveFrom: { lte: on },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: on } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
  },

  listTaxRates() {
    return prisma.taxWithholdingRate.findMany({
      orderBy: [{ appliesTo: 'asc' }, { effectiveFrom: 'desc' }],
    });
  },

  createTaxRate(data) {
    return prisma.taxWithholdingRate.create({
      data: {
        appliesTo: data.appliesTo,
        section: data.section,
        ratePct: data.ratePct,
        effectiveFrom: data.effectiveFrom,
        note: data.note ?? null,
      },
    });
  },

  closeTaxRate(id, effectiveTo) {
    return prisma.taxWithholdingRate.update({ where: { id }, data: { effectiveTo } });
  },

  /* ── Withdrawals ───────────────────────────────────────────────── */

  createWithdrawal(data: NewWithdrawal): Promise<WithdrawalRow> {
    return prisma.withdrawalRequest.create({
      data,
      include: withdrawalInclude,
    }) as Promise<WithdrawalRow>;
  },

  findWithdrawal(id) {
    return prisma.withdrawalRequest.findUnique({
      where: { id },
      include: withdrawalInclude,
    }) as Promise<WithdrawalRow | null>;
  },

  updateWithdrawal(id, patch: WithdrawalPatch) {
    return prisma.withdrawalRequest.update({
      where: { id },
      data: patch,
      include: withdrawalInclude,
    }) as Promise<WithdrawalRow>;
  },

  listWithdrawals(filter) {
    return prisma.withdrawalRequest.findMany({
      where: withdrawalWhere(filter),
      include: withdrawalInclude,
      orderBy: { requestedAt: 'desc' },
      take: filter.limit,
    }) as Promise<WithdrawalRow[]>;
  },

  findWithdrawals(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.withdrawalRequest.findMany({
      where: { id: { in: ids } },
      include: withdrawalInclude,
    }) as Promise<WithdrawalRow[]>;
  },

  async withdrawalSummary(processingSince, month) {
    const [groups, stale, reserved, processing, paid] = await Promise.all([
      prisma.withdrawalRequest.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.withdrawalRequest.count({ where: { status: 'PROCESSING', updatedAt: { lt: processingSince } } }),
      // E6: the three totals the queue's header prints.
      prisma.withdrawalRequest.aggregate({ where: { status: { in: ['REQUESTED', 'APPROVED'] } }, _sum: { amount: true } }),
      prisma.withdrawalRequest.aggregate({ where: { status: 'PROCESSING' }, _sum: { netAmount: true } }),
      prisma.withdrawalRequest.aggregate({
        where: { status: 'PAID', paidAt: { gte: month.start, lt: month.end } },
        _sum: { netAmount: true },
      }),
    ]);
    const counts: Record<string, number> = {};
    for (const status of WITHDRAWAL_STATUSES) counts[status] = 0;
    for (const group of groups) counts[group.status] = group._count._all;
    return {
      counts,
      processingOver24h: stale,
      reservedTotal: reserved._sum.amount ?? ZERO,
      processingTotal: processing._sum.netAmount ?? ZERO,
      paidThisMonth: paid._sum.netAmount ?? ZERO,
    };
  },

  async sumPaidWithdrawals(filter) {
    const result = await prisma.withdrawalRequest.aggregate({
      where: {
        status: 'PAID',
        ...(filter.publisherId ? { wallet: { publisherId: filter.publisherId } } : {}),
        ...(filter.agentId ? { wallet: { agentId: filter.agentId } } : {}),
        ...(filter.paidFrom || filter.paidTo
          ? { paidAt: { ...(filter.paidFrom ? { gte: filter.paidFrom } : {}), ...(filter.paidTo ? { lt: filter.paidTo } : {}) } }
          : {}),
      },
      _sum: { netAmount: true },
      _count: true,
    });
    return { total: result._sum.netAmount ?? ZERO, count: result._count };
  },

  findWithdrawalByRailReference(railReference) {
    return prisma.withdrawalRequest.findFirst({
      where: { railReference },
      include: withdrawalInclude,
      orderBy: { paidAt: 'desc' },
    }) as Promise<WithdrawalRow | null>;
  },

  findWithdrawalByReference(reference) {
    return prisma.withdrawalRequest.findUnique({
      where: { reference },
      include: withdrawalInclude,
    }) as Promise<WithdrawalRow | null>;
  },

  async referenceExists(reference) {
    return (await prisma.withdrawalRequest.count({ where: { reference } })) > 0;
  },

  countForYear(year) {
    return prisma.withdrawalRequest.count({
      where: {
        createdAt: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
    });
  },

  /**
   * Open means money is spoken for and still in the balance: requested or
   * approved (reserved). Lot B (Q140): a PROCESSING line was debited at
   * release, so it is no longer counted here.
   */
  async sumOpen(walletId) {
    const result = await prisma.withdrawalRequest.aggregate({
      where: { walletId, status: { in: ['REQUESTED', 'APPROVED'] } },
      _sum: { amount: true },
    });
    return result._sum.amount ?? ZERO;
  },

  /* ── Payout batches (Lot B, Q140) ───────────────────────────────── */

  createBatch(data) {
    return prisma.payoutBatch.create({
      data: {
        reference: data.reference,
        rail: data.rail,
        bankAccountId: data.bankAccountId,
        createdByUserId: data.createdByUserId,
        cutoffAt: data.cutoffAt ?? null,
        scheduledFor: data.scheduledFor ?? null,
        note: data.note ?? null,
      },
    });
  },

  async findBatch(id) {
    const batch = await prisma.payoutBatch.findUnique({
      where: { id },
      include: { lines: { include: withdrawalInclude, orderBy: { requestedAt: 'asc' } } },
    });
    if (!batch) return null;
    const bankAccount = batch.bankAccountId
      ? await prisma.bankAccount.findUnique({ where: { id: batch.bankAccountId } })
      : null;
    return { ...batch, bankAccount } as BatchView;
  },

  updateBatch(id, patch) {
    return prisma.payoutBatch.update({ where: { id }, data: patch });
  },

  async listBatches(filter) {
    const base: Prisma.PayoutBatchWhereInput = filter.q
      ? { reference: { contains: filter.q, mode: 'insensitive' } }
      : {};
    const where: Prisma.PayoutBatchWhereInput = {
      ...base,
      ...(filter.status?.length ? { status: { in: filter.status } } : {}),
    };
    const [items, total, groups] = await Promise.all([
      prisma.payoutBatch.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      prisma.payoutBatch.count({ where }),
      // Counted with the status facet removed, so the chips stay a way out.
      prisma.payoutBatch.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    const counts: Record<string, number> = {};
    for (const status of PAYOUT_BATCH_STATUSES) counts[status] = 0;
    for (const group of groups) counts[group.status] = group._count._all;
    return { items, total, counts };
  },

  async batchReferenceExists(reference) {
    return (await prisma.payoutBatch.count({ where: { reference } })) > 0;
  },

  countBatchesForYear(year) {
    return prisma.payoutBatch.count({
      where: {
        createdAt: {
          gte: new Date(Date.UTC(year, 0, 1)),
          lt: new Date(Date.UTC(year + 1, 0, 1)),
        },
      },
    });
  },

  findDraftableWithdrawals(limit) {
    return prisma.withdrawalRequest.findMany({
      where: {
        status: 'APPROVED',
        payoutMethod: { status: 'VERIFIED' },
        OR: [{ batchId: null }, { batch: { status: { notIn: ['DRAFT', 'IN_REVIEW', 'APPROVED', 'RELEASING'] } } }],
      },
      include: withdrawalInclude,
      orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    }) as Promise<WithdrawalRow[]>;
  },

  findLatestBatchByNote(notePrefix) {
    return prisma.payoutBatch.findFirst({ where: { note: { startsWith: notePrefix } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  },

  /**
   * One transaction: lines leaving the batch go back to reserved-and-unbatched,
   * lines joining it take its id, and the header is recounted from what is
   * then attached — so the count can never disagree with the lines.
   */
  setBatchLines(batchId, attach, detach) {
    return prisma.$transaction(async (tx) => {
      if (detach.length) {
        await tx.withdrawalRequest.updateMany({
          where: { id: { in: detach }, batchId },
          data: { batchId: null },
        });
      }
      if (attach.length) {
        await tx.withdrawalRequest.updateMany({
          where: { id: { in: attach } },
          data: { batchId },
        });
      }
      const totals = await tx.withdrawalRequest.aggregate({
        where: { batchId },
        _sum: { netAmount: true },
        _count: { _all: true },
      });
      return tx.payoutBatch.update({
        where: { id: batchId },
        data: { lineCount: totals._count._all, totalNet: totals._sum.netAmount ?? ZERO },
      });
    });
  },

  async recountBatch(batchId) {
    const totals = await prisma.withdrawalRequest.aggregate({
      where: { batchId },
      _sum: { netAmount: true },
      _count: { _all: true },
    });
    return prisma.payoutBatch.update({
      where: { id: batchId },
      data: { lineCount: totals._count._all, totalNet: totals._sum.netAmount ?? ZERO },
    });
  },

  async tallyBatchLines(batchId) {
    const groups = await prisma.withdrawalRequest.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    return groups.map((group) => ({ status: group.status, count: group._count._all }));
  },

  /* ── ADX bank accounts (Lot B, Q85) ──────────────────────────────── */

  listBankAccounts() {
    return prisma.bankAccount.findMany({ orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] });
  },

  findBankAccount(id) {
    return prisma.bankAccount.findUnique({ where: { id } });
  },

  /** One default: making this one the default clears every other in the same transaction. */
  createBankAccount(data) {
    return prisma.$transaction(async (tx) => {
      if (data.isDefault) {
        await tx.bankAccount.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      }
      return tx.bankAccount.create({ data });
    });
  },

  updateBankAccount(id, patch) {
    return prisma.$transaction(async (tx) => {
      if (patch.isDefault) {
        await tx.bankAccount.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
      }
      return tx.bankAccount.update({ where: { id }, data: patch });
    });
  },

  /**
   * The daily cap counts everything raised today that has not been refused —
   * a request already in the queue consumes the allowance, or somebody could
   * raise ten of them before the first is looked at.
   */
  async sumForDay(walletId, dayStart, dayEnd) {
    const result = await prisma.withdrawalRequest.aggregate({
      where: {
        walletId,
        requestedAt: { gte: dayStart, lt: dayEnd },
        status: { notIn: ['REJECTED', 'CANCELLED', 'FAILED'] },
      },
      _sum: { amount: true },
    });
    return result._sum.amount ?? ZERO;
  },

  /* ── Daily accrual ─────────────────────────────────────────────── */

  findAccruableSpots() {
    return prisma.campaignSpot.findMany({
      where: {
        status: { in: ['BOOKED', 'LIVE', 'COMPLETED'] },
        campaign: { status: { in: ['LIVE', 'COMPLETED'] } },
        // Lot A STOP_ACCRUAL: the daily earning skips a suspended listing. A
        // publisher's STOP_ACCRUAL is cascaded onto their listings, so the
        // listing's scopes are the one place to look.
        NOT: { listing: { suspensionScopes: { has: 'STOP_ACCRUAL' } } },
      },
      select: {
        id: true,
        ratePerDay: true,
        quantity: true,
        commissionPct: true,
        commissionSource: true,
        orderId: true,
        campaign: { select: { id: true, startDate: true, endDate: true } },
        listing: { select: { id: true, publisherId: true, title: true, suspensionScopes: true } },
      },
    }) as never;
  },

  async findUnderAccruedSpots() {
    const rows = await prisma.campaignSpot.findMany({
      where: { quantity: { gt: 1 }, earningAccruals: { some: {} } },
      select: {
        id: true,
        ratePerDay: true,
        quantity: true,
        campaignId: true,
        orderId: true,
        listing: {
          select: { id: true, title: true, publisherId: true, publisher: { select: { userId: true } } },
        },
        earningAccruals: {
          select: { id: true, forDate: true, gross: true, commissionRatePct: true, taxRatePct: true },
          orderBy: { forDate: 'asc' },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      ratePerDay: row.ratePerDay,
      quantity: row.quantity,
      campaignId: row.campaignId,
      orderId: row.orderId,
      listing: {
        id: row.listing.id,
        title: row.listing.title,
        publisherId: row.listing.publisherId,
        publisherUserId: row.listing.publisher?.userId ?? null,
      },
      accruals: row.earningAccruals,
    }));
  },

  async findAccruedDates(campaignSpotId) {
    const rows = await prisma.earningAccrual.findMany({
      where: { campaignSpotId },
      select: { forDate: true },
    });
    return rows.map((row) => row.forDate);
  },

  async createAccrual(data) {
    return prisma.earningAccrual.create({ data, select: { id: true } });
  },

  async sumAccruals(publisherId, clearsAfter) {
    const result = await prisma.earningAccrual.aggregate({
      where: {
        publisherId,
        ...(clearsAfter ? { clearsAt: { gt: clearsAfter } } : {}),
      },
      _sum: { gross: true, commission: true, taxWithheld: true, net: true },
      _count: true,
    });
    return {
      gross: result._sum.gross ?? ZERO,
      commission: result._sum.commission ?? ZERO,
      taxWithheld: result._sum.taxWithheld ?? ZERO,
      net: result._sum.net ?? ZERO,
      count: result._count,
    };
  },

  listAccruals(publisherId, limit) {
    return prisma.earningAccrual.findMany({
      where: { publisherId },
      orderBy: { forDate: 'desc' },
      take: limit,
      select: {
        id: true,
        forDate: true,
        gross: true,
        commission: true,
        taxWithheld: true,
        net: true,
        clearsAt: true,
        listing: { select: { id: true, title: true, city: true } },
      },
    }) as never;
  },

  listAccrualsForPeriod(publisherId, from, to) {
    return prisma.earningAccrual.findMany({
      where: { publisherId, forDate: { gte: from, lt: to } },
      orderBy: [{ forDate: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        forDate: true,
        gross: true,
        commission: true,
        taxWithheld: true,
        net: true,
        clearsAt: true,
        listing: { select: { id: true, title: true, city: true } },
      },
    }) as never;
  },

  async publisherIdsWithAccruals(from, to) {
    const rows = await prisma.earningAccrual.findMany({
      where: { forDate: { gte: from, lt: to } },
      distinct: ['publisherId'],
      select: { publisherId: true },
    });
    return rows.map((row) => row.publisherId);
  },

  /* ── Incentives ────────────────────────────────────────────────── */

  findIncentiveRate(event, tier, on, side) {
    // LH2: a rate may be qualified by the lead's side (`GOLD:ADVERTISER`,
    // `*:ADVERTISER`); the side-qualified tier row wins, then the tier, then
    // the side wildcard, then the wildcard — which is the string order.
    const keys = side ? [`${tier}:${side}`, tier, `*:${side}`, '*'] : [tier, '*'];
    return prisma.incentiveRate.findFirst({
      where: {
        event,
        tier: { in: keys },
        effectiveFrom: { lte: on },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: on } }],
      },
      // A tier-specific rate beats the wildcard, and a newer rate beats an older.
      orderBy: [{ tier: 'desc' }, { effectiveFrom: 'desc' }],
    });
  },

  listIncentiveRates() {
    return prisma.incentiveRate.findMany({
      orderBy: [{ event: 'asc' }, { tier: 'asc' }, { effectiveFrom: 'desc' }],
    });
  },

  upsertIncentiveRate(data) {
    return prisma.incentiveRate.create({
      data: {
        event: data.event,
        tier: data.tier,
        amount: data.amount,
        effectiveFrom: data.effectiveFrom,
      },
    });
  },

  async findIncentiveRecipient(agentId) {
    const agent = await prisma.agentProfile.findUnique({ where: { id: agentId }, select: { userId: true } });
    return agent ? { userId: agent.userId } : null;
  },

  createIncentive(data) {
    return prisma.agentIncentive.create({
      data: {
        agentId: data.agentId,
        event: data.event,
        tier: data.tier,
        rateId: data.rateId,
        amount: data.amount,
        taxWithheld: data.taxWithheld,
        taxRatePct: data.taxRatePct,
        netAmount: data.netAmount,
        orderId: data.orderId ?? null,
        publisherId: data.publisherId ?? null,
        advertiserId: data.advertiserId ?? null,
        note: data.note ?? null,
      },
    });
  },

  findIncentive(id) {
    return prisma.agentIncentive.findUnique({ where: { id } });
  },

  findIncentiveFor(event, key) {
    return prisma.agentIncentive.findFirst({
      where: {
        event,
        ...(key.orderId ? { orderId: key.orderId } : {}),
        ...(key.publisherId ? { publisherId: key.publisherId } : {}),
        ...(key.advertiserId ? { advertiserId: key.advertiserId } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  },

  updateIncentive(id, patch) {
    return prisma.agentIncentive.update({ where: { id }, data: patch });
  },

  listIncentives(filter) {
    return prisma.agentIncentive.findMany({
      where: {
        ...(filter.agentId ? { agentId: filter.agentId } : {}),
        ...(filter.orderId ? { orderId: filter.orderId } : {}),
        ...(filter.status?.length ? { status: { in: filter.status } } : {}),
        ...(filter.events?.length ? { event: { in: filter.events } } : {}),
        // E6: the desk's search — the note, the order, or the agent's name.
        ...(filter.q
          ? {
              OR: [
                { note: { contains: filter.q, mode: 'insensitive' } },
                { orderId: { contains: filter.q, mode: 'insensitive' } },
                { agent: { user: { name: { contains: filter.q, mode: 'insensitive' } } } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
    });
  },

  async sumIncentives(agentId, status) {
    const result = await prisma.agentIncentive.aggregate({
      where: { agentId, status },
      _sum: { netAmount: true },
      _count: true,
    });
    return { total: result._sum.netAmount ?? ZERO, count: result._count };
  },

  async countIncentivesByEvent(agentId) {
    const rows = await prisma.agentIncentive.groupBy({
      by: ['event'],
      where: { agentId, status: { in: ['CREDITED', 'PENDING_VERIFICATION'] } },
      _count: { _all: true },
    });
    return rows.map((row) => ({ event: row.event, count: row._count._all }));
  },
};
