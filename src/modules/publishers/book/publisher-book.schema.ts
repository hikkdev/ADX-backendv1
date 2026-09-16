import { z } from 'zod';
import { listQuerySchema } from '../../../shared/pagination';

/** The book's chips: All / Active / Pending. Active has come all the way through onboarding and KYC. */
export const PUBLISHER_BOOK_STATUSES = ['ACTIVE', 'PENDING'] as const;
export const PUBLISHER_BOOK_SORTS = ['NEWEST', 'NAME', 'REVENUE_DESC'] as const;

/** GET /publishers/book — the agent's publisher book, on the list contract. */
export const publisherBookQuerySchema = listQuerySchema(PUBLISHER_BOOK_STATUSES, PUBLISHER_BOOK_SORTS);
export type PublisherBookQuery = z.infer<typeof publisherBookQuerySchema>;

/* ─── R-B: the action log (decision 14, the advertiser's mirror) ────────── */

/** The same five kinds as `POST /advertisers/:id/activity` — `AccountActivityKind`, one enum for both parties. */
export const ACCOUNT_ACTIVITY_KINDS = ['CHECK_IN', 'FOLLOW_UP', 'CALLED', 'MESSAGED', 'NOTE'] as const;

/** POST /publishers/:publisherId/activity — Check in, Follow up, a call, a message, a note. */
export const publisherActivitySchema = z.object({
  kind: z.enum(ACCOUNT_ACTIVITY_KINDS),
  note: z.string().trim().min(1).max(1000).optional(),
});
export type PublisherActivityInput = z.infer<typeof publisherActivitySchema>;

/** GET /publishers/:publisherId/activity — the log on the list contract; `status=` is the kind facet, `q=` reaches the note. */
export const publisherActivityQuerySchema = listQuerySchema(ACCOUNT_ACTIVITY_KINDS, ['NEWEST'] as const);
export type PublisherActivityQuery = z.infer<typeof publisherActivityQuerySchema>;
