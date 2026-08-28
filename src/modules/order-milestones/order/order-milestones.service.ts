import { ApiError } from '../../../shared/errors';
import { agentExists } from '../../agents';
import { getCategoryPlanId } from '../../app-config';
import { getListingById } from '../../listings';
import { getOrderSummary } from '../../orders';
import { prismaOrderMilestonesRepository as repository } from '../prisma-order-milestones.repository';
import type { OrderMilestonePatch } from '../order-milestones.repository';

/** An order in one of these states is finalised — its milestones are frozen. */
const FINALISED = ['COMPLETED', 'CANCELLED'];

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
  if (FINALISED.includes(milestone.orderRecord.status)) {
    throw new ApiError(400, 'BAD_REQUEST', 'Cannot modify milestones on a finalized order');
  }

  if (patch.assignedAgentId && !(await agentExists(patch.assignedAgentId))) {
    throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');
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
  const autoDispatch =
    patch.assignedAgentId && milestone.status === 'PENDING'
      ? { status: 'DISPATCHED' as const }
      : {};

  return repository.updateMilestone(milestoneId, { ...patch, ...autoDispatch });
}

export async function removeOrderMilestone(milestoneId: string) {
  const milestone = await repository.findWithOrderStatus(milestoneId);
  if (!milestone) throw new ApiError(404, 'NOT_FOUND', 'Milestone not found');
  // Note VERIFICATION is included here but not in FINALISED: an order under
  // verification still accepts edits, just not removals.
  if (['COMPLETED', 'CANCELLED', 'VERIFICATION'].includes(milestone.orderRecord.status)) {
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
 * Currently has no callers; it is wired for a future automatic dispatch step.
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
