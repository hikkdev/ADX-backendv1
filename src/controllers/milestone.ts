import type { Request, Response } from 'express';
import { z } from 'zod';
import { upperEnum } from '../lib/zod';
import { ApiError } from '../lib/errors';
import { prisma } from '../lib/prisma';
import {
  getMilestonesForAgent, createMilestoneTemplate,
  getTrainingResources, createTrainingResource,
} from '../services/milestone.service';
import type { MilestoneType } from '../generated/prisma';

export async function getMilestonesHandler(req: Request, res: Response): Promise<void> {
  const userId = req.user!.sub;
  const agent = await prisma.agentProfile.findUnique({ where: { userId } });
  if (!agent) throw new ApiError(404, 'NOT_FOUND', 'Agent profile not found');

  const milestones = await getMilestonesForAgent(agent.id);
  res.json({ success: true, data: { tier: agent.tier, milestones } });
}

export async function createMilestoneTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    type: upperEnum(['ONBOARDING', 'REVENUE', 'ACTIVITY', 'QUALITY'] as const),
    title: z.string().min(1),
    description: z.string().min(1),
    target: z.number().int().positive(),
    rewardAmount: z.number().optional(),
  }).safeParse(req.body);

  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const template = await createMilestoneTemplate({
    ...parsed.data,
    type: parsed.data.type as MilestoneType,
  });
  res.status(201).json({ success: true, data: template });
}

export async function getTrainingHandler(req: Request, res: Response): Promise<void> {
  const resources = await getTrainingResources({
    category: req.query['category'] as string | undefined,
    search: req.query['search'] as string | undefined,
  });
  res.json({ success: true, data: resources });
}

export async function createTrainingHandler(req: Request, res: Response): Promise<void> {
  const parsed = z.object({
    title: z.string().min(1),
    category: z.string().min(1),
    duration: z.string().optional(),
    subtitle: z.string().optional(),
    topic: z.string().optional(),
    status: z.string().optional(),
    statusVariant: z.string().optional(),
    videoUrl: z.string().url().optional(),
    documentUrl: z.string().url().optional(),
  }).safeParse(req.body);

  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const resource = await createTrainingResource(parsed.data);
  res.status(201).json({ success: true, data: resource });
}
