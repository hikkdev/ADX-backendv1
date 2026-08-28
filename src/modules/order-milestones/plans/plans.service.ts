import { ApiError } from '../../../shared/errors';
import { prismaOrderMilestonesRepository as repository } from '../prisma-order-milestones.repository';
import type { PlanItemInput } from '../order-milestones.repository';

export async function createMilestonePlan(data: { name: string; description?: string }) {
  return repository.createPlan(data);
}

export async function listMilestonePlans() {
  return repository.listPlans();
}

export async function getMilestonePlan(id: string) {
  const plan = await repository.findPlan(id);
  if (!plan) throw new ApiError(404, 'NOT_FOUND', 'Milestone plan not found');
  return plan;
}

export async function updateMilestonePlan(
  id: string,
  patch: { name?: string; description?: string; isActive?: boolean },
) {
  await getMilestonePlan(id);
  return repository.updatePlan(id, patch);
}

/**
 * Replaces a plan's item list wholesale.
 *
 * Everything is validated before anything is written: duplicate `order` values,
 * unknown templates, and inactive templates are all rejected up front, so a
 * plan is never left half-rebuilt.
 */
export async function replacePlanItems(planId: string, items: PlanItemInput[]) {
  await getMilestonePlan(planId);

  const orders = items.map((i) => i.order);
  if (new Set(orders).size !== orders.length) {
    throw new ApiError(400, 'BAD_REQUEST', 'Duplicate order values are not allowed');
  }

  const templateIds = items.map((i) => i.templateId);
  const templates = await repository.findTemplatesByIds(templateIds);
  if (templates.length !== templateIds.length) {
    throw new ApiError(400, 'BAD_REQUEST', 'One or more templateIds not found');
  }

  const inactive = templates.filter((t) => !t.isActive);
  if (inactive.length > 0) {
    throw new ApiError(
      400,
      'BAD_REQUEST',
      `Inactive templates cannot be added to a plan: ${inactive.map((t) => t.id).join(', ')}`,
    );
  }

  return repository.replacePlanItems(planId, items);
}
