import { logger } from '../../../shared/logging';
import { prismaOrdersRepository as repository } from '../prisma-orders.repository';
import { notifyUser, shortId } from '../orders.notify';
import { autoAssignAgent } from '../assignment/assignment.service';

/** Loads an order and checks it is assigned to this agent. */
async function requireAgentOrder(orderId: string, agentProfileId: string) {
  const order = await repository.findById(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.agentId !== agentProfileId) throw new Error('NOT_YOUR_ORDER');
  return order;
}

/**
 * Admin marks prints ready, which forks the flow.
 *
 * A listing the agent cannot install goes to SELF_INSTALL and the publisher is
 * asked to do it; otherwise an agent is auto-assigned.
 */
export async function markPrintReady(orderId: string) {
  const order = await repository.findWithPublisher(orderId);
  if (!order) throw new Error('ORDER_NOT_FOUND');
  if (order.status !== 'PENDING_PRINT') throw new Error('WRONG_STATUS');

  if (!order.listing.agentCanInstall) {
    const updated = await repository.update(orderId, {
      status: 'SELF_INSTALL',
      printReadyAt: new Date(),
    });
    if (order.listing.publisher?.userId) {
      notifyUser(
        order.listing.publisher.userId,
        'Prints ready — please install',
        `Prints for order ${shortId(orderId)} are ready. Please collect and install them yourself.`,
        orderId,
      ).catch(() => {});
    }
    return updated;
  }

  const updated = await repository.update(orderId, {
    status: 'PENDING_AGENT',
    printReadyAt: new Date(),
  });
  autoAssignAgent(orderId).catch((err) => logger.error('autoAssignAgent failed', { orderId, err }));
  return updated;
}

/**
 * Collecting prints starts the installation.
 *
 * Re-collecting once already IN_PROGRESS is a no-op rather than an error: the
 * agent app retries this step on a flaky connection.
 */
export async function agentCollectPrints(
  orderId: string,
  agentProfileId: string,
  _photoUrl: string,
) {
  const order = await requireAgentOrder(orderId, agentProfileId);
  if (order.status === 'IN_PROGRESS') return order;
  if (order.status !== 'SLOT_CONFIRMED') throw new Error('WRONG_STATUS');
  return repository.update(orderId, { status: 'IN_PROGRESS' });
}

/**
 * Site-condition photos.
 *
 * Accepted after the fact too — once the order has moved to OTP, approval or
 * completion the photos are still stored, they just no longer advance anything.
 * That lets an agent correct evidence without reopening the order.
 */
export async function agentCaptureCondition(
  orderId: string,
  agentProfileId: string,
  photoUrls: string[],
) {
  const order = await requireAgentOrder(orderId, agentProfileId);
  const patch = { wideAngleUrl: photoUrls[0], closeUpUrl: photoUrls[1] };

  const pastStatuses = ['PENDING_OTP', 'PENDING_APPROVAL', 'COMPLETED'];
  if (pastStatuses.includes(order.status)) {
    await repository.upsertVerification(orderId, patch);
    return order;
  }

  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');
  await repository.upsertVerification(orderId, patch);
  return order;
}

/**
 * The agent refuses the site. The order goes back to PENDING_AGENT, the agent
 * is detached, and reassignment starts — the rejection also counts toward the
 * three-strike escalation.
 */
export async function agentRejectCondition(
  orderId: string,
  agentProfileId: string,
  _reason: string,
  _photoUrls: string[],
) {
  const order = await requireAgentOrder(orderId, agentProfileId);
  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');

  await repository.update(orderId, {
    status: 'PENDING_AGENT',
    agentId: null,
    agentRejectionCount: { increment: 1 },
  });

  autoAssignAgent(orderId).catch((err) =>
    logger.error('autoAssignAgent R3 re-assign failed', { orderId, err }),
  );

  return repository.findById(orderId);
}

/** Installation photo. Late submissions are stored, same as condition photos. */
export async function agentCaptureInstallation(
  orderId: string,
  agentProfileId: string,
  photoUrl: string,
) {
  const order = await requireAgentOrder(orderId, agentProfileId);

  if (order.status === 'PENDING_OTP' || order.status === 'PENDING_APPROVAL') {
    await repository.upsertVerification(orderId, { landmarkUrl: photoUrl });
    return order;
  }

  if (order.status !== 'IN_PROGRESS') throw new Error('WRONG_STATUS');
  await repository.upsertVerification(orderId, { landmarkUrl: photoUrl });
  return order;
}
