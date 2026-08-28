import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { listAgentsQuerySchema } from './agents.schema';
import { getAgentById, listAgents } from './agents.service';

export async function getAllAgentsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listAgentsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const { limit, offset, ...filter } = parsed.data;
  const { items, meta } = await listAgents(filter, limit, offset);

  res.json({ success: true, data: items, meta });
}

export async function getAgentByIdHandler(req: Request, res: Response): Promise<void> {
  const agent = await getAgentById(req.params['id'] as string);
  res.json({ success: true, data: agent });
}
