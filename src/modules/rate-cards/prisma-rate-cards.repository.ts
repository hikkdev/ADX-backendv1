import { Prisma, prisma } from '../../shared/database';
import type { PriceApprovalStatus, RateCardStatus, RateGrade } from '../../shared/database';
import { countsFrom, listArgs } from '../../shared/pagination';
import type {
  ApprovalFilter,
  EntryInput,
  GateSubject,
  ImpactSubject,
  ListingOwner,
  NewPriceApproval,
  NewRateCard,
  PriceApprovalRow,
  RateCardPatch,
  RateCardRow,
  RateCardsRepository,
} from './rate-cards.repository';

const cardSelect = {
  id: true,
  name: true,
  version: true,
  status: true,
  cityId: true,
  effectiveFrom: true,
  effectiveTo: true,
  floorPct: true,
  graceDays: true,
  roundingRupees: true,
  notes: true,
  approvedById: true,
  approvedAt: true,
  submittedById: true,
  submittedAt: true,
  supersedesId: true,
  createdAt: true,
  city: { select: { name: true } },
} as const;

type CardShape = Prisma.RateCardGetPayload<{ select: typeof cardSelect }>;

const toCard = (row: CardShape): RateCardRow => ({
  id: row.id,
  name: row.name,
  version: row.version,
  status: row.status,
  cityId: row.cityId,
  cityName: row.city?.name ?? null,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  floorPct: row.floorPct,
  graceDays: row.graceDays,
  roundingRupees: row.roundingRupees,
  notes: row.notes,
  approvedById: row.approvedById,
  approvedAt: row.approvedAt,
  submittedById: row.submittedById,
  submittedAt: row.submittedAt,
  supersedesId: row.supersedesId,
  createdAt: row.createdAt,
});

const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

/** E10-2: the desk's filter; `withStatus: false` is the histogram's where — the chips count with the status facet removed. */
function approvalWhere(filter: ApprovalFilter, withStatus: boolean): Prisma.PriceApprovalWhereInput {
  return {
    ...(withStatus && filter.status ? { status: filter.status } : {}),
    ...(filter.source ? { source: filter.source } : {}),
    ...(filter.listingId ? { listingId: filter.listingId } : {}),
  };
}

export const prismaRateCardsRepository: RateCardsRepository = {
  async listCards(status?: RateCardStatus) {
    const rows = await prisma.rateCard.findMany({
      where: status ? { status } : {},
      select: cardSelect,
      orderBy: [{ status: 'asc' }, { effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toCard);
  },

  async findCard(id: string) {
    const row = await prisma.rateCard.findUnique({
      where: { id },
      select: {
        ...cardSelect,
        entries: {
          select: {
            id: true,
            mediaTypeId: true,
            grade: true,
            ratePerDay: true,
            mediaType: { select: { name: true } },
          },
          orderBy: [{ mediaType: { name: 'asc' } }, { grade: 'asc' }],
        },
      },
    });
    if (!row) return null;
    return {
      ...toCard(row),
      entries: row.entries.map((entry) => ({
        id: entry.id,
        mediaTypeId: entry.mediaTypeId,
        mediaTypeName: entry.mediaType.name,
        grade: entry.grade,
        ratePerDay: entry.ratePerDay,
      })),
    };
  },

  async createCard(data: NewRateCard) {
    const row = await prisma.rateCard.create({ data, select: cardSelect });
    return toCard(row);
  },

  async updateCard(id: string, patch: RateCardPatch) {
    const row = await prisma.rateCard.update({ where: { id }, data: patch, select: cardSelect });
    return toCard(row);
  },

  async setStatus(id, status, stamps) {
    const row = await prisma.rateCard.update({
      where: { id },
      data: {
        status,
        ...(stamps?.submittedById
          ? { submittedById: stamps.submittedById, submittedAt: new Date() }
          : {}),
        ...(stamps?.approvedById
          ? { approvedById: stamps.approvedById, approvedAt: new Date() }
          : {}),
      },
      select: cardSelect,
    });
    return toCard(row);
  },

  async deleteCard(id: string) {
    await prisma.rateCard.delete({ where: { id } });
  },

  async replaceEntries(rateCardId: string, entries: EntryInput[]) {
    // Replaced wholesale rather than diffed: the grid is edited as a grid, and
    // a partial update would leave a cell nobody meant to keep.
    await prisma.$transaction([
      prisma.rateCardEntry.deleteMany({ where: { rateCardId } }),
      prisma.rateCardEntry.createMany({
        data: entries.map((entry) => ({ ...entry, rateCardId })),
      }),
    ]);
  },

  async highestVersion(name: string) {
    const row = await prisma.rateCard.findFirst({
      where: { name },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return row?.version ?? 0;
  },

  async activeCardsOverlapping(cityId: string | null) {
    const rows = await prisma.rateCard.findMany({
      where: { status: 'ACTIVE', cityId },
      select: cardSelect,
    });
    return rows.map(toCard);
  },

  async effectiveEntry(mediaTypeId, grade, cityId, on) {
    /*
     * City-scoped beats national, which is the whole reason both exist: a
     * national card is a floor of coverage and a city card is a considered
     * local number. Ordering by `cityId` descending puts non-null first in
     * Postgres, so one query answers both.
     */
    const card = await prisma.rateCard.findFirst({
      where: {
        status: 'ACTIVE',
        OR: [{ cityId }, { cityId: null }],
        AND: [
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: on } }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] },
        ],
        entries: { some: { mediaTypeId, grade, ratePerDay: { not: null } } },
      },
      orderBy: [{ cityId: 'desc' }, { effectiveFrom: 'desc' }, { version: 'desc' }],
      select: {
        ...cardSelect,
        entries: {
          where: { mediaTypeId, grade },
          select: {
            id: true,
            mediaTypeId: true,
            grade: true,
            ratePerDay: true,
            mediaType: { select: { name: true } },
          },
        },
      },
    });

    const entry = card?.entries[0];
    if (!card || !entry) return null;

    return {
      card: toCard(card),
      entry: {
        id: entry.id,
        mediaTypeId: entry.mediaTypeId,
        mediaTypeName: entry.mediaType.name,
        grade: entry.grade,
        ratePerDay: entry.ratePerDay,
      },
    };
  },

  findListingOwner(listingId: string): Promise<ListingOwner | null> {
    return prisma.listing.findUnique({
      where: { id: listingId },
      select: { id: true, publisher: { select: { id: true, userId: true, agentId: true } } },
    });
  },

  async findGateSubject(listingId: string): Promise<GateSubject | null> {
    const row = await prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        status: true,
        mediaTypeId: true,
        city: true,
        rateGrade: true,
        ratePerDay: true,
      },
    });
    if (!row) return null;

    // Listings carry a city name rather than a city id; the card is scoped by
    // id, so this is where the two are reconciled.
    const city = row.city
      ? await prisma.city.findFirst({
          where: { name: { equals: row.city, mode: 'insensitive' } },
          select: { id: true },
        })
      : null;

    return {
      id: row.id,
      status: row.status,
      mediaTypeId: row.mediaTypeId,
      cityId: city?.id ?? null,
      city: row.city,
      rateGrade: row.rateGrade,
      ratePerDay: row.ratePerDay,
    };
  },

  async activeListingsPricedBy(rateCardId: string): Promise<ImpactSubject[]> {
    const card = await prisma.rateCard.findUnique({
      where: { id: rateCardId },
      select: {
        cityId: true,
        city: { select: { name: true, aliases: true } },
        entries: { where: { ratePerDay: { not: null } }, select: { mediaTypeId: true } },
      },
    });
    if (!card || card.entries.length === 0) return [];

    // Listings carry a city name; the card is scoped by id. A city card reads
    // every spelling the City row knows, so a listing filed under "Bangalore"
    // is not missed by a card scoped to Bengaluru.
    const names = card.city ? [card.city.name, ...card.city.aliases] : null;
    const rows = await prisma.listing.findMany({
      where: {
        status: 'ACTIVE',
        ratePerDay: { not: null },
        mediaTypeId: { in: [...new Set(card.entries.map((e) => e.mediaTypeId))] },
        ...(names ? { city: { in: names, mode: 'insensitive' } } : {}),
      },
      select: {
        id: true,
        title: true,
        status: true,
        mediaTypeId: true,
        city: true,
        rateGrade: true,
        ratePerDay: true,
        publisherId: true,
        publisher: { select: { userId: true } },
      },
      orderBy: { ratePerDay: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      mediaTypeId: row.mediaTypeId,
      cityId: card.cityId,
      city: row.city,
      rateGrade: row.rateGrade,
      ratePerDay: row.ratePerDay,
      publisherId: row.publisherId,
      publisherUserId: row.publisher?.userId ?? null,
    }));
  },

  async hasNonTerminalOrder(listingId: string) {
    const count = await prisma.order.count({
      where: { listingId, status: { notIn: ['COMPLETED', 'CANCELLED', 'PUBLISHER_REJECTED', 'AGENT_REJECTED'] } },
    });
    return count > 0;
  },

  async countSitesPriced(rateCardId: string) {
    const entries = await prisma.rateCardEntry.findMany({
      where: { rateCardId, ratePerDay: { not: null } },
      select: { mediaTypeId: true },
    });
    if (entries.length === 0) return 0;
    return prisma.listing.count({
      where: { mediaTypeId: { in: [...new Set(entries.map((e) => e.mediaTypeId))] } },
    });
  },

  async listApprovals(filter: ApprovalFilter = {}) {
    const rows = await prisma.priceApproval.findMany({
      where: approvalWhere(filter, true),
      orderBy: { createdAt: 'asc' },
      include: { listing: { select: { title: true } } },
    });
    return rows.map((row) => ({ ...row, listingTitle: row.listing.title }));
  },

  async listApprovalsPage(filter: ApprovalFilter, page: { page: number; pageSize: number }) {
    const where = approvalWhere(filter, true);
    const [rows, total, groups] = await Promise.all([
      prisma.priceApproval.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        ...listArgs(page),
        include: { listing: { select: { title: true } } },
      }),
      prisma.priceApproval.count({ where }),
      prisma.priceApproval.groupBy({ by: ['status'], where: approvalWhere(filter, false), _count: { _all: true } }),
    ]);
    return {
      items: rows.map((row) => ({ ...row, listingTitle: row.listing.title })),
      total,
      counts: countsFrom(groups, APPROVAL_STATUSES),
    };
  },

  async findApproval(id: string) {
    const row = await prisma.priceApproval.findUnique({
      where: { id },
      include: { listing: { select: { title: true } } },
    });
    return row ? { ...row, listingTitle: row.listing.title } : null;
  },

  async findLiveApprovalForListing(listingId: string) {
    const row = await prisma.priceApproval.findFirst({
      where: { listingId, status: { in: ['PENDING', 'APPROVED'] } },
      orderBy: { createdAt: 'desc' },
      include: { listing: { select: { title: true } } },
    });
    return row ? { ...row, listingTitle: row.listing.title } : null;
  },

  async createApproval(data: NewPriceApproval) {
    const row = await prisma.priceApproval.create({
      data: {
        ...data,
        source: data.source ?? 'PUBLISH_REQUEST',
        graceUntil: data.graceUntil ?? null,
      },
      include: { listing: { select: { title: true } } },
    });
    return { ...row, listingTitle: row.listing.title };
  },

  async decideApproval(id, status, decidedById, note) {
    const row = await prisma.priceApproval.update({
      where: { id },
      // A decision ends the hold, whichever way it went.
      data: { status, decidedById, decidedAt: new Date(), decisionNote: note ?? null, heldByRunningOrder: false },
      include: { listing: { select: { title: true } } },
    });
    return { ...row, listingTitle: row.listing.title };
  },

  async holdApproval(id, note) {
    const row = await prisma.priceApproval.update({
      where: { id },
      data: { decisionNote: note, heldByRunningOrder: true },
      include: { listing: { select: { title: true } } },
    });
    return { ...row, listingTitle: row.listing.title };
  },
};

export type { RateGrade };
