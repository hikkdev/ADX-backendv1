import { prisma } from '../lib/prisma';
import { createNotification } from './notification.service';
import { logger } from '../lib/logger';

export async function autoAssignAgent(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      listing: { include: { publisher: true } },
      agentAssignments: true,
    },
  });
  if (!order) return;

  const rejectedAgentIds = order.agentAssignments
    .filter((a) => a.status === 'REJECTED')
    .map((a) => a.agentId);

  if (order.agentRejectionCount >= 3) {
    await prisma.order.update({ where: { id: orderId }, data: { agentEscalated: true } });
    const admins = await prisma.userRole.findMany({ where: { role: 'ADMIN' }, include: { user: true } });
    await Promise.all(admins.map((ur) =>
      createNotification({
        userId: ur.userId, type: 'ORDER',
        title: 'Order escalated — manual agent assignment needed',
        message: `Order ${orderId.slice(-6).toUpperCase()} rejected by 3 agents.`,
        relatedId: orderId,
      }),
    ));
    logger.warn('Order escalated after 3 rejections', { orderId });
    return;
  }

  // Priority 1: agent who onboarded the publisher
  const publisherAgentId = order.listing.publisher?.agentId;
  let candidateId: string | null = null;

  if (publisherAgentId && !rejectedAgentIds.includes(publisherAgentId)) {
    candidateId = publisherAgentId;
  } else {
    // Priority 2: first active AGENT_PUBLISHER not in rejected list
    const candidate = await prisma.agentProfile.findFirst({
      where: {
        id: { notIn: rejectedAgentIds },
        user: { isActive: true, roles: { some: { role: 'AGENT_PUBLISHER' } } },
      },
    });
    candidateId = candidate?.id ?? null;
  }

  if (!candidateId) {
    logger.warn('No eligible agent for auto-assignment', { orderId });
    return;
  }

  await prisma.orderAgentAssignment.create({ data: { orderId, agentId: candidateId, status: 'PENDING' } });
  await prisma.order.update({ where: { id: orderId }, data: { agentId: candidateId } });

  const agent = await prisma.agentProfile.findUnique({ where: { id: candidateId }, include: { user: true } });
  if (agent?.user) {
    await createNotification({
      userId: agent.user.id, type: 'ORDER',
      title: 'New order assigned',
      message: `Order ${orderId.slice(-6).toUpperCase()} has been assigned to you.`,
      relatedId: orderId,
    });
  }

  logger.info('Agent auto-assigned', { orderId, agentId: candidateId });
}
