import { prisma } from '../../shared/database';
import type {
  NewOrder,
  OrderListFilters,
  OrdersRepository,
  VerificationPatch,
} from './orders.repository';

const withPublisher = { listing: { include: { publisher: true } } } as const;

export const prismaOrdersRepository: OrdersRepository = {
  create(data: NewOrder) {
    return prisma.order.create({
      data: {
        ...data,
        status: 'PENDING_PUBLISHER',
        // The publisher has 30 minutes to respond before the timer job alerts
        // admins. See jobs/publisher-timer.
        publisherTimerExpiry: new Date(Date.now() + 30 * 60 * 1000),
      },
      include: { listing: { include: { publisher: { include: { user: true } } } } },
    });
  },

  findById(orderId: string) {
    return prisma.order.findUnique({ where: { id: orderId } });
  },

  findSummary(orderId: string) {
    return prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, agentId: true, listingId: true },
    });
  },

  findWithPublisher(orderId: string) {
    return prisma.order.findUnique({ where: { id: orderId }, include: withPublisher }) as never;
  },

  findDetail(orderId: string) {
    // The widest read in the codebase. `milestones` belongs to the
    // order-milestones module but is joined here because the detail endpoint
    // returns the whole order aggregate in one response.
    return prisma.order.findUnique({
      where: { id: orderId },
      include: {
        listing: {
          include: {
            publisher: { include: { user: true } },
            agent: { include: { user: true } },
          },
        },
        advertiser: true,
        agent: { include: { user: true } },
        agentAssignments: {
          include: { agent: { include: { user: true } } },
          orderBy: { assignedAt: 'desc' },
        },
        checkIn: true,
        verification: true,
        milestones: { include: { template: true }, orderBy: { order: 'asc' } },
      },
    });
  },

  update(orderId: string, data: Record<string, unknown>) {
    return prisma.order.update({ where: { id: orderId }, data });
  },

  findCompletedExpiredForListing(listingId: string) {
    return prisma.order.findFirst({
      where: { listingId, status: 'COMPLETED', endDate: { lt: new Date() } },
    });
  },

  findPublisherTimerExpired(windowStart: Date, now: Date) {
    return prisma.order.findMany({
      where: {
        status: 'PENDING_PUBLISHER',
        publisherTimerExpiry: { gte: windowStart, lt: now },
      },
      select: { id: true },
    });
  },

  findForAdvertiser(advertiserId: string) {
    return prisma.order.findMany({
      where: { advertiserId },
      include: { listing: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  findForPublisherUser(publisherUserId: string) {
    return prisma.order.findMany({
      where: { listing: { publisher: { userId: publisherUserId } } },
      include: { listing: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  findForAgent(agentProfileId: string) {
    return prisma.order.findMany({
      where: { agentId: agentProfileId },
      include: { listing: { include: { publisher: true } } },
      orderBy: { createdAt: 'desc' },
    });
  },

  findAll({ status, limit = 50, offset = 0 }: OrderListFilters) {
    return prisma.order.findMany({
      where: status ? { status: status as any } : {},
      include: { listing: true, agent: { include: { user: true } } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });
  },

  findAgentLocation(orderId: string) {
    return prisma.order.findUnique({
      where: { id: orderId },
      select: { agentLatitude: true, agentLongitude: true, agentLocationUpdatedAt: true },
    });
  },

  findPendingAssignment(orderId: string, agentId: string) {
    return prisma.orderAgentAssignment.findFirst({
      where: { orderId, agentId, status: 'PENDING' },
    });
  },

  findAssignments(orderId: string) {
    return prisma.orderAgentAssignment.findMany({ where: { orderId } });
  },

  createAssignment(orderId: string, agentId: string) {
    return prisma.orderAgentAssignment.create({ data: { orderId, agentId, status: 'PENDING' } });
  },

  async acceptAssignment(assignmentId: string, orderId: string, agentId: string) {
    // Atomic: an accepted assignment without the order moving to SLOT_PROPOSED
    // would strand the order with no one able to act on it.
    await prisma.$transaction([
      prisma.orderAgentAssignment.update({
        where: { id: assignmentId },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      }),
      prisma.order.update({
        where: { id: orderId },
        data: { status: 'SLOT_PROPOSED', agentId },
      }),
    ]);
  },

  async rejectAssignment(assignmentId: string, orderId: string, reason?: string) {
    await prisma.$transaction([
      prisma.orderAgentAssignment.update({
        where: { id: assignmentId },
        data: { status: 'REJECTED', rejectionReason: reason, respondedAt: new Date() },
      }),
      prisma.order.update({
        where: { id: orderId },
        data: { agentRejectionCount: { increment: 1 } },
      }),
    ]);
  },

  upsertVerification(orderId: string, data: VerificationPatch) {
    return prisma.siteVerification.upsert({
      where: { orderId },
      update: data,
      create: { orderId, ...data },
    });
  },

  upsertCheckIn(orderId: string, data: { latitude: number; longitude: number; distanceM: number }) {
    return prisma.checkIn.upsert({
      where: { orderId },
      create: { orderId, ...data },
      // checkedInAt is refreshed on re-check-in but set by default on create.
      update: { ...data, checkedInAt: new Date() },
    });
  },
};
