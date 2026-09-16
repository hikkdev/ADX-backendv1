import { prisma, Prisma } from '../../../shared/database';

/**
 * What the rating reads. Every query is over rows that already exist — an
 * assignment answered, an order completed, a check-in stamped — so nothing
 * has to be written for a rating to be right.
 */
export interface RatingRepository {
  findAgent(agentId: string): Promise<{ id: string; city: string | null } | null>;
  assignmentTotals(agentId: string, from: Date): Promise<{ accepted: number; completed: number }>;
  arrivals(agentId: string, from: Date): Promise<{ orderId: string; slotTime: Date | null; checkedInAt: Date | null }[]>;
  recentOffers(agentId: string, from: Date): Promise<{ status: string }[]>;
  recentCompletions(agentId: string, from: Date): Promise<{ orderId: string; at: Date; campaignName: string | null }[]>;
  recentRejections(agentId: string, from: Date): Promise<{ orderId: string; at: Date; reason: string | null }[]>;
  saveSnapshot(input: {
    agentId: string;
    city: string | null;
    score: number | null;
    completionRate: number | null;
    onTimeRate: number | null;
    rejectionRate: number | null;
    sample: number;
    computedAt: Date;
  }): Promise<void>;
  /** Every rated agent in the city, for the percentile. */
  cohortScores(city: string): Promise<number[]>;
  /** Lot D (Q112): the publishers' stars as `reviews` last wrote them. */
  reviewSnapshot(agentId: string): Promise<{ reviewAvg: number | null; reviewCount: number }>;
  saveReviewSnapshot(
    agentId: string,
    city: string | null,
    snapshot: { reviewAvg: string | null; reviewCount: number },
  ): Promise<void>;
}

/** The statuses that mean the job was seen through. */
const COMPLETED = ['PENDING_APPROVAL', 'COMPLETED'] as const;

export const prismaRatingRepository: RatingRepository = {
  findAgent(agentId) {
    return prisma.agentProfile.findUnique({ where: { id: agentId }, select: { id: true, city: true } });
  },

  async assignmentTotals(agentId, from) {
    const [accepted, completed] = await Promise.all([
      prisma.orderAgentAssignment.count({ where: { agentId, status: 'ACCEPTED', assignedAt: { gte: from } } }),
      prisma.orderAgentAssignment.count({
        where: { agentId, status: 'ACCEPTED', assignedAt: { gte: from }, order: { status: { in: [...COMPLETED] } } },
      }),
    ]);
    return { accepted, completed };
  },

  async arrivals(agentId, from) {
    const orders = await prisma.order.findMany({
      where: { agentId, slotTime: { not: null }, createdAt: { gte: from } },
      select: { id: true, slotTime: true, checkIn: { select: { checkedInAt: true } } },
    });
    return orders.map((order) => ({ orderId: order.id, slotTime: order.slotTime, checkedInAt: order.checkIn?.checkedInAt ?? null }));
  },

  recentOffers(agentId, from) {
    return prisma.orderAgentAssignment.findMany({
      where: { agentId, assignedAt: { gte: from } },
      select: { status: true },
    });
  },

  async recentCompletions(agentId, from) {
    const orders = await prisma.order.findMany({
      where: { agentId, status: { in: [...COMPLETED] }, updatedAt: { gte: from } },
      select: { id: true, updatedAt: true, campaignName: true },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
    return orders.map((order) => ({ orderId: order.id, at: order.updatedAt, campaignName: order.campaignName }));
  },

  async recentRejections(agentId, from) {
    const rows = await prisma.orderAgentAssignment.findMany({
      where: { agentId, status: 'REJECTED', assignedAt: { gte: from } },
      select: { orderId: true, respondedAt: true, assignedAt: true, rejectionReason: true },
      orderBy: { assignedAt: 'desc' },
      take: 10,
    });
    return rows.map((row) => ({ orderId: row.orderId, at: row.respondedAt ?? row.assignedAt, reason: row.rejectionReason }));
  },

  async saveSnapshot(input) {
    const decimal = (value: number | null) => (value === null ? null : new Prisma.Decimal(value.toFixed(4)));
    const data = {
      city: input.city,
      score: input.score === null ? null : new Prisma.Decimal(input.score.toFixed(2)),
      completionRate: decimal(input.completionRate),
      onTimeRate: decimal(input.onTimeRate),
      rejectionRate: decimal(input.rejectionRate),
      sample: input.sample,
      computedAt: input.computedAt,
    };
    await prisma.agentRating.upsert({
      where: { agentId: input.agentId },
      update: data,
      create: { agentId: input.agentId, ...data },
    });
  },

  async cohortScores(city) {
    const rows = await prisma.agentRating.findMany({ where: { city, score: { not: null } }, select: { score: true } });
    return rows.map((row) => Number(row.score));
  },

  async reviewSnapshot(agentId) {
    const row = await prisma.agentRating.findUnique({
      where: { agentId },
      select: { reviewAvg: true, reviewCount: true },
    });
    return { reviewAvg: row?.reviewAvg === null || row?.reviewAvg === undefined ? null : Number(row.reviewAvg), reviewCount: row?.reviewCount ?? 0 };
  },

  async saveReviewSnapshot(agentId, city, snapshot) {
    // Only the two review columns move: the derived drivers are `saveSnapshot`'s
    // and are left exactly as the last `ratingFor` wrote them.
    const data = {
      reviewAvg: snapshot.reviewAvg === null ? null : new Prisma.Decimal(snapshot.reviewAvg),
      reviewCount: snapshot.reviewCount,
    };
    await prisma.agentRating.upsert({
      where: { agentId },
      update: data,
      create: { agentId, city, ...data },
    });
  },
};
