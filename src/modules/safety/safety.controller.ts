import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { queueQuerySchema, raiseAlertSchema, updateAlertSchema } from './safety.schema';
import { listMine, listQueue, raiseAlert, updateAlert } from './safety.service';
import type { Actor } from './safety.types';

const actorOf = (req: Request): Actor => ({ sub: req.user!.sub, roles: req.user!.roles ?? [] });
const invalid = (error: { flatten(): unknown }) => new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', error.flatten());

// POST /safety/alerts — any signed-in person on a job.
export async function raiseHandler(req: Request, res: Response): Promise<void> {
  const parsed = raiseAlertSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const alert = await raiseAlert(actorOf(req), parsed.data, req);
  res.status(201).json({ success: true, data: alert });
}

export async function mineHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await listMine(actorOf(req)) });
}

export async function queueHandler(req: Request, res: Response): Promise<void> {
  const parsed = queueQuerySchema.safeParse(req.query);
  if (!parsed.success) throw invalid(parsed.error);
  res.json({ success: true, data: await listQueue(parsed.data) });
}

export async function updateHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateAlertSchema.safeParse(req.body);
  if (!parsed.success) throw invalid(parsed.error);
  const alert = await updateAlert(req.params['alertId'] as string, actorOf(req), parsed.data, req);
  res.json({ success: true, data: alert });
}
