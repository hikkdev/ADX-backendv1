import { ApiError } from '../../../shared/errors';
import { prismaOrderMilestonesRepository as repository } from '../prisma-order-milestones.repository';
import type { NewTemplate, TemplatePatch } from '../order-milestones.repository';

export async function createOrderMilestoneTemplate(data: NewTemplate) {
  return repository.createTemplate(data);
}

export async function listOrderMilestoneTemplates(isActive?: boolean) {
  return repository.listTemplates(isActive);
}

export async function getOrderMilestoneTemplate(id: string) {
  const template = await repository.findTemplate(id);
  if (!template) throw new ApiError(404, 'NOT_FOUND', 'Milestone template not found');
  return template;
}

export async function updateOrderMilestoneTemplate(id: string, patch: TemplatePatch) {
  await getOrderMilestoneTemplate(id);
  return repository.updateTemplate(id, patch);
}
