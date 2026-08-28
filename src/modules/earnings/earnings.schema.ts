import { z } from 'zod';

export const transactionsQuerySchema = z.object({
  limit: z.coerce.number().default(50),
  offset: z.coerce.number().default(0),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});
