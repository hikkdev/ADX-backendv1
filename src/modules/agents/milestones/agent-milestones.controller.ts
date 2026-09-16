import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import {
  boardQuerySchema,
  createMilestoneTemplateSchema,
  patchMilestoneTemplateSchema,
} from './agent-milestones.schema';
import {
  claimMilestone,
  createMilestoneTemplate,
  getMilestoneBoard,
  getMilestoneBoardForAgent,
  getMilestoneTemplate,
  listMilestoneTemplates,
  patchMilestoneTemplate,
} from './agent-milestones.service';

/** GET /milestones — the agent's board, with the tier the rank card draws. */
export async function getMilestonesHandler(req: Request, res: Response): Promise<void> {
  const parsed = boardQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await getMilestoneBoard(req.user!.sub, parsed.data.chip) });
}

/** POST /milestones/:milestoneId/claim — the Claim button. */
export async function claimMilestoneHandler(req: Request, res: Response): Promise<void> {
  const result = await claimMilestone(req.params['milestoneId'] as string, req.user!.sub);
  res.status(201).json({ success: true, data: result });
}

/** GET /agents/:id/milestones — the console's read of any agent's board. */
export async function getAgentMilestonesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMilestoneBoardForAgent(req.params['id'] as string) });
}

export async function listMilestoneTemplatesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listMilestoneTemplates() });
}

export async function getMilestoneTemplateHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMilestoneTemplate(req.params['templateId'] as string) });
}

export async function createMilestoneTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = createMilestoneTemplateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.status(201).json({ success: true, data: await createMilestoneTemplate(parsed.data) });
}

export async function patchMilestoneTemplateHandler(req: Request, res: Response): Promise<void> {
  const parsed = patchMilestoneTemplateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  res.json({ success: true, data: await patchMilestoneTemplate(req.params['templateId'] as string, parsed.data) });
}
