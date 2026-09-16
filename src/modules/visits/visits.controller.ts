import type { Request, Response } from 'express';

import { logActivity } from '../../shared/audit';
import { ApiError } from '../../shared/errors';
import {
  adminVisitsQuerySchema,
  completeVisitSchema,
  createVisitSchema,
  myVisitsQuerySchema,
  patchVisitSchema,
  rejectVisitSchema,
  scheduleVisitSchema,
  visitLocationSchema,
} from './visits.schema';
import { getAgentDay } from './day.service';
import {
  acceptVisit,
  completeVisit,
  createVisit,
  getVisit,
  myVisits,
  patchVisit,
  rejectVisit,
  scheduleVisit,
  shareVisitLocation,
  startVisit,
  visitsForAdmin,
} from './visits.service';

const parse = <T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: { flatten: () => unknown } } },
  value: unknown,
): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', result.error!.flatten());
  return result.data as T;
};

const isAdmin = (req: Request) => (req.user?.roles ?? []).includes('ADMIN');
const id = (req: Request) => req.params['visitId'] as string;

export async function myVisitsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await myVisits(req.user!.sub, parse(myVisitsQuerySchema, req.query)) });
}

export async function adminVisitsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await visitsForAdmin(parse(adminVisitsQuerySchema, req.query)) });
}

export async function createVisitHandler(req: Request, res: Response): Promise<void> {
  const body = parse(createVisitSchema, req.body);
  const visit = await createVisit(body, { userId: req.user!.sub, isAdmin: isAdmin(req) });
  if (isAdmin(req)) await logActivity(req.user!.sub, 'VISIT_DISPATCHED', req, { visitId: visit.id });
  res.status(201).json({ success: true, data: visit });
}

export async function getVisitHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getVisit(id(req), req.user!.sub, isAdmin(req)) });
}

export async function acceptVisitHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await acceptVisit(id(req), req.user!.sub) });
}

export async function rejectVisitHandler(req: Request, res: Response): Promise<void> {
  const { reason } = parse(rejectVisitSchema, req.body);
  res.json({ success: true, data: await rejectVisit(id(req), req.user!.sub, reason) });
}

export async function scheduleVisitHandler(req: Request, res: Response): Promise<void> {
  const { scheduledFor } = parse(scheduleVisitSchema, req.body);
  res.json({ success: true, data: await scheduleVisit(id(req), req.user!.sub, new Date(scheduledFor)) });
}

export async function startVisitHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await startVisit(id(req), req.user!.sub) });
}

/**
 * G12-B: POST /visits/:visitId/update-location — the order lane's position
 * ping on a field visit. Answers `{ success: true }` with no `data` key, the
 * way `POST /orders/:id/update-location` does.
 */
export async function visitLocationHandler(req: Request, res: Response): Promise<void> {
  const parsed = visitLocationSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'latitude and longitude required');
  await shareVisitLocation(id(req), req.user!.sub, parsed.data);
  res.json({ success: true });
}

export async function completeVisitHandler(req: Request, res: Response): Promise<void> {
  const { notes } = parse(completeVisitSchema, req.body ?? {});
  res.json({ success: true, data: await completeVisit(id(req), req.user!.sub, notes) });
}

export async function patchVisitHandler(req: Request, res: Response): Promise<void> {
  const body = parse(patchVisitSchema, req.body);
  const visit = await patchVisit(id(req), body);
  await logActivity(req.user!.sub, 'VISIT_UPDATED', req, { visitId: visit.id });
  res.json({ success: true, data: visit });
}

export async function myDayHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getAgentDay(req.user!.sub) });
}
