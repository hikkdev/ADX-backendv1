import { prisma, Prisma } from '../../shared/database';
import { money } from '../../shared/money';
import { countsFrom } from '../../shared/pagination';
import type { DisputesRepository } from './disputes.repository';
import { DISPUTE_STATUSES, type DisputePatch, type NewDispute, type QueueFilter } from './disputes.types';

const orderCard = {
  select: {
    id: true,
    status: true,
    campaignName: true,
    listing: { select: { id: true, title: true, address: true, city: true } },
  },
} as const;

/** E6: the queue's facets — the status chips and the search box. */
function queueWhere(filter: Pick<QueueFilter, 'status' | 'q'>): Prisma.DisputeWhereInput {
  const q = filter.q?.trim();
  return {
    ...(filter.status?.length ? { status: { in: filter.status } } : {}),
    ...(q
      ? {
          OR: [
            { displayId: { contains: q, mode: 'insensitive' } },
            { detail: { contains: q, mode: 'insensitive' } },
            { order: { campaignName: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
}

const rowInclude = {
  order: orderCard,
  _count: { select: { messages: true, evidence: true } },
} as const;

const decimalOrNull = (value: string | null | undefined) =>
  value === null || value === undefined ? null : new Prisma.Decimal(value);

const patchData = (data: DisputePatch) => ({
  ...data,
  ...(data.creditedAmount !== undefined ? { creditedAmount: decimalOrNull(data.creditedAmount) } : {}),
});

export const prismaDisputesRepository: DisputesRepository = {
  findManyForUser(userId) {
    return prisma.dispute.findMany({
      where: { OR: [{ raisedByUserId: userId }, { againstUserId: userId }] },
      include: rowInclude,
      orderBy: { updatedAt: 'desc' },
    });
  },

  findById(disputeId) {
    return prisma.dispute.findUnique({
      where: { id: disputeId },
      include: {
        order: orderCard,
        raisedBy: { select: { id: true, name: true } },
        messages: { orderBy: { createdAt: 'asc' } },
        evidence: { orderBy: { uploadedAt: 'asc' } },
      },
    });
  },

  findSummaryById(disputeId) {
    return prisma.dispute.findUnique({ where: { id: disputeId } });
  },

  create(data: NewDispute) {
    return prisma.dispute.create({
      data: { ...data, amountClaimed: decimalOrNull(data.amountClaimed) },
    });
  },

  update(disputeId, data) {
    return prisma.dispute.update({ where: { id: disputeId }, data: patchData(data) });
  },

  async addMessage(data) {
    const [message] = await prisma.$transaction([
      prisma.disputeMessage.create({ data }),
      prisma.dispute.update({ where: { id: data.disputeId }, data: { updatedAt: new Date() } }),
    ]);
    return message;
  },

  async addEvidence(data) {
    const [evidence] = await prisma.$transaction([
      prisma.disputeEvidence.create({ data }),
      prisma.dispute.update({ where: { id: data.disputeId }, data: { updatedAt: new Date() } }),
    ]);
    return evidence;
  },

  findEvidenceByFileId(fileId) {
    return prisma.disputeEvidence.findMany({
      where: { url: { contains: `/files/${fileId}` } },
      select: { disputeId: true, url: true },
    });
  },

  findPartiesByDisputeIds(disputeIds) {
    return prisma.dispute.findMany({
      where: { id: { in: [...disputeIds] } },
      select: { id: true, raisedByUserId: true, againstUserId: true },
    });
  },

  findQueue(filter: QueueFilter) {
    return prisma.dispute.findMany({
      where: queueWhere(filter),
      include: rowInclude,
      // Oldest first: the case that has waited longest is worked first.
      orderBy: { createdAt: 'asc' },
      take: filter.limit,
      skip: filter.offset,
    });
  },

  async countQueue(filter) {
    const [total, groups] = await Promise.all([
      prisma.dispute.count({ where: queueWhere(filter) }),
      prisma.dispute.groupBy({ by: ['status'], where: queueWhere({ q: filter.q }), _count: { _all: true } }),
    ]);
    return { total, counts: countsFrom(groups, DISPUTE_STATUSES) };
  },

  async summary(now) {
    const openStatuses = ['OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE', 'ESCALATED'] as const;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [open, atRisk, slaBreaches, resolved, credited, rejectedThisMonth] = await Promise.all([
      prisma.dispute.count({ where: { status: { in: [...openStatuses] } } }),
      prisma.dispute.aggregate({ where: { status: { in: [...openStatuses] } }, _sum: { amountClaimed: true } }),
      // Lot D (Q91): a paused clock is not a late one.
      prisma.dispute.count({ where: { status: { in: [...openStatuses] }, slaPausedAt: null, slaDueAt: { lt: now } } }),
      prisma.dispute.findMany({
        where: { resolvedAt: { gte: thirtyDaysAgo } },
        select: { createdAt: true, resolvedAt: true },
      }),
      prisma.dispute.aggregate({
        where: { creditStatus: 'RELEASED', creditReleasedAt: { gte: monthStart } },
        _sum: { creditedAmount: true },
      }),
      prisma.dispute.count({ where: { status: 'REJECTED', resolvedAt: { gte: monthStart } } }),
    ]);
    const days = resolved
      .filter((row) => row.resolvedAt)
      .map((row) => (row.resolvedAt!.getTime() - row.createdAt.getTime()) / 86_400_000);
    const avgResolutionDays = days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : 0;
    return {
      open,
      valueAtRisk: money(atRisk._sum.amountClaimed ?? 0),
      slaBreaches,
      avgResolutionDays,
      creditedThisMonth: money(credited._sum.creditedAmount ?? 0),
      rejectedThisMonth,
    };
  },

  async findOrderParties(orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        campaignName: true,
        advertiserId: true,
        listing: { select: { id: true, title: true, publisher: { select: { userId: true } } } },
        agent: { select: { userId: true } },
      },
    });
    if (!order) return null;
    return {
      id: order.id,
      status: order.status,
      campaignName: order.campaignName,
      listingId: order.listing.id,
      listingTitle: order.listing.title,
      advertiserUserId: order.advertiserId,
      publisherUserId: order.listing.publisher?.userId ?? null,
      agentUserId: order.agent?.userId ?? null,
    };
  },

  async partyIdsForUser(userId) {
    const [publisher, advertiser, agent] = await Promise.all([
      prisma.publisher.findUnique({ where: { userId }, select: { id: true } }),
      prisma.advertiser.findUnique({ where: { userId }, select: { id: true } }),
      prisma.agentProfile.findUnique({ where: { userId }, select: { id: true } }),
    ]);
    return { publisherId: publisher?.id ?? null, advertiserId: advertiser?.id ?? null, agentId: agent?.id ?? null };
  },
};
