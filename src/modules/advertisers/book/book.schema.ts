import { z } from 'zod';
import { listQuerySchema } from '../../../shared/pagination';

/** The book's chips: All / Active / Pending. An account is active once activated. */
export const BOOK_STATUSES = ['ACTIVE', 'PENDING'] as const;
export type BookStatus = (typeof BOOK_STATUSES)[number];

export const BOOK_SORTS = ['NEWEST', 'NAME', 'SPEND_DESC'] as const;

/** GET /advertisers/mine — the agent's advertiser book, on the list contract. */
export const advertiserBookQuerySchema = listQuerySchema(BOOK_STATUSES, BOOK_SORTS);
export type AdvertiserBookQuery = z.infer<typeof advertiserBookQuerySchema>;

/** "No campaigns in 45 days" — the dormancy line, named once. */
export const DORMANT_AFTER_DAYS = 45;

export const ACCOUNT_ACTIVITY_KINDS = ['CHECK_IN', 'FOLLOW_UP', 'CALLED', 'MESSAGED', 'NOTE'] as const;

export const accountActivitySchema = z.object({
  kind: z.enum(ACCOUNT_ACTIVITY_KINDS),
  note: z.string().trim().min(1).max(1000).optional(),
});
export type AccountActivityInput = z.infer<typeof accountActivitySchema>;

/** GET /advertisers/:id/brands?status= — the third chip is Archived. */
export const brandsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});
