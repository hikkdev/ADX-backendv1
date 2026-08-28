import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { requireAgentProfile } from '../agents';
import type { OrderMilestoneType } from '../../shared/database';
import {
  addMilestoneSchema,
  completeMilestoneSchema,
  createPlanSchema,
  createTemplateSchema,
  replacePlanItemsSchema,
  updateMilestoneSchema,
  updatePlanSchema,
  updateTemplateSchema,
} from './order-milestones.schema';
import type { EvidenceInput, MilestoneRequirement } from './order-milestones.types';
import {
  createOrderMilestoneTemplate,
  getOrderMilestoneTemplate,
  listOrderMilestoneTemplates,
  updateOrderMilestoneTemplate,
} from './templates/templates.service';
import {
  createMilestonePlan,
  getMilestonePlan,
  listMilestonePlans,
  replacePlanItems,
  updateMilestonePlan,
} from './plans/plans.service';
import {
  addMilestoneToOrder,
  getOrderMilestones,
  removeOrderMilestone,
  updateOrderMilestone,
} from './order/order-milestones.service';
import {
  completeMilestone,
  getAgentMilestones,
  getMilestoneDetail,
  startMilestone,
} from './agent/agent-execution.service';

// ── Templates ──────────────────────────────────────────────────────────────

export async function createTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = createTemplateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const template = await createOrderMilestoneTemplate({
    ...parsed.data,
    type: parsed.data.type as OrderMilestoneType,
  });
  res.status(201).json({ success: true, data: template });
}

export async function listTemplatesHandler(req: Request, res: Response): Promise<void> {
  // Anything other than the exact strings 'true'/'false' means "no filter".
  const isActive =
    req.query['isActive'] === 'true' ? true : req.query['isActive'] === 'false' ? false : undefined;
  res.json({ success: true, data: await listOrderMilestoneTemplates(isActive) });
}

export async function getTemplateHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getOrderMilestoneTemplate(req.params['id'] as string) });
}

export async function updateTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateTemplateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { requirements, ...rest } = parsed.data;
  const template = await updateOrderMilestoneTemplate(req.params['id'] as string, {
    ...rest,
    ...(requirements ? { requirements: requirements as MilestoneRequirement[] } : {}),
  });
  res.json({ success: true, data: template });
}

// ── Plans ──────────────────────────────────────────────────────────────────

export async function createPlanHandler(req: Request, res: Response): Promise<void> {
  const parsed = createPlanSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const plan = await createMilestonePlan(parsed.data);
  res.status(201).json({ success: true, data: plan });
}

export async function listPlansHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listMilestonePlans() });
}

export async function getPlanHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMilestonePlan(req.params['id'] as string) });
}

export async function updatePlanHandler(req: Request, res: Response): Promise<void> {
  const parsed = updatePlanSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const plan = await updateMilestonePlan(req.params['id'] as string, parsed.data);
  res.json({ success: true, data: plan });
}

export async function replacePlanItemsHandler(req: Request, res: Response): Promise<void> {
  const parsed = replacePlanItemsSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const planId = req.params['id'] as string;
  await replacePlanItems(planId, parsed.data.items);

  // Re-read so the response carries the rebuilt items with their templates.
  res.json({ success: true, data: await getMilestonePlan(planId) });
}

// ── Per-order milestones ───────────────────────────────────────────────────

export async function getOrderMilestonesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getOrderMilestones(req.params['orderId'] as string) });
}

export async function addMilestoneToOrderHandler(req: Request, res: Response): Promise<void> {
  const parsed = addMilestoneSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { dueDate, ...rest } = parsed.data;
  const milestone = await addMilestoneToOrder(req.params['orderId'] as string, {
    ...rest,
    ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
  });
  res.status(201).json({ success: true, data: milestone });
}

export async function updateOrderMilestoneHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateMilestoneSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { dueDate, ...rest } = parsed.data;
  const milestone = await updateOrderMilestone(req.params['milestoneId'] as string, {
    ...rest,
    // null clears the due date; undefined leaves it untouched.
    ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {}),
  });
  res.json({ success: true, data: milestone });
}

export async function removeOrderMilestoneHandler(req: Request, res: Response): Promise<void> {
  await removeOrderMilestone(req.params['milestoneId'] as string);
  res.json({ success: true, data: { message: 'Milestone removed' } });
}

// ── Agent execution ────────────────────────────────────────────────────────

export async function getAgentMilestonesHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  res.json({ success: true, data: await getAgentMilestones(agent.id) });
}

export async function getMilestoneDetailHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const milestone = await getMilestoneDetail(req.params['milestoneId'] as string, agent.id);
  res.json({ success: true, data: milestone });
}

export async function startMilestoneHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const milestone = await startMilestone(req.params['milestoneId'] as string, agent.id);
  res.json({ success: true, data: milestone });
}

export async function completeMilestoneHandler(req: Request, res: Response): Promise<void> {
  // The agent profile is resolved before the body is validated, matching the
  // original ordering.
  const agent = await requireAgentProfile(req.user!.sub);

  const parsed = completeMilestoneSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const milestone = await completeMilestone(
    req.params['milestoneId'] as string,
    agent.id,
    parsed.data.evidence as EvidenceInput[],
  );
  res.json({ success: true, data: milestone });
}
