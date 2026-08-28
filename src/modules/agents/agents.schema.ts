import { z } from 'zod';

export const listAgentsQuerySchema = z.object({
  city: z.string().optional(),
  tier: z.string().optional(),
  search: z.string().optional(), // matches against user name or mobile
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});
