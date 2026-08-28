import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import type { MilestoneType } from '../../../shared/database';
import { requireAgentProfile } from '../agents.service';
import {
  createMilestoneTemplateSchema,
  createTrainingResourceSchema,
} from './agent-milestones.schema';
import {
  createMilestoneTemplate,
  createTrainingResource,
  getMilestonesForAgent,
  getTrainingResources,
} from './agent-milestones.service';

export async function getMilestonesHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  const milestones = await getMilestonesForAgent(agent.id);

  // The agent's tier rides along with the board — the UI renders both together.
  res.json({ success: true, data: { tier: agent.tier, milestones } });
}

export async function createMilestoneTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = createMilestoneTemplateSchema.safeParse(req.body);
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
  const parsed = createTrainingResourceSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const resource = await createTrainingResource(parsed.data);
  res.status(201).json({ success: true, data: resource });
}
