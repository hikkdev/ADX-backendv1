import type { Request, Response } from 'express';
import { ApiError } from '../../shared/errors';
import { requireAgentProfile } from '../agents';
import type { ListingCategory } from '../../shared/database';
import { createListingSchema, updateListingSchema } from './listings.schema';
import {
  assertAgentAssignable,
  createListing,
  getAllListings,
  getSimilarListings,
  publishListing,
  updateListing,
} from './listings.service';

export async function createListingHandler(req: Request, res: Response): Promise<void> {
  const parsed = createListingSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  const isAdmin = (req.user?.roles ?? []).includes('ADMIN');
  const { agentId: requestedAgentId, ...rest } = parsed.data;

  const agentId = requestedAgentId
    ? await assertAgentAssignable(requestedAgentId, isAdmin)
    : (await requireAgentProfile(req.user!.sub)).id;

  const listing = await createListing({
    ...rest,
    agentId,
    category: rest.category as ListingCategory,
  });
  res.status(201).json({ success: true, data: listing });
}

export async function getAllListingsHandler(_req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getAllListings() });
}

export async function updateListingHandler(req: Request, res: Response): Promise<void> {
  const parsed = updateListingSchema.safeParse(req.body);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', parsed.error.flatten());

  // No existence check before the write: an unknown id surfaces as Prisma's own
  // error, exactly as before. Adding a 404 here would change the response.
  const listing = await updateListing(req.params['listingId'] as string, parsed.data);
  res.json({ success: true, data: listing });
}

export async function publishListingHandler(req: Request, res: Response): Promise<void> {
  const listing = await publishListing(req.params['listingId'] as string);
  res.json({ success: true, data: listing });
}

export async function similarListingsHandler(req: Request, res: Response): Promise<void> {
  res.json({ success: true, data: await getSimilarListings(req.params['id'] as string) });
}
