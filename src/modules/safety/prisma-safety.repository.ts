import { prisma } from '../../shared/database';
import type { SafetyRepository } from './safety.repository';

const rowInclude = {
  raisedBy: { select: { id: true, name: true, mobile: true } },
  order: { select: { id: true, status: true, listing: { select: { title: true, address: true, city: true } } } },
} as const;

export const prismaSafetyRepository: SafetyRepository = {
  create(data) {
    return prisma.safetyAlert.create({ data });
  },

  findById(alertId) {
    return prisma.safetyAlert.findUnique({ where: { id: alertId } });
  },

  findManyForUser(userId) {
    return prisma.safetyAlert.findMany({ where: { raisedByUserId: userId }, include: rowInclude, orderBy: { createdAt: 'desc' } });
  },

  findQueue(filter) {
    return prisma.safetyAlert.findMany({
      where: filter.status ? { status: filter.status } : {},
      include: rowInclude,
      // Oldest first, and an open alert is somebody standing somewhere they
      // do not want to be.
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: filter.limit,
      skip: filter.offset,
    });
  },

  update(alertId, patch) {
    return prisma.safetyAlert.update({ where: { id: alertId }, data: patch, include: rowInclude });
  },

  findOrderForActor(orderId) {
    return prisma.order.findUnique({ where: { id: orderId }, select: { id: true, status: true, agentId: true } });
  },

  async releaseOrderFromAgent(orderId) {
    await prisma.order.update({
      where: { id: orderId },
      data: {
        agentId: null,
        status: 'PENDING_AGENT',
        agentTimerExpiry: null,
        slotTime: null,
        slotConfirmedAt: null,
        agentEscalated: true,
      },
    });
  },
};
