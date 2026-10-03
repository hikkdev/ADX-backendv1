import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { getMyListings } from './my-listings.service';
import { availabilityQuerySchema, myListingsQuerySchema } from './publishers.schema';
import { getMyDashboard } from './dashboard.service';
import { myAvailability } from './availability.service';

/** GET /publishers/me/dashboard — DR 01's publisher home, computed for now. */
export async function getMyDashboardHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getMyDashboard(req.user!.sub) });
}

/**
 * DR 06 — the publisher's own spots, paged.
 *
 * `/publishers/:publisherId/listings` next door is the agent's read and
 * refuses the publisher themselves; this is theirs, resolved from the session.
 */
export async function getMyListingsHandler(req: Request, res: Response): Promise<void> {
  const parsed = myListingsQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await getMyListings(req.user!.sub, parsed.data) });
}

/** BD-1: GET /publishers/me/availability?from&to — the calendar grid's one read. */
export async function getMyAvailabilityHandler(req: Request, res: Response): Promise<void> {
  const parsed = availabilityQuerySchema.safeParse(req.query);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid query', parsed.error.flatten());
  res.json({ success: true, data: await myAvailability(req.user!.sub, parsed.data) });
}
