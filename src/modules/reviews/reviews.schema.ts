import { z } from 'zod';
import { DEFAULT_LIST_PAGE_SIZE, MAX_LIST_PAGE_SIZE, listQuerySchema } from '../../shared/pagination';

/**
 * What a review is on the wire: a whole star from one to five and, when the
 * person has something to say, a line. The note is trimmed and an empty one
 * is dropped, so "   " is no note rather than a blank one.
 */
export const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  note: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((value) => (value ? value : undefined)),
});
/** `note` is optional on the way in; the service reads it as `?? null`. */
export type RateInput = { rating: number; note?: string | undefined };

/**
 * Hiding needs a reason — the database CHECK says so too. Five characters is
 * the floor below which nothing is a sentence, the same floor the listing
 * desk's send-back uses.
 */
export const hideSchema = z.object({
  reason: z.string().trim().min(5, 'Say why this review is being hidden').max(500),
});

export const REVIEW_STATUSES = ['PUBLISHED', 'HIDDEN'] as const;
export const REVIEW_SUBJECTS = ['LISTING', 'AGENT'] as const;

/** The desk's `GET /reviews` — by subject, by status, newest first. */
export const listReviewsQuerySchema = listQuerySchema(REVIEW_STATUSES, ['NEWEST', 'OLDEST']).extend({
  subjectType: z.enum(REVIEW_SUBJECTS).optional(),
  subjectId: z.string().trim().min(1).max(64).optional(),
});
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;

/**
 * E7-2: `GET /agents/me/reviews` — the agent's own stars, on the list
 * contract. PUBLISHED is the only status the agent sees, so the facet has one
 * value and the chip row one chip; `q` searches the note.
 */
export const myAgentReviewsQuerySchema = listQuerySchema(['PUBLISHED'] as const, ['NEWEST', 'OLDEST'] as const);
export type MyAgentReviewsQuery = z.infer<typeof myAgentReviewsQuerySchema>;

/** The public page and the per-agent desk read: a page, nothing else. */
export const reviewPageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_LIST_PAGE_SIZE).default(DEFAULT_LIST_PAGE_SIZE),
});
export type ReviewPageQuery = z.infer<typeof reviewPageQuerySchema>;
