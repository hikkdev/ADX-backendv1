import { ApiError } from '../../../shared/errors';
import { agentExists, assertAgentAcceptsWork } from '../../agents';
import { getCategoryPlanId } from '../../app-config';
import { getListingById } from '../../listings';
import { AGENT_RESPONSE_WINDOW_MINUTES, getOrderSummary, notifyAdmins, notifyAgent, shortId } from '../../orders';
import { prismaOrderMilestonesRepository as repository } from '../prisma-order-milestones.repository';
import type { OrderMilestonePatch } from '../order-milestones.repository';

/** An order in one of these states is finalised — its milestones are frozen. */
const FINALISED = ['COMPLETED', 'CANCELLED'];

/**
 * Lot D (Q54/Q92): whether the finalised-order freeze applies to a milestone.
 * A re-install raised by a dispute exists precisely to be worked on an order
 * that has already completed, so those rows — and only those — are exempt.
 */
export const isFrozen = (milestone: { reinstallOfDisputeId: string | null }, orderStatus: string): boolean =>
  FINALISED.includes(orderStatus) && milestone.reinstallOfDisputeId === null;

export async function getOrderMilestones(orderId: string) {
  const order = await getOrderSummary(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  return repository.findForOrder(orderId);
}

export async function addMilestoneToOrder(
  orderId: string,
  data: { templateId: string; order?: number; isOptional?: boolean; dueDate?: Date; notes?: string },
) {
  const order = await getOrderSummary(orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (FINALISED.includes(order.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot add milestones to a finalized order');
  }

  const template = await repository.findTemplate(data.templateId);
  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Milestone template not found');
  if (!template.isActive) throw new ApiError(400, 'BAD_REQUEST', 'Milestone template is not active');

  // Unspecified position appends to the end.
  const milestoneOrder = data.order ?? ((await repository.findLastOrderIndex(orderId)) ?? 0) + 1;

  return repository.createForOrder({
    orderId,
    templateId: data.templateId,
    order: milestoneOrder,
    isOptional: data.isOptional ?? false,
    dueDate: data.dueDate,
    notes: data.notes,
  });
}

export async function updateOrderMilestone(milestoneId: string, patch: OrderMilestonePatch) {
  const milestone = await repository.findWithOrderStatus(milestoneId);
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  if (isFrozen(milestone, milestone.orderRecord.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot modify milestones on a finalized order');
  }

  if (patch.assignedAgentId && !(await agentExists(patch.assignedAgentId))) {
    throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
  }
  // Lot A BLOCK_NEW: a dispatch is new work, so a suspended agent is refused
  // before the milestone is written. Checked only when an agent is named —
  // reordering or renaming a milestone is not a dispatch.
  if (patch.assignedAgentId && patch.status !== 'SKIPPED') {
    await assertAgentAcceptsWork(patch.assignedAgentId);
  }

  if (patch.status === 'SKIPPED') {
    if (!['PENDING', 'DISPATCHED', 'IN_PROGRESS'].includes(milestone.status)) {
      throw new ApiError(
        400,
        'BAD_REQUEST',
        'Only PENDING, DISPATCHED, or IN_PROGRESS milestones can be skipped',
      );
    }
    // SKIPPED takes priority — note assignedAgentId is deliberately dropped, so
    // skipping never also assigns, and no auto-dispatch side-effect applies.
    return repository.updateMilestone(milestoneId, {
      status: 'SKIPPED',
      order: patch.order,
      dueDate: patch.dueDate,
      notes: patch.notes,
    });
  }

  // Assigning an agent to a PENDING milestone dispatches it in the same write.
  // A12: to anyone but the agent already holding the order, that dispatch is an
  // OFFER with the 25-minute window on it; the holder's own is accepted at once.
  const now = new Date();
  const autoDispatch =
    patch.assignedAgentId && milestone.status === 'PENDING'
      ? patch.assignedAgentId === milestone.orderRecord.agentId
        ? { status: 'DISPATCHED' as const, acceptedAt: now, offeredAt: null, offerExpiresAt: null, rejectionReason: null }
        : {
            status: 'DISPATCHED' as const,
            offeredAt: now,
            offerExpiresAt: new Date(now.getTime() + AGENT_RESPONSE_WINDOW_MINUTES * 60 * 1000),
            acceptedAt: null,
            rejectionReason: null,
          }
      : {};

  return repository.updateMilestone(milestoneId, { ...patch, ...autoDispatch });
}

export async function removeOrderMilestone(milestoneId: string) {
  const milestone = await repository.findWithOrderStatus(milestoneId);
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  // Note VERIFICATION is included here but not in FINALISED: an order under
  // verification still accepts edits, just not removals. A re-install is
  // exempt from the freeze here as everywhere else.
  if (milestone.reinstallOfDisputeId === null && ['COMPLETED', 'CANCELLED', 'VERIFICATION'].includes(milestone.orderRecord.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot remove milestones from an order in this state');
  }

  const removed = await repository.deleteIfRemovable(milestoneId);
  if (removed === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Only PENDING or DISPATCHED milestones can be removed');
  }
}

/**
 * Materialises an order's milestones from the listing's plan, or the default
 * plan for its category.
 *
 * Idempotent, and silent about every miss — no plan, no listing, an inactive
 * plan, or milestones already present all simply return. It is a convenience
 * step, never a gate on the order progressing.
 *
 * Called when an agent reads their work queue (`agent/agent-execution.service`),
 * for every live job they hold. Lazily rather than at the accept because the
 * accept lives in `orders`, and `orders` importing this module would close a
 * cycle — this module already reads orders.
 *
 * The milestones are created DISPATCHED and assigned to `order.agentId`, which
 * is why the caller only asks for orders an agent is already holding: issued
 * any earlier they would be dispatched to nobody, and the guard on line above
 * would then stop them ever being issued to the agent who actually turns up.
 */
export async function autoAssignMilestones(orderId: string): Promise<void> {
  const order = await getOrderSummary(orderId);
  if (!order) return;

  if ((await repository.countForOrder(orderId)) > 0) return;

  const listing = await getListingById(order.listingId);

  let planId: string | null = listing?.planId ?? null;
  if (!planId && listing?.category) {
    planId = await getCategoryPlanId(listing.category);
  }
  if (!planId) return;

  const plan = await repository.findPlanWithItems(planId);
  if (!plan || !plan.isActive) return;

  const items = plan.items as { templateId: string; order: number; isOptional: boolean }[];
  await repository.createManyForOrder(
    items.map((item) => ({
      orderId,
      templateId: item.templateId,
      planId: planId as string,
      order: item.order,
      isOptional: item.isOptional,
      assignedAgentId: order.agentId,
    })),
  );
}

/**
 * Lot D (Q54/Q92): the re-install a dispute's REINSTALL resolution raises.
 *
 * An INSTALLATION milestone on the order the case names — from the first
 * active INSTALLATION template, appended after the order's other steps,
 * stamped with the dispute it answers — offered to the agent who did the
 * work by default (they know the site; decision 92) with the same 25-minute
 * window every offer carries, or to the agent ops named. An order that never
 * had an agent (self-install) gets a PENDING visit for ops to dispatch by
 * hand, and the admins are told. The order's own status is not touched: the
 * campaign is what it was; the visit is what changes.
 */
export async function raiseReinstallMilestone(input: {
  orderId: string;
  disputeId: string;
  agentId?: string | null | undefined;
}) {
  const order = await getOrderSummary(input.orderId);
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  const template = await repository.findActiveTemplateByType('INSTALLATION');
  if (!template) {
    throw new ApiError(409, 'CONFLICT', 'No active INSTALLATION milestone template to raise the re-install from');
  }

  const agentId = input.agentId ?? order.agentId ?? null;
  if (agentId) {
    if (!(await agentExists(agentId))) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
    // Lot A BLOCK_NEW: a re-install is new work.
    await assertAgentAcceptsWork(agentId);
  }

  const now = new Date();
  const milestone = await repository.createReinstall({
    orderId: order.id,
    templateId: template.id,
    order: ((await repository.findLastOrderIndex(order.id)) ?? 0) + 1,
    assignedAgentId: agentId,
    reinstallOfDisputeId: input.disputeId,
    notes: `Re-install ordered by dispute ${input.disputeId}`,
    offeredAt: agentId ? now : null,
    offerExpiresAt: agentId ? new Date(now.getTime() + AGENT_RESPONSE_WINDOW_MINUTES * 60 * 1000) : null,
  });

  if (agentId) {
    await notifyAgent(
      agentId,
      'Re-install requested',
      `A dispute on order ${shortId(order.id)} was resolved with a re-install. Accept the visit within 25 minutes.`,
      order.id,
    ).catch(() => undefined);
  } else {
    await notifyAdmins(
      'Re-install needs an agent',
      `A dispute on order ${shortId(order.id)} was resolved with a re-install and the order has no agent to offer it to.`,
      order.id,
    ).catch(() => undefined);
  }
  return milestone;
}

/** The status of each milestone named — what `disputes` reads for "resolved — re-install pending". */
export async function findMilestoneStatuses(milestoneIds: string[]) {
  return repository.findStatuses(milestoneIds);
}
