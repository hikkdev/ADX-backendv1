import { z } from 'zod';
import { upperEnum } from '../../shared/validation';

export const ADVERTISEMENT_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;

export const createAdvertisementSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  photoUrls: z.array(z.string().url()).max(5).default([]),
  // ADMIN-only: create on behalf of a specific advertiser (the admin panel
  // manages advertisements for advertisers who may not be logged in themselves).
  advertiserId: z.string().optional(),
});

export const updateAdvertisementSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  photoUrls: z.array(z.string().url()).max(5).optional(),
  status: upperEnum(ADVERTISEMENT_STATUSES).optional(),
});

export type CreateAdvertisementInput = z.infer<typeof createAdvertisementSchema>;
export type UpdateAdvertisementInput = z.infer<typeof updateAdvertisementSchema>;
