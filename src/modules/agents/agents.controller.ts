import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { agentPreferencesSchema, createAgentSchema, listAgentsQuerySchema, updateAgentSchema } from './agents.schema';
import {
  createAgent,
  getAgentDetail,
  getMyPreferences,
  listAgents,
  updateAgent,
  updateMyPreferences,
} from './agents.service';
import { requireAgentProfile } from './agents.service';
import { getAgentDashboard } from './dashboard.service';
import { ratingFor } from './rating/rating.service';

export async function getAllAgentsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listAgentsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());

  const { limit, offset, ...filter } = parsed.data;
  const { items, meta } = await listAgents(filter, limit, offset);

  res.json({ success: true, data: items, meta });
}

export async function createAgentHandler(req: Request, res: Response): Promise<void> {
  const parsed = createAgentSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid agent', parsed.error.flatten());

  const agent = await createAgent(parsed.data);
  res.status(201).json({ success: true, data: agent });
}

export async function getAgentByIdHandler(req: Request, res: Response): Promise<void> {
  const agent = await getAgentDetail(req.params['id'] as string);
  res.json({ success: true, data: agent });
}

/** D5: ops changing the profile — territory, business, preferences, status. */
export async function updateAgentHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateAgentSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid profile', parsed.error.flatten());

  const agent = await updateAgent(req.params['id'] as string, parsed.data);
  res.json({ success: true, data: agent });
}

/** D5: the agent's own DR 07 work preferences. */
export async function getMyPreferencesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyPreferences(req.user!.sub) });
}

export async function updateMyPreferencesHandler(req: Request, res: Response): Promise<void> {
  const parsed = agentPreferencesSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid preferences', parsed.error.flatten());

  res.json({ success: true, data: await updateMyPreferences(req.user!.sub, parsed.data) });
}

/** The signed-in agent's own dashboard header — see dashboard.service.ts. */
/** DR 07 wave 6: the agent's own rating, derived on read. */
export async function getMyRatingHandler(req: Request, res: Response): Promise<void> {
  const agent = await requireAgentProfile(req.user!.sub);
  res.json({ success: true, data: await ratingFor(agent.id) });
}

/** D5: the same rating beside the offer lane on the console's agent page. */
export async function getAgentRatingHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await ratingFor(req.params['id'] as string) });
}

/**
 * `?lat=&lng=` is optional and the pair travels together.
 *
 * With a point the map layer answers "near you" honestly; without one it falls
 * back to the agent's city rather than showing an empty map, because a
 * dashboard that stays blank until location permission is granted teaches
 * people the feature is broken. Half a point is ignored rather than guessed at.
 */
const dashboardQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(1).max(100).default(25),
  })
  .refine((query) => (query.lat === undefined) === (query.lng === undefined), {
    message: 'lat and lng go together',
    path: ['lng'],
  });

export async function getMyDashboardHandler(req: Request, res: Response): Promise<void> {
  const parsed = dashboardQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  const { lat, lng, radiusKm } = parsed.data;
  const view = await getAgentDashboard(
    req.user!.sub,
    new Date(),
    lat !== undefined && lng !== undefined ? { latitude: lat, longitude: lng, radiusKm } : undefined,
  );
  res.json({ success: true, data: view });
}
