import type { Request, Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import type { ListingActor } from './listings.service';
import { addBlockedDate, listBlockedDates, removeBlockedDate } from './blocked-dates.service';

/** BD-1: `{ from, to, reason? }` — calendar days, inclusive. */
export const blockedDateSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  reason: z.string().trim().max(200).nullable().optional(),
});

const actorOf = (req: Request): ListingActor => ({ userId: req.user!.sub, isAdmin: (req.user?.roles ?? []).includes('ADMIN') });

/** GET /listings/:listingId/blocked-dates */
export async function listBlockedDatesHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: { blocks: await listBlockedDates(req.params['listingId'] as string, actorOf(req)) } });
}

/** POST /listings/:listingId/blocked-dates — 201 the block; 409 DATES_BOOKED / DATES_BLOCKED. */
export async function addBlockedDateHandler(req: Request, res: Response): Promise<void> {
  const parsed = blockedDateSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());
  const block = await addBlockedDate(req.params['listingId'] as string, parsed.data, actorOf(req));
  res.status(201).json({ success: true, data: block });
}

/** DELETE /listings/:listingId/blocked-dates/:blockId */
export async function removeBlockedDateHandler(req: Request, res: Response): Promise<void> {
  const block = await removeBlockedDate(req.params['listingId'] as string, req.params['blockId'] as string, actorOf(req));
  res.json({ success: true, data: block });
}
