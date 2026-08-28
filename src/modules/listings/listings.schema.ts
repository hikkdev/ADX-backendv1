import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const LISTING_CATEGORIES = ['INDOOR', 'OUTDOOR', 'TRANSIT', 'MEDIA'] as const;

export const createListingSchema = z.object({
  publisherId: z.string().min(1),
  title: z.string().min(1),
  category: upperEnum(LISTING_CATEGORIES),
  subType: z.string().optional(),
  description: z.string().optional(),
  address: z.string().min(1),
  city: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  size: z.string().optional(),
  monthlyPrice: z.number().positive(),
  pricingModel: z.string().optional(),
  availableNow: z.boolean().optional(),
  photos: z.array(z.object({ url: z.string().url(), type: z.string() })).optional(),
  planId: z.string().optional(),
  // ADMIN-only: create on behalf of a specific agent (identified by their
  // AgentProfile id, e.g. from GET /agents) rather than the caller's own.
  agentId: z.string().optional(),
});

// Deliberately narrower than create: status is NOT patchable here — publishing
// goes through POST /:listingId/publish so the state machine stays in one place.
export const updateListingSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  monthlyPrice: z.number().positive().optional(),
  availableNow: z.boolean().optional(),
});
