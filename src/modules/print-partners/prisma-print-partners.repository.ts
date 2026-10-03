import { Prisma, prisma } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import { kycRosterStateWhere } from '../../shared/kyc-state';
import { accountStateOf } from '../../shared/party-status';
import { mobileSearchNeedle } from '../../shared/validation';
import type { PrintPartnerAccountState, PrintPartnerRosterStatus, PrintPartnersRepository, QuoteRequestWithQuotes } from './print-partners.repository';
import { PRINT_JOB_STATUSES, PRINT_PARTNER_ACCOUNT_STATES, QUOTE_REQUEST_STATUSES } from './print-partners.repository';

const partnerSelect = {
  id: true,
  name: true,
  contactName: true,
  mobile: true,
  address: true,
  city: true,
  latitude: true,
  longitude: true,
} as const;

const jobInclude = { printPartner: { select: partnerSelect } } as const;

/** 29 Sep 2026: the partners a party import created — the IMPORT door (the rows keep no stamp of their own). */
async function importedPartnerIds(): Promise<string[]> {
  const rows = await prisma.partyImportRow.findMany({
    where: { outcome: 'CREATED', targetId: { not: null }, import: { party: 'PRINT_PARTNER' } },
    select: { targetId: true },
  });
  return rows.flatMap((row) => (row.targetId ? [row.targetId] : []));
}

/** 29 Sep 2026: when a party import created each of these partners — one query for a page; absent when none did. */
async function importedAtFor(ids: readonly string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.partyImportRow.findMany({
    where: { outcome: 'CREATED', targetId: { in: [...ids] }, import: { party: 'PRINT_PARTNER' } },
    select: { targetId: true, import: { select: { committedAt: true, createdAt: true } } },
  });
  return new Map(rows.flatMap((row) => (row.targetId ? [[row.targetId, row.import.committedAt ?? row.import.createdAt] as const] : [])));
}

/**
 * Account lifecycle (2 Oct 2026): the print partners' accounts that are
 * closed, and when. `PrintPartner.userId` carries no relation to its User,
 * so the closure is read beside the roster — the PARTNER accounts with
 * `closedAt` — and both the where-fragments and each row's state read this
 * one set, so a chip count and the pills on the page it filters agree.
 */
async function closedPartnerAccounts(): Promise<Map<string, Date>> {
  const rows = await prisma.user.findMany({
    where: { closedAt: { not: null }, roles: { some: { role: 'PARTNER' } } },
    select: { id: true, closedAt: true },
  });
  return new Map(rows.flatMap((row) => (row.closedAt ? [[row.id, row.closedAt] as const] : [])));
}

/**
 * The print partner's account states as where-fragments, partitioning the
 * table exactly as `accountStateOf({ isActive, closedAt })` reads a row:
 * CLOSED first, then the row's own switch.
 */
export function printPartnerStateWhere(state: PrintPartnerAccountState, closedUserIds: readonly string[]): Prisma.PrintPartnerWhereInput {
  switch (state) {
    case 'CLOSED':
      return { userId: { in: [...closedUserIds] } };
    case 'DEACTIVATED':
      return { isActive: false, userId: { notIn: [...closedUserIds] } };
    case 'ACTIVE':
      return { isActive: true, userId: { notIn: [...closedUserIds] } };
  }
}

/** The roster's status facet: `status` wins; else the older `active=` switch, exactly as it always cut; else nothing. */
function statusFacet(
  status: PrintPartnerRosterStatus | undefined,
  active: boolean | undefined,
  closedUserIds: readonly string[],
): Prisma.PrintPartnerWhereInput[] {
  if (status) return status === 'ALL' ? [] : [printPartnerStateWhere(status, closedUserIds)];
  return active === undefined ? [] : [{ isActive: active }];
}

/* Lot H: what a quote carries of its partner — enough for the award's tie-break and the console row. */
const quotePartnerSelect = {
  id: true,
  displayId: true,
  name: true,
  city: true,
  rateCardUpdatedAt: true,
  rateCardFileId: true,
  rateCardRows: true,
  turnaroundDays: true,
  isActive: true,
} as const;

const quoteInclude = { printPartner: { select: quotePartnerSelect } } as const;
const requestInclude = { quotes: { include: quoteInclude, orderBy: { submittedAt: 'asc' } } } as const;

export const prismaPrintPartnersRepository: PrintPartnersRepository = {
  /* ── Partners ────────────────────────────────────────────────── */

  findUserByMobile(mobile) {
    return prisma.user.findUnique({ where: { mobile }, select: { id: true } });
  },

  async emailTaken(email) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    return Boolean(user);
  },

  createApplication({ userId, appliedAt, ...data }) {
    return prisma.$transaction(async (tx) => {
      await tx.userRole.upsert({ where: { userId_role: { userId, role: 'PARTNER' } }, update: {}, create: { userId, role: 'PARTNER' } });
      return tx.printPartner.create({
        data: {
          displayId: data.displayId,
          userId,
          name: data.name,
          legalName: data.legalName ?? null,
          gstin: data.gstin ?? null,
          panNumber: data.panNumber ?? null,
          contactName: data.contactName ?? null,
          mobile: data.mobile,
          email: data.email ?? null,
          address: data.address ?? null,
          city: data.city ?? null,
          cityId: data.cityId ?? null,
          state: data.state ?? null,
          postalCode: data.postalCode ?? null,
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
          capabilities: data.capabilities ?? [],
          maxWidthFt: data.maxWidthFt ?? null,
          turnaroundDays: data.turnaroundDays ?? null,
          notes: data.notes ?? null,
          appliedAt,
        },
      });
    });
  },

  async findUserRoles(userId: string) {
    const rows = await prisma.userRole.findMany({ where: { userId }, select: { role: true } });
    return rows.map((row) => row.role as string);
  },

  findPartnerByUserId(userId: string) {
    return prisma.printPartner.findUnique({ where: { userId } });
  },

  createPartner(data) {
    // The account is created inactive: a print partner cannot sign in until
    // ops activates the account (Lot H, Q147; before that, owner decision
    // 122 — a payee, never a sign-in). `authenticate` refuses an inactive
    // user, so no token is issued against this row until then.
    // `PrintPartner.userId` is a plain unique column rather than a relation,
    // so the two rows are written in one transaction — a partner without
    // its account is a payee nobody can record a payout method for.
    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          mobile: data.mobile,
          ...(data.userDisplayId ? { displayId: data.userDisplayId } : {}),
          name: data.name,
          email: data.email ?? null,
          isActive: false,
          roles: { create: { role: 'PARTNER' } },
        },
        select: { id: true },
      });
      return tx.printPartner.create({
        data: {
          displayId: data.displayId,
          userId: user.id,
          name: data.name,
          legalName: data.legalName ?? null,
          gstin: data.gstin ?? null,
          panNumber: data.panNumber ?? null,
          contactName: data.contactName ?? null,
          mobile: data.mobile,
          email: data.email ?? null,
          address: data.address ?? null,
          city: data.city ?? null,
          cityId: data.cityId ?? null,
          state: data.state ?? null,
          postalCode: data.postalCode ?? null,
          latitude: data.latitude ?? null,
          longitude: data.longitude ?? null,
          capabilities: data.capabilities ?? [],
          maxWidthFt: data.maxWidthFt ?? null,
          turnaroundDays: data.turnaroundDays ?? null,
          notes: data.notes ?? null,
        },
      });
    });
  },

  findPartner(id) {
    return prisma.printPartner.findUnique({ where: { id } });
  },

  findPartnerByUser(userId) {
    return prisma.printPartner.findUnique({ where: { userId } });
  },

  async findLabelsByIds(ids) {
    if (ids.length === 0) return [];
    const rows = await prisma.printPartner.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, displayId: true } });
    return rows.map((row) => ({ id: row.id, label: row.name, displayId: row.displayId }));
  },

  updatePartner(id, patch) {
    const { rateCardRows, ...rest } = patch;
    return prisma.printPartner.update({
      where: { id },
      data: {
        ...rest,
        ...(rateCardRows === undefined ? {} : { rateCardRows: rateCardRows ?? Prisma.JsonNull }),
      },
    });
  },

  async setUserActive(userId, active) {
    await prisma.user.update({ where: { id: userId }, data: { isActive: active } });
  },

  async listPartners(filter) {
    const q = filter.q?.trim();
    const digits = q ? mobileSearchNeedle(q) : null;
    // 29 Sep 2026: the door — read off what a partner row keeps (see PartnerListFilter).
    const imported = filter.onboardedVia === 'IMPORT' || filter.onboardedVia === 'DESK' ? await importedPartnerIds() : [];
    const door: Prisma.PrintPartnerWhereInput | null =
      filter.onboardedVia === 'SELF'
        ? { appliedAt: { not: null } }
        : filter.onboardedVia === 'IMPORT'
          ? { appliedAt: null, id: { in: imported } }
          : filter.onboardedVia === 'DESK'
            ? { appliedAt: null, id: { notIn: imported } }
            : filter.onboardedVia
              ? { id: { in: [] } }
              : null;
    // Each cut is one AND part, so the city's `OR` and the search's `OR` no longer overwrite each other.
    const parts: Prisma.PrintPartnerWhereInput[] = [
      // PP-1: the applications — self-applied, not yet switched on.
      ...(filter.applied ? [{ appliedAt: { not: null }, activatedAt: null }] : []),
      // Lot X-B: the key is the identity — by the key when the facet resolved
      // to one, the spelling catching only the rows whose key is null.
      ...(filter.city
        ? [
            filter.cityId
              ? { OR: [{ cityId: filter.cityId }, { cityId: null, city: { equals: filter.city, mode: 'insensitive' as const } }] }
              : { cityId: null, city: { equals: filter.city, mode: 'insensitive' as const } },
          ]
        : []),
      ...(q
        ? [
            {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { legalName: { contains: q, mode: 'insensitive' as const } },
                { displayId: { contains: q, mode: 'insensitive' as const } },
                { contactName: { contains: q, mode: 'insensitive' as const } },
                { email: { contains: q, mode: 'insensitive' as const } },
                { mobile: { contains: q } },
                ...(digits ? [{ mobile: { contains: digits } }] : []),
                { city: { contains: q, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
      ...(door ? [door] : []),
      ...(filter.kycState ? [kycRosterStateWhere(filter.kycState, true)] : []),
    ];
    const base: Prisma.PrintPartnerWhereInput = { AND: parts };
    // Account lifecycle (2 Oct 2026): `?status=` beside the older `active=` — status wins when both are sent.
    const closed = await closedPartnerAccounts();
    const closedIds = [...closed.keys()];
    const where: Prisma.PrintPartnerWhereInput = { AND: [base, ...statusFacet(filter.status, filter.active, closedIds)] };
    const [rows, total, active, inactive, perState] = await Promise.all([
      // 29 Sep 2026: the roster's activity — the jobs, counted in the same query.
      prisma.printPartner.findMany({ where, include: { _count: { select: { jobs: true } } }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }], ...listArgs(filter) }),
      prisma.printPartner.count({ where }),
      // The chip counts leave the active facet out, so the row stays a way back out.
      prisma.printPartner.count({ where: { AND: [base, { isActive: true }] } }),
      prisma.printPartner.count({ where: { AND: [base, { isActive: false }] } }),
      // The status chips leave the status facet out the same way, so each stays a way back in.
      Promise.all(
        PRINT_PARTNER_ACCOUNT_STATES.map(async (state) => [state, await prisma.printPartner.count({ where: { AND: [base, printPartnerStateWhere(state, closedIds)] } })] as const),
      ),
    ]);
    const importedAt = await importedAtFor(rows.map((row) => row.id));
    const items = rows.map(({ _count, ...row }) => ({
      ...row,
      jobCount: _count.jobs,
      importedAt: importedAt.get(row.id) ?? null,
      // A print partner has no scoped suspension: closed, else its own switch.
      accountState: accountStateOf({ isActive: row.isActive, closedAt: closed.get(row.userId) ?? null }) as PrintPartnerAccountState,
    }));
    return {
      items,
      total,
      statusCounts: Object.fromEntries(perState) as Record<PrintPartnerAccountState, number>,
      counts: countsFrom(
        [
          { status: 'ACTIVE', _count: { _all: active } },
          { status: 'INACTIVE', _count: { _all: inactive } },
        ],
        ['ACTIVE', 'INACTIVE'],
      ),
    };
  },

  findPartnersInReach(filter) {
    if (filter.partnerIds) {
      return prisma.printPartner.findMany({ where: { id: { in: [...filter.partnerIds] } }, orderBy: { name: 'asc' } });
    }
    return prisma.printPartner.findMany({
      where: {
        isActive: true,
        acceptsQuoteRequests: true,
        OR: [
          // Lot X-L: the key is the identity — keyed partners by key, null-keyed ones by the spelling.
          ...(filter.cityId ? [{ cityId: filter.cityId }] : []),
          ...(filter.city ? [{ ...(filter.cityId ? { cityId: null } : {}), city: { equals: filter.city, mode: 'insensitive' as const } }] : []),
          { AND: [{ latitude: { not: null } }, { longitude: { not: null } }] },
        ],
      },
      orderBy: [{ rateCardUpdatedAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
    });
  },

  listPartnerFiles(userId, purpose, limit) {
    return prisma.uploadedFile.findMany({
      where: { purpose, OR: [{ ownerUserId: userId }, { ownerUserId: null, userId }] },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, url: true, createdAt: true },
    });
  },

  findFilesByIds(ids) {
    if (ids.length === 0) return Promise.resolve([]);
    return prisma.uploadedFile.findMany({
      where: { id: { in: [...ids] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, url: true, createdAt: true },
    });
  },

  findLastLogins(userIds) {
    if (userIds.length === 0) return Promise.resolve([]);
    return prisma.user
      .findMany({ where: { id: { in: [...userIds] } }, select: { id: true, lastLoginAt: true, displayId: true } })
      .then((rows) => rows.map((row) => ({ userId: row.id, lastLoginAt: row.lastLoginAt, displayId: row.displayId })));
  },

  /* ── Jobs ────────────────────────────────────────────────────── */

  createJob(data) {
    return prisma.printJob.create({
      data: {
        orderId: data.orderId,
        printPartnerId: data.printPartnerId,
        quotedCost: data.quotedCost ?? null,
        specs: data.specs ?? Prisma.JsonNull,
        notes: data.notes ?? null,
        awardedQuoteId: data.awardedQuoteId ?? null,
      },
      include: jobInclude,
    });
  },

  findJobByOrder(orderId) {
    return prisma.printJob.findUnique({ where: { orderId }, include: jobInclude });
  },

  findJobsByOrders(orderIds) {
    return prisma.printJob.findMany({ where: { orderId: { in: [...orderIds] } }, include: jobInclude });
  },

  findJob(id) {
    return prisma.printJob.findUnique({ where: { id }, include: jobInclude });
  },

  updateJob(id, patch) {
    const { specs, ...rest } = patch;
    return prisma.printJob.update({
      where: { id },
      data: {
        ...rest,
        ...(specs === undefined ? {} : { specs: specs ?? Prisma.JsonNull }),
      },
      include: jobInclude,
    });
  },

  listJobsForPartner(printPartnerId, limit) {
    return prisma.printJob.findMany({
      where: { printPartnerId },
      orderBy: { requestedAt: 'desc' },
      take: limit,
    });
  },

  async countJobsForPartner(printPartnerId) {
    const groups = await prisma.printJob.groupBy({
      by: ['status'],
      where: { printPartnerId },
      _count: { _all: true },
    });
    return groups.map((group) => ({ status: group.status, count: group._count._all }));
  },

  async listPartnerJobs(printPartnerId, filter) {
    const base: Prisma.PrintJobWhereInput = { printPartnerId, ...(filter.orderId ? { orderId: filter.orderId } : {}) };
    const where: Prisma.PrintJobWhereInput = {
      ...base,
      ...(filter.status?.length ? { status: { in: [...filter.status] } } : {}),
    };
    const [items, total, groups] = await Promise.all([
      prisma.printJob.findMany({ where, orderBy: { requestedAt: 'desc' }, ...listArgs(filter) }),
      prisma.printJob.count({ where }),
      prisma.printJob.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items, total, counts: countsFrom(groups, PRINT_JOB_STATUSES) };
  },

  async findOrderForPrint(orderId) {
    const [order] = await this.findOrdersForPrint([orderId]);
    return order ?? null;
  },

  async findOrdersForPrint(orderIds) {
    if (orderIds.length === 0) return [];
    const orders = await prisma.order.findMany({
      where: { id: { in: [...orderIds] } },
      select: {
        id: true,
        displayId: true,
        status: true,
        campaignName: true,
        designUrl: true,
        startDate: true,
        endDate: true,
        listing: {
          select: { id: true, title: true, address: true, city: true, latitude: true, longitude: true, size: true },
        },
        agent: { select: { id: true, userId: true, user: { select: { name: true, mobile: true } } } },
        campaignSpot: {
          select: {
            id: true,
            campaign: {
              select: {
                creatives: {
                  where: { status: 'APPROVED' },
                  orderBy: { reviewedAt: 'desc' },
                  select: { spotId: true, fileUrl: true, fileName: true, mimeType: true, widthPx: true, heightPx: true },
                },
              },
            },
          },
        },
      },
    });
    return orders.map((order) => {
      const creatives = order.campaignSpot?.campaign.creatives ?? [];
      const creative =
        creatives.find((row) => row.spotId === order.campaignSpot?.id) ?? creatives.find((row) => row.spotId === null) ?? null;
      return {
        id: order.id,
        displayId: order.displayId,
        status: order.status,
        campaignName: order.campaignName,
        designUrl: order.designUrl,
        startDate: order.startDate,
        endDate: order.endDate,
        listing: order.listing,
        agent: order.agent ? { id: order.agent.id, userId: order.agent.userId, name: order.agent.user.name, mobile: order.agent.user.mobile } : null,
        creative: creative
          ? { fileUrl: creative.fileUrl, fileName: creative.fileName, mimeType: creative.mimeType, widthPx: creative.widthPx, heightPx: creative.heightPx }
          : null,
      };
    });
  },

  async orderDisplayIds(orderIds) {
    const ids = [...new Set(orderIds)];
    if (ids.length === 0) return new Map();
    const rows = await prisma.order.findMany({ where: { id: { in: ids } }, select: { id: true, displayId: true } });
    return new Map(rows.map((row) => [row.id, row.displayId]));
  },

  /* ── Quote requests and quotes (Lot H) ───────────────────────── */

  createQuoteRequest(data) {
    return prisma.printQuoteRequest.create({
      data: {
        orderId: data.orderId,
        specs: data.specs,
        city: data.city,
        deadlineAt: data.deadlineAt,
        createdById: data.createdById,
      },
      include: requestInclude,
    });
  },

  findQuoteRequest(id) {
    return prisma.printQuoteRequest.findUnique({ where: { id }, include: requestInclude });
  },

  findLatestQuoteRequestForOrder(orderId) {
    return prisma.printQuoteRequest.findFirst({ where: { orderId }, orderBy: { createdAt: 'desc' }, include: requestInclude });
  },

  updateQuoteRequest(id, patch) {
    return prisma.printQuoteRequest.update({ where: { id }, data: patch, include: requestInclude });
  },

  async listQuoteRequestsForPartner(printPartnerId, filter) {
    // The invite list lives in the envelope (`specs.invitedPartnerIds`) until
    // the schema carries a column for it — see the README's schema note.
    const base: Prisma.PrintQuoteRequestWhereInput = {
      specs: { path: ['invitedPartnerIds'], array_contains: [printPartnerId] },
    };
    const where: Prisma.PrintQuoteRequestWhereInput = {
      ...base,
      ...(filter.status?.length ? { status: { in: [...filter.status] } } : {}),
    };
    const [items, total, groups] = await Promise.all([
      prisma.printQuoteRequest.findMany({ where, orderBy: [{ status: 'asc' }, { deadlineAt: 'desc' }], include: requestInclude, ...listArgs(filter) }),
      prisma.printQuoteRequest.count({ where }),
      prisma.printQuoteRequest.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items: items as QuoteRequestWithQuotes[], total, counts: countsFrom(groups, QUOTE_REQUEST_STATUSES) };
  },

  findOpenRequestsPastDeadline(now) {
    return prisma.printQuoteRequest.findMany({
      where: { status: 'OPEN', deadlineAt: { lt: now } },
      orderBy: { deadlineAt: 'asc' },
      include: requestInclude,
    });
  },

  async listQuoteRequests(filter) {
    const q = filter.q?.trim();
    const base: Prisma.PrintQuoteRequestWhereInput = q
      ? { OR: [{ orderId: { contains: q, mode: 'insensitive' } }, { city: { contains: q, mode: 'insensitive' } }] }
      : {};
    const where: Prisma.PrintQuoteRequestWhereInput = {
      ...base,
      ...(filter.status?.length ? { status: { in: [...filter.status] } } : {}),
    };
    const [items, total, groups] = await Promise.all([
      // OPEN sorts first alphabetically among the four statuses; the nearest deadline first within it.
      prisma.printQuoteRequest.findMany({ where, orderBy: [{ status: 'asc' }, { deadlineAt: 'asc' }], include: requestInclude, ...listArgs(filter) }),
      prisma.printQuoteRequest.count({ where }),
      prisma.printQuoteRequest.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ]);
    return { items: items as QuoteRequestWithQuotes[], total, counts: countsFrom(groups, QUOTE_REQUEST_STATUSES) };
  },

  createQuote(data) {
    return prisma.printQuote.create({ data, include: quoteInclude });
  },

  findQuote(id) {
    return prisma.printQuote.findUnique({ where: { id }, include: quoteInclude });
  },

  updateQuote(id, patch) {
    return prisma.printQuote.update({ where: { id }, data: patch, include: quoteInclude });
  },

  async updateQuotesOnRequest(requestId, exceptQuoteIds, fromStatus, patch) {
    const result = await prisma.printQuote.updateMany({
      where: { requestId, status: fromStatus, id: { notIn: [...exceptQuoteIds] } },
      data: patch,
    });
    return result.count;
  },

  listQuotesForPartner(printPartnerId, limit) {
    return prisma.printQuote.findMany({
      where: { printPartnerId },
      orderBy: { submittedAt: 'desc' },
      take: limit,
      include: { request: { select: { id: true, orderId: true, status: true, deadlineAt: true, awardedQuoteId: true } } },
    });
  },
};
