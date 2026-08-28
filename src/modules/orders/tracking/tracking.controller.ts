import type { Request, Response } from 'express';
import { ApiError } from '../../../shared/errors';
import { requireAgentProfile } from '../../agents';
import { checkInSchema, locationSchema } from '../orders.schema';
import { agentCheckIn, getAgentLocation, updateAgentLocation } from './tracking.service';

export async function agentCheckInHandler(req: Request, res: Response): Promise<void> {
  const parsed = checkInSchema.safeParse(req.body);
  // Note the terse message with no details payload — this route never returned
  // Zod's flattened issues, unlike the rest of the module.
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'latitude, longitude and qrToken required');
  }

  const agent = await requireAgentProfile(req.user!.sub);
  const result = await agentCheckIn(req.params['id'] as string, agent.id, parsed.data);

  res.json({ success: true, data: result });
}

export async function updateLocationHandler(req: Request, res: Response): Promise<void> {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude required');
  }

  await updateAgentLocation(req.params['id'] as string, parsed.data);

  // Deliberately no `data` key — this endpoint answers `{ success: true }`.
  res.json({ success: true });
}

export async function agentLocationHandler(req: Request, res: Response): Promise<void> {
  const location = await getAgentLocation(req.params['id'] as string);
  res.json({ success: true, data: location });
}
