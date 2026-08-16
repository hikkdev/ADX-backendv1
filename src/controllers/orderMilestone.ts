import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../lib/errors';
import { upperEnum } from '../lib/zod';
import {
  createOrderMilestoneTemplate,
  listOrderMilestoneTemplates,
  getOrderMilestoneTemplate,
  updateOrderMilestoneTemplate,
  type MilestoneRequirement,
  createMilestonePlan,
  listMilestonePlans,
  getMilestonePlan,
  updateMilestonePlan,
  replacePlanItems,
  getOrderMilestones,
  addMilestoneToOrder,
  updateOrderMilestone,
  removeOrderMilestone,
  getAgentMilestones,
  getMilestoneDetail,
  startMilestone,
  completeMilestone,
  type EvidenceInput,
} from '../services/orderMilestone.service';
import type { OrderMilestoneType } from '../generated/prisma';
import { prisma } from '../lib/prisma';

const requirementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('photo'), label: z.string().min(1) }),
  z.object({ kind: z.literal('checklist_item'), label: z.string().min(1) }),
  z.object({ kind: z.literal('qr_scan') }),
  z.object({ kind: z.literal('location_checkin') }),
  z.object({ kind: z.literal('contact_details_visible') }),
]);

const milestoneTypeValues = ['SURVEY', 'CREATIVE_COLLECTION', 'INSTALLATION', 'VERIFICATION', 'HEALTH_CHECK', 'CUSTOM'] as const;

export async function createTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    type: upperEnum(milestoneTypeValues),
    requirements: z.array(requirementSchema).min(1),
    estimatedDurationMins: z.number().int().positive().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const template = await createOrderMilestoneTemplate({
    ...parsed.data,
    type: parsed.data.type as OrderMilestoneType,
  });
  res.status(201).json({ success: true, data: template });
}

export async function listTemplatesHandler(req: Request, res: Response): Promise<void> {
  const isActive = req.query['isActive'] === 'true' ? true : req.query['isActive'] === 'false' ? false : undefined;
  const templates = await listOrderMilestoneTemplates(isActive);
  res.json({ success: true, data: templates });
}

export async function getTemplateHandler(req: Request, res: Response): Promise<void> {
  const template = await getOrderMilestoneTemplate(req.params['id'] as string);
  res.json({ success: true, data: template });
}

export async function updateTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    requirements: z.array(requirementSchema).min(1).optional(),
    estimatedDurationMins: z.number().int().positive().optional(),
    isActive: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { requirements, ...rest } = parsed.data;
  const template = await updateOrderMilestoneTemplate(req.params['id'] as string, {
    ...rest,
    ...(requirements ? { requirements: requirements as MilestoneRequirement[] } : {}),
  });
  res.json({ success: true, data: template });
}

export async function createPlanHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const plan = await createMilestonePlan(parsed.data);
  res.status(201).json({ success: true, data: plan });
}

export async function listPlansHandler(_req: Request, res: Response): Promise<void> {
  const plans = await listMilestonePlans();
  res.json({ success: true, data: plans });
}

export async function getPlanHandler(req: Request, res: Response): Promise<void> {
  const plan = await getMilestonePlan(req.params['id'] as string);
  res.json({ success: true, data: plan });
}

export async function updatePlanHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    isActive: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const plan = await updateMilestonePlan(req.params['id'] as string, parsed.data);
  res.json({ success: true, data: plan });
}

export async function replacePlanItemsHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    items: z.array(z.object({
      templateId: z.string().min(1),
      order: z.number().int().positive(),
      isOptional: z.boolean().optional(),
    })).min(1),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  await replacePlanItems(req.params['id'] as string, parsed.data.items);
  const plan = await getMilestonePlan(req.params['id'] as string);
  res.json({ success: true, data: plan });
}

export async function getOrderMilestonesHandler(req: Request, res: Response): Promise<void> {
  const milestones = await getOrderMilestones(req.params['orderId'] as string);
  res.json({ success: true, data: milestones });
}

export async function addMilestoneToOrderHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    templateId: z.string().min(1),
    order: z.number().int().positive().optional(),
    isOptional: z.boolean().optional(),
    dueDate: z.string().datetime().optional(),
    notes: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { dueDate, ...rest } = parsed.data;
  const milestone = await addMilestoneToOrder(req.params['orderId'] as string, {
    ...rest,
    ...(dueDate ? { dueDate: new Date(dueDate) } : {}),
  });
  res.status(201).json({ success: true, data: milestone });
}

export async function updateOrderMilestoneHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    assignedAgentId: z.string().min(1).optional(),
    order: z.number().int().positive().optional(),
    dueDate: z.string().datetime().nullable().optional(),
    notes: z.string().optional(),
    status: z.literal('SKIPPED').optional(),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const { dueDate, ...rest } = parsed.data;
  const milestone = await updateOrderMilestone(req.params['milestoneId'] as string, {
    ...rest,
    ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(dueDate) : null } : {}),
  });
  res.json({ success: true, data: milestone });
}

export async function removeOrderMilestoneHandler(req: Request, res: Response): Promise<void> {
  await removeOrderMilestone(req.params['milestoneId'] as string);
  res.json({ success: true, data: { message: 'Milestone removed' } });
}

// ─── Agent Execution Handlers ─────────────────────────────────────────────────

export async function getAgentMilestonesHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const milestones = await getAgentMilestones(agent.id);
  res.json({ success: true, data: milestones });
}

export async function getMilestoneDetailHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const milestone = await getMilestoneDetail(req.params['milestoneId'] as string, agent.id);
  res.json({ success: true, data: milestone });
}

export async function startMilestoneHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const milestone = await startMilestone(req.params['milestoneId'] as string, agent.id);
  res.json({ success: true, data: milestone });
}

export async function completeMilestoneHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const parsed = z.object({
    evidence: z.array(z.object({
      kind: z.enum(['photo', 'checklist_item', 'qr_scan', 'location_checkin']),
      label: z.string().max(200).optional(),
      value: z.string().min(1).max(2000),
    })).min(0),
  }).safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const milestone = await completeMilestone(
    req.params['milestoneId'] as string,
    agent.id,
    parsed.data.evidence as EvidenceInput[],
  );
  res.json({ success: true, data: milestone });
}
