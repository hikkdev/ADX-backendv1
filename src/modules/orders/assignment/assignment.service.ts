import { logger } from '../../../shared/logging';
import { findAssignableAgent, getAgentWithUser } from '../../agents';
import { getListingWithPublisher } from '../../listings';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyAdmins, notifyAgent, shortId } from '../orders.notify';

const MAX_AGENT_REJECTIONS = 3;

/**
 * Picks an agent for an order and offers it to them.
 *
 * Priority 1 is the agent who onboarded the publisher — they already know the
 * site. Priority 2 is any active agent-publisher who has not already rejected
 * this order. After three rejections the order is escalated to admins instead
 * of cycling forever.
 *
 * Deliberately returns rather than throws: it runs fire-and-forget behind
 * print-ready and agent rejection, so a failure must not fail those.
 */
export async function autoAssignAgent(orderId: string) {
  const order = await repository.findById(orderId);
  if (!order) return;

  const assignments = await repository.findAssignments(orderId);
  const rejectedAgentIds = assignments
    .filter((a) => a.status === 'REJECTED')
    .map((a) => a.agentId);

  if (order.agentRejectionCount >= MAX_AGENT_REJECTIONS) {
    await repository.update(orderId, { agentEscalated: true });
    await notifyAdmins(
      'Order escalated — manual agent assignment needed',
      `Order ${shortId(orderId)} rejected by 3 agents.`,
      orderId,
    );
    logger.warn('Order escalated after 3 rejections', { orderId });
    return;
  }

  const listing = await getListingWithPublisher(order.listingId);
  const publisherAgentId = listing?.publisher?.agentId;

  let candidateId: string | null = null;
  if (publisherAgentId && !rejectedAgentIds.includes(publisherAgentId)) {
    candidateId = publisherAgentId;
  } else {
    const candidate = await findAssignableAgent(rejectedAgentIds);
    candidateId = candidate?.id ?? null;
  }

  if (!candidateId) {
    logger.warn('No eligible agent for auto-assignment', { orderId });
    return;
  }

  await repository.createAssignment(orderId, candidateId);
  await repository.update(orderId, { agentId: candidateId });

  const agent = await getAgentWithUser(candidateId);
  if (agent) {
    await notifyAgent(
      candidateId,
      'New order assigned',
      `Order ${shortId(orderId)} has been assigned to you.`,
      orderId,
    );
  }

  logger.info('Agent auto-assigned', { orderId, agentId: candidateId });
}

export async function agentAcceptOrder(orderId: string, agentProfileId: string) {
  const assignment = await repository.findPendingAssignment(orderId, agentProfileId);
  if (!assignment) throw new Error('ASSIGNMENT_NOT_FOUND');

  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');

  await repository.acceptAssignment(assignment.id, orderId, agentProfileId);

  return repository.findById(orderId);
}

export async function agentRejectOrder(
  orderId: string,
  agentProfileId: string,
  reason?: string,
) {
  const assignment = await repository.findPendingAssignment(orderId, agentProfileId);
  if (!assignment) throw new Error('ASSIGNMENT_NOT_FOUND');

  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');

  await repository.rejectAssignment(assignment.id, orderId, reason);

  autoAssignAgent(orderId).catch((err) =>
    logger.error('autoAssignAgent re-assign failed', { orderId, err }),
  );

  return repository.findById(orderId);
}

/** Admin override — clears the escalation flag the auto-assigner may have set. */
export async function adminAssignAgent(orderId: string, agentProfileId: string) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_AGENT') throw new Error('WRONG_STATUS');

  await repository.createAssignment(orderId, agentProfileId);
  await repository.update(orderId, { agentId: agentProfileId, agentEscalated: false });

  await notifyAgent(
    agentProfileId,
    'New order assigned',
    `Order ${shortId(orderId)} has been assigned to you.`,
    orderId,
  ).catch(() => {});

  return repository.findById(orderId);
}
